'use strict';

// Category: integration (ephemeral MongoDB) + simulated agents with real keys.
// Covers the device page's "agent console" and "run on this device" actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, login, networkWithAgents } = require('./helpers');
const { AuditEvent } = require('../src/database/models/audit');

let ctx;
let op;
let viewer;
let net;
test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'op@nx.test', role: 'operator' });
  await createUser(ctx.config, { email: 'viewer@nx.test', role: 'viewer' });
  op = await login(ctx.app, 'op@nx.test');
  net = await networkWithAgents(ctx.app, op, { cidr: '10.66.0.0/24', count: 2 });
  await op.post(`/api/v1/networks/${net.networkId}/collaborators`, { email: 'viewer@nx.test', role: 'viewer' });
  viewer = await login(ctx.app, 'viewer@nx.test');
});
test.after(() => ctx.teardown());

const events = (agent, list) =>
  agent.signed('POST', '/api/v1/agent/events', { schemaVersion: 1, deviceId: agent.deviceId, events: list });

test('agent log events appear in the device activity feed, secrets redacted', async () => {
  const [a] = net.agents;
  const now = new Date().toISOString();
  const res = await events(a, [
    { at: now, level: 'info', message: 'agent starting', fields: { interface: 'nexlink0', privileged: false } },
    { at: now, level: 'warn', message: 'heartbeat failed', fields: { err: 'timeout', api_token: 'nxe_should_not_show' } },
  ]);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.accepted, 2);

  const feed = (await viewer.get(`/api/v1/devices/${a.deviceId}/activity`)).body.data;
  assert.equal(feed.events.length, 2);
  const warn = feed.events.find((e) => e.level === 'warn');
  assert.equal(warn.fields.api_token, '[redacted]');
  assert.equal(JSON.stringify(feed).includes('nxe_should_not_show'), false);
});

test('a device cannot post events for another device; bad events are rejected', async () => {
  const [a, b] = net.agents;
  const spoof = await a.signed('POST', '/api/v1/agent/events', {
    schemaVersion: 1,
    deviceId: b.deviceId,
    events: [{ at: new Date().toISOString(), level: 'info', message: 'x', fields: {} }],
  });
  assert.equal(spoof.status, 400);
  const tooMany = await events(a, [{ at: new Date().toISOString(), level: 'info', message: 'x', fields: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i])) }]);
  assert.equal(tooMany.status, 400);
  const badLevel = await events(a, [{ at: new Date().toISOString(), level: 'fatal', message: 'x', fields: {} }]);
  assert.equal(badLevel.status, 400);
});

test('run-on-this-device: request → approve → agent executes → verified, no incident needed', async () => {
  const [a] = net.agents;
  await a.heartbeat(); // online, with telemetry + connectivity_probe + wireguard_inspect

  assert.equal((await viewer.post(`/api/v1/devices/${a.deviceId}/actions`, { actionType: 'request_peer_status_report' })).status, 403);
  assert.equal((await op.post(`/api/v1/devices/${a.deviceId}/actions`, { actionType: 'run_shell' })).status, 400);

  const req = await op.post(`/api/v1/devices/${a.deviceId}/actions`, { actionType: 'request_peer_status_report', params: {} });
  assert.equal(req.status, 201);
  assert.equal(req.body.data.status, 'awaiting_approval');
  assert.equal(req.body.data.incidentId, null);
  assert.equal(req.body.data.proposedBy.type, 'user');
  assert.ok(await AuditEvent.exists({ operation: 'action.request', decision: 'allow' }));

  const approved = await op.post(`/api/v1/actions/${req.body.data.id}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.status, 'queued');

  const [cmd] = (await a.signed('GET', '/api/v1/agent/commands')).body.data;
  assert.equal(cmd.type, 'report_peer_status');
  await a.telemetry({ state: 'up' });
  const now = new Date().toISOString();
  const done = await a.signed('POST', `/api/v1/agent/commands/${cmd.id}/result`, { status: 'succeeded', startedAt: now, finishedAt: now, output: {}, measurements: [] });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.verification.outcome, 'successful');

  const list = (await op.get(`/api/v1/devices/${a.deviceId}/actions`)).body.data;
  assert.equal(list[0].status, 'completed');
  const feed = (await op.get(`/api/v1/devices/${a.deviceId}/activity`)).body.data;
  assert.equal(feed.commands[0].status, 'succeeded');
});

test('device-page requests still go through the policy engine', async () => {
  const [a] = net.agents;
  await a.heartbeat();
  // Agent is in safe mode (no wireguard_apply) → refused, with the reason shown.
  const res = await op.post(`/api/v1/devices/${a.deviceId}/actions`, { actionType: 'request_vpn_config_refresh' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'rejected_by_policy');
  assert.match(res.body.data.validation.reasons.join(' '), /PRECONDITION_CAPABILITY/);
  const peer = await op.post(`/api/v1/devices/${a.deviceId}/actions`, { actionType: 'run_connectivity_test', params: { target: 'peer', count: 3 } });
  assert.equal(peer.body.data.status, 'rejected_by_policy', 'peer target without peerDeviceId is invalid');
});
