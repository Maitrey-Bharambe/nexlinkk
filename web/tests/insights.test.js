'use strict';

// Category: integration (ephemeral MongoDB) + simulated agents + a stub
// diagnostic service on a real HTTP port. Checks that analytics come only from
// records and that AI briefings are grounded, explain-only and stored.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, createUser, login, networkWithAgents } = require('./helpers');
const { AiBriefing } = require('../server/database/models/insights');

let ctx;
let op;
let viewer;
let net;
let stub;
let mode = 'grounded';
let lastRequest = null;

test.before(async () => {
  // The stub answers like the Python service, citing refs from the request.
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      lastRequest = body;
      const refs = body.evidence.map((e) => e.ref);
      const result = {
        incident_id: body.incident.id,
        summary: 'Two devices enrolled; no tunnel has a fresh handshake yet.',
        observations: [{ statement: 'The network summary reports two enrolled devices.', evidence_refs: [mode === 'invented' ? 'device:000000000000000000000000:health' : refs[0]] }],
        hypotheses: [{ statement: 'Agents may not have started their tunnels yet.', status: 'untested', supporting_refs: [] }],
        evidence: [refs[0]],
        uncertainties: ['No tunnel measurements exist yet.'],
        proposed_actions: mode === 'actions' ? [{ action_type: 'run_connectivity_test', params: { target: 'control_plane' }, rationale: 'check' }] : [],
        requires_human_approval: true,
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ provider: 'stub:test', result }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  ctx = await setup({ DIAGNOSTIC_SERVICE_URL: `http://127.0.0.1:${stub.address().port}`, BRIEFING_INTERVAL_MINUTES: '0' });
  await createUser(ctx.config, { email: 'ins-op@nx.test', role: 'operator' });
  await createUser(ctx.config, { email: 'ins-viewer@nx.test', role: 'viewer' });
  op = await login(ctx.app, 'ins-op@nx.test');
  viewer = await login(ctx.app, 'ins-viewer@nx.test');
  net = await networkWithAgents(ctx.app, op, { name: 'insights-lab', cidr: '10.97.0.0/24', count: 2 });
});
test.after(async () => {
  await new Promise((r) => stub.close(r));
  await ctx.teardown();
});

test('analytics come from records: nothing measured means null, not zero', async () => {
  const res = await op.get(`/api/v1/insights?networkId=${net.networkId}`);
  assert.equal(res.status, 200);
  const a = res.body.data.analytics;
  assert.equal(a.devices.enrolled, 2);
  assert.equal(a.tunnels.total, 1);
  assert.equal(a.tunnels.connected, 0);
  assert.equal(a.latency.samples, 0);
  assert.equal(a.latency.rttAvg, null, 'no RTT measured → null');
  assert.equal(a.latency.series.length, 25);
  assert.equal(res.body.data.briefings[0].latest, null, 'no briefing until one is generated');
  assert.equal(res.body.data.ai.configured, true);
});

test('an operator briefing is grounded, explain-only and stored', async () => {
  mode = 'grounded';
  const res = await op.post('/api/v1/insights/briefings', { networkId: net.networkId });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'completed');
  assert.equal(res.body.data.provider, 'stub:test');
  assert.deepEqual(lastRequest.allowed_actions, [], 'the model is offered no actions');
  assert.ok(lastRequest.evidence.some((e) => e.ref === `network:${net.networkId}:summary`));
  assert.ok(lastRequest.evidence.every((e) => e.data === null), 'raw data payloads are not sent');
  const view = await op.get(`/api/v1/insights?networkId=${net.networkId}`);
  assert.equal(view.body.data.briefings[0].latest.result.summary, 'Two devices enrolled; no tunnel has a fresh handshake yet.');
});

test('a briefing citing invented evidence, or proposing actions, is rejected', async () => {
  mode = 'invented';
  const a = await op.post('/api/v1/insights/briefings', { networkId: net.networkId });
  assert.equal(a.body.data.status, 'rejected');
  mode = 'actions';
  const b = await op.post('/api/v1/insights/briefings', { networkId: net.networkId });
  assert.equal(b.body.data.status, 'rejected');
  // The last good briefing stays the one shown; the failed attempt is reported separately.
  const view = await op.get(`/api/v1/insights?networkId=${net.networkId}`);
  assert.equal(view.body.data.briefings[0].latest.status, 'completed');
  assert.equal(view.body.data.briefings[0].lastAttempt.status, 'rejected');
  assert.equal(await AiBriefing.countDocuments({ networkId: net.networkId }), 3);
});

test('viewers can read insights but cannot trigger AI runs', async () => {
  assert.equal((await viewer.get('/api/v1/insights')).status, 200);
  assert.equal((await viewer.post('/api/v1/insights/briefings', { networkId: net.networkId })).status, 403);
});
