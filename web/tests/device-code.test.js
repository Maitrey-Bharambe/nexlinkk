'use strict';

// Category: integration (ephemeral MongoDB) + simulated agent with real
// Ed25519/X25519 keys speaking the device-code protocol.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, createUser, login, FakeAgent } = require('./helpers');
const { deviceCodeMessage } = require('../server/modules/enrollment/deviceCode.service');
const { DeviceCode } = require('../server/database/models/deviceCode');

let ctx;
let op;
let viewer;
let network;

test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'dc-op@nx.test', role: 'operator' });
  await createUser(ctx.config, { email: 'dc-viewer@nx.test', role: 'viewer' });
  op = await login(ctx.app, 'dc-op@nx.test');
  viewer = await login(ctx.app, 'dc-viewer@nx.test');
  network = (await op.post('/api/v1/networks', { name: 'dc-lab', cidr: '10.98.0.0/24' })).body.data;
});
test.after(() => ctx.teardown());

function startBody(agent, overrides = {}) {
  const body = {
    identityPublicKey: agent.identityPublicKey,
    wireguardPublicKey: agent.wireguardPublicKey,
    hostname: 'OFFICE-PC',
    agentVersion: '0.3.0-test',
    platform: 'windows',
    timestamp: Date.now(),
    ...overrides,
  };
  return { ...body, signature: agent.sign(deviceCodeMessage(body)), ...(overrides.signature ? { signature: overrides.signature } : {}) };
}

const start = (agent, overrides) => request(ctx.app).post('/api/v1/agent/device-code').send(startBody(agent, overrides));
const poll = (deviceCode) => request(ctx.app).post('/api/v1/agent/device-code/poll').send({ deviceCode });

test('join with a code: start → operator approves → agent polls → enrolled and can heartbeat', async () => {
  const agent = new FakeAgent(ctx.app);
  const s = await start(agent);
  assert.equal(s.status, 201);
  assert.match(s.body.data.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(s.body.data.verificationUrl, /\/activate$/);
  const { userCode, deviceCode } = s.body.data;

  assert.equal((await poll(deviceCode)).body.data.status, 'pending');

  // Codes are accepted however they are typed.
  const look = await op.get(`/api/v1/device-codes/${userCode.toLowerCase().replace('-', ' ')}`);
  assert.equal(look.status, 200);
  assert.equal(look.body.data.hostname, 'OFFICE-PC');
  assert.equal(look.body.data.suggestedName, 'OFFICE-PC');
  assert.match(look.body.data.identityFingerprint, /^SHA256:/);

  const ok = await op.post(`/api/v1/device-codes/${userCode}/approve`, { networkId: network.id, deviceName: 'office-pc' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.device.enrollmentState, 'enrolled');
  assert.match(ok.body.data.device.membership.address, /^10\.98\.0\.\d+$/);

  const done = await poll(deviceCode);
  assert.equal(done.body.data.status, 'approved');
  assert.equal(done.body.data.enrollment.deviceName, 'office-pc');
  assert.equal(done.body.data.enrollment.network.cidr, '10.98.0.0/24');

  // The agent's keys are the device's keys: signed requests work immediately.
  agent.deviceId = done.body.data.enrollment.deviceId;
  assert.equal((await agent.heartbeat()).status, 200);

  // A used code cannot be approved twice.
  assert.equal((await op.post(`/api/v1/device-codes/${userCode}/approve`, { networkId: network.id, deviceName: 'again' })).status, 404);
});

test('approving without a network puts the device in the operator’s first network', async () => {
  const fresh = await createUser(ctx.config, { email: 'dc-new@nx.test', role: 'operator', displayName: 'New Person' });
  const newbie = await login(ctx.app, 'dc-new@nx.test');
  const s = await start(new FakeAgent(ctx.app));
  const ok = await newbie.post(`/api/v1/device-codes/${s.body.data.userCode}/approve`, { deviceName: 'laptop' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.network.name, 'new-person-net');
  assert.ok(fresh);
});

test('denied and expired codes never enroll', async () => {
  const a = await start(new FakeAgent(ctx.app));
  assert.equal((await op.post(`/api/v1/device-codes/${a.body.data.userCode}/deny`)).status, 200);
  assert.equal((await poll(a.body.data.deviceCode)).body.data.status, 'denied');
  assert.equal((await op.get(`/api/v1/device-codes/${a.body.data.userCode}`)).status, 404);

  const b = await start(new FakeAgent(ctx.app));
  await DeviceCode.updateOne({ userCode: b.body.data.userCode.replace('-', '') }, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await poll(b.body.data.deviceCode)).body.data.status, 'expired');
  assert.equal((await op.post(`/api/v1/device-codes/${b.body.data.userCode}/approve`, { networkId: network.id, deviceName: 'late' })).status, 404);
});

test('a code needs proof of key possession, a sane clock and unused keys', async () => {
  const agent = new FakeAgent(ctx.app);
  assert.equal((await start(agent, { signature: new FakeAgent(ctx.app).sign('nope') })).status, 401);
  assert.equal((await start(agent, { timestamp: Date.now() - 3600_000 })).status, 401);
  assert.equal((await poll('nxd_' + 'A'.repeat(43))).status, 401);

  // Keys that are already enrolled cannot ask for another code.
  const s = await start(agent);
  await op.post(`/api/v1/device-codes/${s.body.data.userCode}/approve`, { networkId: network.id, deviceName: 'once' });
  assert.equal((await start(agent)).status, 409);
});

test('viewers cannot look up or approve codes', async () => {
  const s = await start(new FakeAgent(ctx.app));
  assert.equal((await viewer.get(`/api/v1/device-codes/${s.body.data.userCode}`)).status, 403);
  assert.equal((await viewer.post(`/api/v1/device-codes/${s.body.data.userCode}/approve`, { networkId: network.id, deviceName: 'x1' })).status, 403);
});
