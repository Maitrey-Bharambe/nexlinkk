'use strict';

// Category: integration (ephemeral MongoDB) with a simulated agent using real Ed25519 keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, login, FakeAgent } = require('./helpers');
const { EnrollmentToken, Device } = require('../src/database/models/device');
const { AuditEvent } = require('../src/database/models/audit');

let ctx;
let op;
let networkId;
test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'op@nx.test', role: 'operator' });
  await createUser(ctx.config, { email: 'viewer@nx.test', role: 'viewer' });
  op = await login(ctx.app, 'op@nx.test');
  networkId = (await op.post('/api/v1/networks', { name: 'enroll-net', cidr: '10.80.0.0/24' })).body.data.id;
});
test.after(() => ctx.teardown());

const newRequest = async (name) => (await op.post('/api/v1/devices/enrollment-requests', { networkId, name })).body.data;

test('enrollment request returns a one-time token that is stored only as a hash', async () => {
  const data = await newRequest('alpha');
  assert.match(data.enrollment.token, /^nxe_/);
  assert.equal(data.device.enrollmentState, 'pending');
  const stored = await EnrollmentToken.findOne({ deviceId: data.device.id }).lean();
  assert.notEqual(stored.tokenHash, data.enrollment.token);
  const audits = await AuditEvent.find({}).lean();
  assert.equal(JSON.stringify(audits).includes(data.enrollment.token), false, 'token never in audit log');
});

test('viewer cannot create enrollment requests', async () => {
  const viewer = await login(ctx.app, 'viewer@nx.test');
  const res = await viewer.post('/api/v1/devices/enrollment-requests', { networkId, name: 'x' });
  assert.equal(res.status, 403);
});

test('agent enrolls with proof of possession and receives a unique address', async () => {
  const a = new FakeAgent(ctx.app);
  const b = new FakeAgent(ctx.app);
  const ra = await a.enroll((await newRequest('a-node')).enrollment.token);
  const rb = await b.enroll((await newRequest('b-node')).enrollment.token);
  assert.equal(ra.status, 201);
  assert.equal(rb.status, 201);
  assert.notEqual(ra.body.data.address, rb.body.data.address);
  assert.match(ra.body.data.address, /^10\.80\.0\.\d+$/);
  const dev = await Device.findById(a.deviceId).lean();
  assert.equal(dev.enrollmentState, 'enrolled');
  assert.match(dev.identityFingerprint, /^SHA256:/);
  assert.ok(await AuditEvent.exists({ operation: 'device.enroll', 'actor.type': 'device', 'target.id': a.deviceId }));
});

test('replayed enrollment token is rejected', async () => {
  const token = (await newRequest('replay')).enrollment.token;
  const a = new FakeAgent(ctx.app);
  assert.equal((await a.enroll(token)).status, 201);
  const attacker = new FakeAgent(ctx.app);
  const res = await attacker.enroll(token);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'ENROLLMENT_TOKEN_USED');
});

test('expired enrollment token is rejected', async () => {
  const data = await newRequest('late');
  await EnrollmentToken.updateOne({ deviceId: data.device.id }, { expiresAt: new Date(Date.now() - 1000) });
  const res = await new FakeAgent(ctx.app).enroll(data.enrollment.token);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'ENROLLMENT_TOKEN_EXPIRED');
});

test('unknown token, bad proof signature and stale timestamp are rejected', async () => {
  const a = new FakeAgent(ctx.app);
  const unknown = await a.enroll(`nxe_${'A'.repeat(43)}`);
  assert.equal(unknown.body.error.code, 'ENROLLMENT_TOKEN_INVALID');

  const token = (await newRequest('proof')).enrollment.token;
  const forged = a.enrollBody(token, { signature: Buffer.alloc(64).toString('base64') });
  const res = await require('supertest')(ctx.app).post('/api/v1/agent/enroll').send(forged);
  assert.equal(res.body.error.code, 'ENROLLMENT_PROOF_INVALID');

  const stale = a.enrollBody(token, { timestamp: Date.now() - 3600_000 });
  const res2 = await require('supertest')(ctx.app).post('/api/v1/agent/enroll').send(stale);
  assert.equal(res2.body.error.code, 'ENROLLMENT_TIMESTAMP_SKEW');
  // The token was not consumed by failed attempts.
  assert.equal((await a.enroll(token)).status, 201);
});

test('duplicate identity cannot enroll twice', async () => {
  const a = new FakeAgent(ctx.app);
  assert.equal((await a.enroll((await newRequest('dup-1')).enrollment.token)).status, 201);
  const res = await a.enroll((await newRequest('dup-2')).enrollment.token);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'DUPLICATE_IDENTITY');
});

test('revoked device is rejected on its next authenticated request', async () => {
  const a = new FakeAgent(ctx.app);
  await a.enroll((await newRequest('revoke-me')).enrollment.token);
  assert.equal((await a.heartbeat()).status, 200);
  assert.equal((await op.post(`/api/v1/devices/${a.deviceId}/revoke`, { reason: 'lost laptop' })).status, 200);
  const res = await a.heartbeat();
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'DEVICE_REVOKED');
  const d = (await op.get(`/api/v1/devices/${a.deviceId}`)).body.data;
  assert.equal(d.health.status, 'revoked');
  assert.equal(d.membership.status, 'revoked');
  assert.ok(await AuditEvent.exists({ operation: 'device.revoke', 'target.id': a.deviceId }));
  assert.ok(await AuditEvent.exists({ operation: 'agent.auth', decision: 'deny', reason: 'device revoked' }));
});
