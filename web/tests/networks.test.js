'use strict';

// Category: integration against a real (ephemeral) MongoDB, in-process HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, login, FakeAgent } = require('./helpers');
const { Network, Membership } = require('../src/database/models/network');
const { allocateMembership } = require('../src/modules/networks/networks.service');
const mongoose = require('mongoose');

let ctx;
let admin;
let op;
let op2;
test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'admin@nx.test', role: 'admin' });
  await createUser(ctx.config, { email: 'op@nx.test', role: 'operator' });
  await createUser(ctx.config, { email: 'op2@nx.test', role: 'operator' });
  admin = await login(ctx.app, 'admin@nx.test');
  op = await login(ctx.app, 'op@nx.test');
  op2 = await login(ctx.app, 'op2@nx.test');
});
test.after(() => ctx.teardown());

test('operator creates and inspects a network; status reflects no observations', async () => {
  const res = await op.post('/api/v1/networks', { name: 'home-lab', cidr: '10.50.0.0/24' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.cidr, '10.50.0.0/24');
  assert.equal(res.body.data.usableHosts, 253);
  const detail = await op.get(`/api/v1/networks/${res.body.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.summary.observedStatus, 'configured', 'no tunnel claimed without evidence');
  assert.deepEqual(detail.body.data.devices, []);
});

test('invalid CIDRs are rejected with specific codes', async () => {
  for (const [cidr, code] of [
    ['10.51.0.7/24', 'CIDR_NOT_ALIGNED'],
    ['1.1.1.0/24', 'CIDR_NOT_PRIVATE'],
    ['10.0.0.0/8', 'CIDR_PREFIX_OUT_OF_RANGE'],
    ['garbage', 'CIDR_INVALID'],
  ]) {
    const res = await op.post('/api/v1/networks', { name: `n-${code}`, cidr });
    assert.equal(res.status, 400, cidr);
    assert.equal(res.body.error.code, code);
  }
});

test('overlapping subnets are rejected across owners', async () => {
  const res = await op2.post('/api/v1/networks', { name: 'clash', cidr: '10.50.0.128/25' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'CIDR_OVERLAP');
  const sup = await op2.post('/api/v1/networks', { name: 'super', cidr: '10.50.0.0/16' });
  assert.equal(sup.status, 409);
  const ok = await op2.post('/api/v1/networks', { name: 'adjacent', cidr: '10.50.1.0/24' });
  assert.equal(ok.status, 201);
});

test('concurrent overlapping creates leave exactly one network', async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => admin.post('/api/v1/networks', { name: `race-${i}`, cidr: '10.60.0.0/24' })),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(await Network.countDocuments({ cidr: '10.60.0.0/24', status: 'active' }), 1);
});

test('operators cannot see or delete networks outside their scope (404)', async () => {
  const mine = (await op.get('/api/v1/networks')).body.data;
  const other = (await op2.get('/api/v1/networks')).body.data;
  assert.ok(mine.every((n) => n.name !== 'adjacent'));
  const id = other.find((n) => n.name === 'adjacent').id;
  assert.equal((await op.get(`/api/v1/networks/${id}`)).status, 404);
  assert.equal((await op.del(`/api/v1/networks/${id}`)).status, 404);
  assert.equal((await admin.get(`/api/v1/networks/${id}`)).status, 200, 'admin sees all');
});

test('database-level uniqueness prevents duplicate address allocation', async () => {
  const net = await Network.findOne({ name: 'home-lab' });
  const ids = Array.from({ length: 8 }, () => new mongoose.Types.ObjectId());
  const memberships = await Promise.all(ids.map((deviceId) => allocateMembership({ network: net, deviceId })));
  const addrs = memberships.map((m) => m.address);
  assert.equal(new Set(addrs).size, addrs.length, 'all distinct');
  assert.ok(!addrs.includes('10.50.0.0') && !addrs.includes('10.50.0.1') && !addrs.includes('10.50.0.255'));
  await assert.rejects(
    Membership.create({ networkId: net._id, deviceId: new mongoose.Types.ObjectId(), address: addrs[0], addressInt: memberships[0].addressInt }),
    (e) => e.code === 11000,
  );
  await Membership.deleteMany({ networkId: net._id });
});

test('address pool exhaustion is reported, not wrapped', async () => {
  const res = await admin.post('/api/v1/networks', { name: 'tiny', cidr: '192.168.99.0/29' });
  const net = await Network.findById(res.body.data.id);
  for (let i = 0; i < 5; i++) await allocateMembership({ network: net, deviceId: new mongoose.Types.ObjectId() });
  await assert.rejects(allocateMembership({ network: net, deviceId: new mongoose.Types.ObjectId() }), (e) => e.code === 'ADDRESS_POOL_EXHAUSTED');
});

test('network deletion is refused while devices are active, allowed once empty', async () => {
  const net = await op.post('/api/v1/networks', { name: 'deleteme', cidr: '10.70.0.0/24' });
  const er = await op.post('/api/v1/devices/enrollment-requests', { networkId: net.body.data.id, name: 'box' });
  const a = new FakeAgent(ctx.app);
  assert.equal((await a.enroll(er.body.data.enrollment.token)).status, 201);
  const blocked = await op.del(`/api/v1/networks/${net.body.data.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'NETWORK_NOT_EMPTY');
  assert.equal((await op.post(`/api/v1/devices/${a.deviceId}/revoke`, { reason: 'decommission' })).status, 200);
  const ok = await op.del(`/api/v1/networks/${net.body.data.id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'deleted');
});
