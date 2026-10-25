'use strict';

// Category: integration (ephemeral MongoDB) + simulated agents with real keys.
// The "test data flow" action: real bytes through the tunnel, verified by the
// peer's checksum, gated by both ends' capabilities, and visible to the AI.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, login, networkWithAgents } = require('./helpers');
const { Device } = require('../server/database/models/device');
const { collectEvidence } = require('../server/modules/diagnostics/tools');

let ctx;
let op;
let net;
const CAPS = ['telemetry', 'connectivity_probe', 'wireguard_inspect', 'remote_session', 'transfer_test'];

test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'op@nx.test', role: 'operator' });
  op = await login(ctx.app, 'op@nx.test');
  net = await networkWithAgents(ctx.app, op, { cidr: '10.68.0.0/24', count: 2 });
});
test.after(() => ctx.teardown());

const request = (from, to, megabytes = 8) =>
  op.post(`/api/v1/devices/${from.deviceId}/actions`, { actionType: 'run_transfer_test', params: { peerDeviceId: to.deviceId, megabytes } });

async function approveAndRun(agent, actionId, output) {
  const approved = await op.post(`/api/v1/actions/${actionId}/approve`, {});
  assert.equal(approved.status, 200);
  const [cmd] = (await agent.signed('GET', '/api/v1/agent/commands')).body.data;
  assert.equal(cmd.type, 'transfer_test');
  const now = new Date().toISOString();
  const measurements = output.integrityMatch === undefined ? [] : [
    { type: 'throughput', target: { kind: 'peer', ref: null }, value: output.mbitPerSecond * 1e6, unit: 'bps', valid: true, source: 'agent', sampleCount: 1, measuredAt: now },
  ];
  const done = await agent.signed('POST', `/api/v1/agent/commands/${cmd.id}/result`, { status: 'succeeded', startedAt: now, finishedAt: now, output, measurements });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { cmd, verification: done.body.data.verification };
}

test('peer without the transfer sink is refused by the policy engine', async () => {
  const [a, b] = net.agents;
  await a.heartbeat({ capabilities: CAPS, agentVersion: '0.3.0' });
  await b.heartbeat({ agentVersion: '0.2.0' }); // older agent: no transfer_test
  const res = await request(a, b);
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'rejected_by_policy');
  assert.match(res.body.data.validation.reasons.join(' '), /PRECONDITION_PEER_CAPABILITY/);
});

test('size is bounded (1..32 MB)', async () => {
  const [a, b] = net.agents;
  await a.heartbeat({ capabilities: CAPS });
  await b.heartbeat({ capabilities: CAPS });
  const res = await request(a, b, 64);
  assert.equal(res.body.data.status, 'rejected_by_policy');
  assert.match(res.body.data.validation.reasons.join(' '), /INVALID_PARAMS/);
});

test('request → approve → agent sends → verified by matching checksum', async () => {
  const [a, b] = net.agents;
  await a.heartbeat({ capabilities: CAPS });
  await b.heartbeat({ capabilities: CAPS });
  const req = await request(a, b, 8);
  assert.equal(req.body.data.status, 'awaiting_approval');
  const sha = 'ab'.repeat(32);
  const { cmd, verification } = await approveAndRun(a, req.body.data.id, {
    bytesSent: 8 << 20, bytesConfirmed: 8 << 20, durationMs: 690, mbitPerSecond: 97.2, sha256: sha, peerSha256: sha, integrityMatch: true,
  });
  assert.deepEqual(cmd.params, { peerDeviceId: b.deviceId, megabytes: 8 });
  assert.equal(verification.outcome, 'successful');
  assert.match(verification.notes.join(' '), /8\.0 MB sent, 8\.0 MB confirmed/);
  assert.match(verification.notes.join(' '), /Integrity verified/);

  // The topology's flow panel reads the agent's numbers from the action list.
  const listed = (await op.get(`/api/v1/devices/${a.deviceId}/actions`)).body.data.find((x) => x.id === req.body.data.id);
  assert.equal(listed.status, 'completed');
  assert.equal(listed.transfer.mbitPerSecond, 97.2);
  assert.equal(listed.transfer.bytesConfirmed, 8 << 20);
  assert.equal(listed.transfer.integrityMatch, true);
  assert.equal(listed.transfer.commandStatus, 'succeeded');
});

test('a checksum mismatch fails verification', async () => {
  const [a, b] = net.agents;
  await a.heartbeat({ capabilities: CAPS });
  await b.heartbeat({ capabilities: CAPS });
  const req = await request(a, b, 4);
  const { verification } = await approveAndRun(a, req.body.data.id, {
    bytesSent: 4 << 20, bytesConfirmed: (4 << 20) - 1024, durationMs: 500, mbitPerSecond: 67, sha256: 'ab'.repeat(32), peerSha256: 'cd'.repeat(32), integrityMatch: false,
  });
  assert.equal(verification.outcome, 'failed');
  assert.match(verification.notes.join(' '), /does not match/);
});

test('the AI evidence includes transfer results, and tunnel vs internet RTT are labelled', async () => {
  const [a] = net.agents;
  const device = await Device.findById(a.deviceId).lean();
  const { evidence, toolsRun } = await collectEvidence({ device, incident: { evidence: [] }, config: ctx.config });
  assert.ok(toolsRun.find((t) => t.tool === 'get_recent_transfer_tests' && t.ok));
  const transfers = evidence.filter((x) => x.kind === 'transfer_test');
  assert.ok(transfers.some((x) => /8\.0 MB in 0\.69 s = 97\.2 Mbit\/s through the tunnel; .*checksum matches/.test(x.summary)), JSON.stringify(transfers));
  assert.ok(transfers.some((x) => /MISMATCH/.test(x.summary)));
});
