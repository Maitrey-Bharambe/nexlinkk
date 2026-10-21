'use strict';

// Category: integration (ephemeral MongoDB) + simulated agents. Exercises the
// full OBSERVE → CLASSIFY → EVIDENCE → PLAN → VALIDATE → APPROVE → EXECUTE → VERIFY loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, login, networkWithAgents } = require('./helpers');
const { runDetector, evaluateConditions } = require('../server/modules/incidents/detector');
const { validateDiagnosticResult } = require('../server/modules/diagnostics/diagnostic.schema');
const { evaluateAction } = require('../server/modules/policies/policyEngine');
const { proposeActions, sweepTimedOutCommands } = require('../server/modules/approvals/actions.service');
const { Incident, ProposedAction } = require('../server/database/models/incidents');
const { AgentCommand } = require('../server/database/models/device');
const { AuditEvent } = require('../server/database/models/audit');

let ctx;
let admin;
let op;
let viewer;
let net;
test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'admin@nx.test', role: 'admin' });
  await createUser(ctx.config, { email: 'op@nx.test', role: 'operator' });
  await createUser(ctx.config, { email: 'viewer@nx.test', role: 'viewer' });
  admin = await login(ctx.app, 'admin@nx.test');
  op = await login(ctx.app, 'op@nx.test');
  net = await networkWithAgents(ctx.app, op, { cidr: '10.33.0.0/24', count: 2 });
  // Share the network read-only with the viewer.
  await op.post(`/api/v1/networks/${net.networkId}/collaborators`, { email: 'viewer@nx.test', role: 'viewer' });
  viewer = await login(ctx.app, 'viewer@nx.test');
});
test.after(() => ctx.teardown());

let incidentId;

test('detector opens an incident from a real observation (interface down), once', async () => {
  const [a] = net.agents;
  await a.heartbeat();
  await a.telemetry({ state: 'down' });
  await runDetector({ config: ctx.config });
  await runDetector({ config: ctx.config }); // idempotent
  const list = (await op.get('/api/v1/incidents?state=active')).body.data;
  const mine = list.filter((i) => i.deviceId === a.deviceId && i.category === 'vpn_interface_down');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].source, 'detector');
  assert.ok(mine[0].evidence.length >= 1);
  incidentId = mine[0].id;
  assert.ok(await AuditEvent.exists({ operation: 'incident.detect', incidentId }));
});

test('detector does not open incidents on unknown data', () => {
  const conds = evaluateConditions({
    device: { _id: 'x', name: 'x', enrolledAt: new Date() },
    health: { agent: { status: 'never_seen' }, vpn: { state: 'unknown' } },
    links: [],
    measurements: [],
    now: Date.now(),
  });
  assert.ok(conds.every((c) => c.holds === null));
});

test('deterministic diagnostics produce grounded, schema-valid output and policy-checked proposals', async () => {
  const res = await op.post(`/api/v1/incidents/${incidentId}/diagnostics`, { mode: 'deterministic' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'completed');
  const detail = (await op.get(`/api/v1/incidents/${incidentId}`)).body.data;
  const run = detail.diagnosticRuns[0];
  assert.equal(run.result.requires_human_approval, true);
  const refs = new Set(run.evidence.map((e) => e.ref));
  for (const o of run.result.observations) for (const r of o.evidence_refs) assert.ok(refs.has(r), `grounded ref ${r}`);
  // Agent lacks wireguard_apply (safe mode) → config refresh rejected by policy, peer report allowed.
  const byType = Object.fromEntries(detail.actions.map((x) => [x.actionType, x]));
  assert.equal(byType.request_peer_status_report.status, 'awaiting_approval');
  assert.equal(byType.request_vpn_config_refresh.status, 'rejected_by_policy');
  assert.match(byType.request_vpn_config_refresh.validation.reasons[0], /PRECONDITION_CAPABILITY/);
  assert.equal(detail.state, 'awaiting_approval');
});

test('diagnostic output that cites invented evidence or adds confidence is rejected', () => {
  const base = {
    incident_id: 'i1',
    summary: 's',
    observations: [{ statement: 'x', evidence_refs: ['measurement:real'] }],
    hypotheses: [],
    evidence: ['measurement:real'],
    uncertainties: [],
    proposed_actions: [],
    requires_human_approval: true,
  };
  assert.equal(validateDiagnosticResult(base, { incidentId: 'i1', evidenceRefs: ['measurement:real'] }).ok, true);
  const invented = validateDiagnosticResult(
    { ...base, observations: [{ statement: 'x', evidence_refs: ['measurement:made-up'] }] },
    { incidentId: 'i1', evidenceRefs: ['measurement:real'] },
  );
  assert.equal(invented.ok, false);
  assert.match(invented.errors[0], /unknown evidence/);
  assert.equal(validateDiagnosticResult({ ...base, confidence: 0.97 }, { incidentId: 'i1', evidenceRefs: [] }).ok, false);
  assert.equal(validateDiagnosticResult({ ...base, requires_human_approval: false }, { incidentId: 'i1', evidenceRefs: ['measurement:real'] }).ok, false);
});

test('unknown or malformed AI actions are rejected by the policy engine', async () => {
  const incident = await Incident.findById(incidentId);
  const deviceId = incident.deviceId;
  const unknown = await evaluateAction({ actionType: 'run_shell', params: { cmd: 'rm -rf /' }, deviceId, incident, phase: 'propose', config: ctx.config });
  assert.equal(unknown.valid, false);
  assert.match(unknown.reasons[0], /UNKNOWN_ACTION/);
  const proto = await evaluateAction({ actionType: '__proto__', params: {}, deviceId, incident, phase: 'propose', config: ctx.config });
  assert.equal(proto.valid, false);
  const malformed = await evaluateAction({ actionType: 'run_connectivity_test', params: { target: 'peer', count: 999 }, deviceId, incident, phase: 'propose', config: ctx.config });
  assert.equal(malformed.valid, false);
  assert.ok(malformed.reasons.every((r) => r.startsWith('INVALID_PARAMS')));
  const relay = await evaluateAction({ actionType: 'request_relay_fallback', params: { peerDeviceId: String(deviceId) }, deviceId, incident, phase: 'propose', config: ctx.config });
  assert.match(relay.reasons[0], /ACTION_UNAVAILABLE/);
  const otherDevice = await evaluateAction({ actionType: 'request_peer_status_report', params: {}, deviceId: net.agents[1].deviceId, incident, phase: 'propose', config: ctx.config });
  assert.ok(otherDevice.reasons.some((r) => r.startsWith('INCIDENT_DEVICE_MISMATCH')));

  const stored = await proposeActions({ incident, run: null, proposals: [{ action_type: 'run_shell', params: {}, rationale: 'model said so' }], proposedBy: { type: 'diagnostic_service', ref: 't' }, config: ctx.config });
  assert.equal(stored[0].status, 'rejected_by_policy');
});

test('viewers cannot approve; already-decided and policy-rejected actions cannot be approved', async () => {
  const actions = (await op.get(`/api/v1/incidents/${incidentId}/actions`)).body.data;
  const pending = actions.find((a) => a.status === 'awaiting_approval');
  const rejected = actions.find((a) => a.status === 'rejected_by_policy');
  const v = await viewer.post(`/api/v1/actions/${pending.id}/approve`, {});
  assert.equal(v.status, 403);
  assert.ok(await AuditEvent.exists({ operation: 'action.approve', decision: 'deny', actionId: pending.id }));
  const r = await op.post(`/api/v1/actions/${rejected.id}/approve`, {});
  assert.equal(r.status, 409);
});

test('approved action executes through the agent and is verified from fresh observations', async () => {
  const [a] = net.agents;
  await a.heartbeat();
  const pending = (await op.get('/api/v1/approvals')).body.data.find((x) => x.incidentId === incidentId);
  const ok = await op.post(`/api/v1/actions/${pending.id}/approve`, { reason: 'safe read' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'queued');
  assert.equal((await op.post(`/api/v1/actions/${pending.id}/approve`, {})).status, 409, 'no double approval');

  // Agent picks up the command (another agent cannot see it).
  assert.deepEqual((await net.agents[1].signed('GET', '/api/v1/agent/commands')).body.data, []);
  const cmds = (await a.signed('GET', '/api/v1/agent/commands')).body.data;
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].type, 'report_peer_status');
  const stolen = await net.agents[1].signed('POST', `/api/v1/agent/commands/${cmds[0].id}/result`, {
    status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output: {}, measurements: [],
  });
  assert.equal(stolen.status, 404);

  // Agent re-reads WireGuard: interface now up. Then reports the result.
  await a.telemetry({ state: 'up' });
  const res = await a.signed('POST', `/api/v1/agent/commands/${cmds[0].id}/result`, {
    status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output: { interfaceState: 'up' }, measurements: [],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.verification.outcome, 'successful');

  const inc = (await op.get(`/api/v1/incidents/${incidentId}`)).body.data;
  assert.equal(inc.state, 'resolved', 'resolved because the detector observed the interface up');
  assert.equal(inc.resolution.method, 'condition_cleared_observed');
  for (const op_ of ['action.approve', 'agent.command_result', 'action.verify', 'incident.resolve']) {
    assert.ok(await AuditEvent.exists({ operation: op_ }), op_);
  }
});

test('an agent success report without fresh observations is "inconclusive", not resolved', async () => {
  const [, b] = net.agents;
  await b.heartbeat();
  const t = await admin.post('/api/v1/incidents/test', { deviceId: b.deviceId, category: 'vpn_interface_down', note: 'pipeline drill' });
  assert.equal(t.status, 201);
  assert.equal(t.body.data.isTest, true);
  await op.post(`/api/v1/incidents/${t.body.data.id}/diagnostics`, {});
  const action = (await op.get(`/api/v1/incidents/${t.body.data.id}/actions`)).body.data.find((x) => x.actionType === 'request_peer_status_report');
  assert.equal((await op.post(`/api/v1/actions/${action.id}/approve`, {})).status, 200);
  const [cmd] = (await b.signed('GET', '/api/v1/agent/commands')).body.data;
  const res = await b.signed('POST', `/api/v1/agent/commands/${cmd.id}/result`, {
    status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), output: {}, measurements: [],
  });
  assert.equal(res.body.data.verification.outcome, 'verification_inconclusive');
  const inc = (await op.get(`/api/v1/incidents/${t.body.data.id}`)).body.data;
  assert.equal(inc.active, true, 'test incident is not auto-resolved');
});

test('commands that exceed their deadline are marked timed_out', async () => {
  const [, b] = net.agents;
  const incident = await Incident.findOne({ deviceId: b.deviceId, active: true });
  const [action] = await proposeActions({ incident, proposals: [{ action_type: 'run_connectivity_test', params: { target: 'control_plane', count: 3 }, rationale: 't' }], proposedBy: { type: 'deterministic_rules', ref: 't' }, config: ctx.config });
  assert.equal(action.status, 'awaiting_approval');
  assert.equal((await op.post(`/api/v1/actions/${action._id}/approve`, {})).status, 200);
  await AgentCommand.updateOne({ actionId: action._id }, { deadlineAt: new Date(Date.now() - 1000) });
  await sweepTimedOutCommands({ config: ctx.config });
  const after = await ProposedAction.findById(action._id).lean();
  assert.equal(after.status, 'completed');
  assert.equal(after.verification.outcome, 'timed_out');
});

test('connectivity test results are verified from the measurements they produced', async () => {
  const [a] = net.agents;
  await a.heartbeat({ capabilities: ['telemetry', 'connectivity_probe', 'wireguard_inspect'] });
  const t = await admin.post('/api/v1/incidents/test', { deviceId: a.deviceId, category: 'latency_high', note: 'drill' });
  const incident = await Incident.findById(t.body.data.id);
  const [action] = await proposeActions({ incident, proposals: [{ action_type: 'run_connectivity_test', params: { target: 'control_plane', count: 4 }, rationale: 'repeat' }], proposedBy: { type: 'deterministic_rules', ref: 't' }, config: ctx.config });
  await op.post(`/api/v1/actions/${action._id}/approve`, {});
  const [cmd] = (await a.signed('GET', '/api/v1/agent/commands')).body.data;
  const now = new Date().toISOString();
  const res = await a.signed('POST', `/api/v1/agent/commands/${cmd.id}/result`, {
    status: 'succeeded',
    startedAt: now,
    finishedAt: now,
    output: {},
    measurements: [
      { type: 'rtt', target: { kind: 'control_plane', ref: null }, value: 18.2, unit: 'ms', valid: true, source: 'tcp_connect', sampleCount: 3, measuredAt: now },
      { type: 'packet_loss', target: { kind: 'control_plane', ref: null }, value: null, unit: 'percent', valid: false, source: 'tcp_connect', error: '1 of 4 timed out; too few samples', measuredAt: now },
    ],
  });
  assert.equal(res.body.data.verification.outcome, 'partially_successful');
});

test('audit log is read-only through the API and searchable', async () => {
  assert.equal((await admin.post('/api/v1/audit-events', { operation: 'fake' })).status, 404);
  const res = await admin.get('/api/v1/audit-events?q=device.enroll');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length >= 2);
  assert.equal((await viewer.get('/api/v1/audit-events')).status, 403);
});

test('overview counts come from records, not samples', async () => {
  const o = (await op.get('/api/v1/overview')).body.data;
  assert.equal(o.networks, 1);
  assert.equal(o.devices.registered, 2);
  assert.ok(o.recentIncidents.length >= 1);
});
