'use strict';

// Category: integration (ephemeral MongoDB) + simulated agents with real keys,
// with a fake diagnostic service. Covers the device page's "analyze with AI".
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, login, networkWithAgents } = require('./helpers');
const { AuditEvent } = require('../server/database/models/audit');

// What the fake provider answers next; receives the request body it was sent.
let answer = () => ({});
let lastRequest = null;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    lastRequest = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ provider: 'fake:model', result: answer(lastRequest) }));
  });
});

const grounded = (body, extra = {}) => ({
  incident_id: body.incident.id,
  summary: 'Device looks healthy.',
  observations: [{ statement: 'Health is computed from fresh signals', evidence_refs: [body.evidence[0].ref] }],
  hypotheses: [],
  evidence: [body.evidence[0].ref],
  uncertainties: [],
  proposed_actions: [],
  requires_human_approval: true,
  ...extra,
});

let ctx;
let op;
let viewer;
let net;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  ctx = await setup({ DIAGNOSTIC_SERVICE_URL: `http://127.0.0.1:${fake.address().port}` });
  await createUser(ctx.config, { email: 'op@nx.test', role: 'operator' });
  await createUser(ctx.config, { email: 'viewer@nx.test', role: 'viewer' });
  op = await login(ctx.app, 'op@nx.test');
  net = await networkWithAgents(ctx.app, op, { cidr: '10.67.0.0/24', count: 1 });
  await op.post(`/api/v1/networks/${net.networkId}/collaborators`, { email: 'viewer@nx.test', role: 'viewer' });
  viewer = await login(ctx.app, 'viewer@nx.test');
});
test.after(async () => {
  await ctx.teardown();
  fake.close();
});

const analyze = (who) => who.post(`/api/v1/devices/${net.agents[0].deviceId}/analysis`, {});

test('grounded AI analysis is returned; the provider gets no actions to propose', async () => {
  answer = (body) => grounded(body);
  const res = await analyze(op);
  assert.equal(res.status, 200);
  const out = res.body.data;
  assert.equal(out.status, 'completed');
  assert.equal(out.provider, 'fake:model');
  assert.equal(out.result.summary, 'Device looks healthy.');
  assert.ok(out.evidence.length > 0);
  assert.deepEqual(lastRequest.allowed_actions, [], 'analysis must not offer any action');
  assert.equal(lastRequest.incident.category, 'health_check');
  const ev = await AuditEvent.findOne({ operation: 'device.analyze', outcome: 'success' }).lean();
  assert.ok(ev, 'analysis is audited');
});

test('an answer citing evidence that was never collected is rejected', async () => {
  answer = (body) => grounded(body, { observations: [{ statement: 'made up', evidence_refs: ['heartbeat:doesnotexist'] }] });
  const out = (await analyze(op)).body.data;
  assert.equal(out.status, 'rejected');
  assert.match(out.error, /unknown evidence/);
  assert.equal(out.result, undefined);
});

test('an analysis that proposes an action is rejected', async () => {
  answer = (body) => grounded(body, { proposed_actions: [{ action_type: 'run_connectivity_test', params: { target: 'control_plane' }, rationale: 'x' }] });
  const out = (await analyze(op)).body.data;
  assert.equal(out.status, 'rejected');
});

test('viewers cannot run an AI analysis', async () => {
  const res = await analyze(viewer);
  assert.equal(res.status, 403);
});
