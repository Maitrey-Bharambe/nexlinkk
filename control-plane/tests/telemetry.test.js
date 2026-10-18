'use strict';

// Category: integration (ephemeral MongoDB) + simulated agents; health logic unit tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, login, networkWithAgents } = require('./helpers');
const { Device } = require('../src/database/models/device');
const { Measurement } = require('../src/database/models/telemetry');
const { computeDeviceHealth, peerLinkState, thresholds } = require('../src/modules/telemetry/health');
const { loadConfig } = require('../src/config/env');

let ctx;
let op;
let net;
test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'op@nx.test', role: 'operator' });
  op = await login(ctx.app, 'op@nx.test');
  net = await networkWithAgents(ctx.app, op, { cidr: '10.90.0.0/24', count: 2 });
});
test.after(() => ctx.teardown());

const deviceView = async (id) => (await op.get(`/api/v1/devices/${id}`)).body.data;

test('a fresh enrolled device with no heartbeat is "unknown", not offline or healthy', async () => {
  const d = await deviceView(net.agents[0].deviceId);
  assert.equal(d.health.status, 'unknown');
  assert.equal(d.health.agent.status, 'never_seen');
  assert.equal(d.health.latestRtt, null, 'no RTT measured → null, not 0');
});

test('heartbeat proves agent liveness only — VPN stays unknown without telemetry', async () => {
  const [a] = net.agents;
  const res = await a.heartbeat();
  assert.equal(res.status, 200);
  const d = await deviceView(a.deviceId);
  assert.equal(d.health.agent.status, 'online');
  assert.equal(d.health.vpn.state, 'unknown');
  assert.equal(d.health.status, 'unknown');
});

test('stale sequence numbers, replayed nonces and tampered bodies are rejected', async () => {
  const [a] = net.agents;
  a.sequence -= 1; // re-send an old sequence for the same boot
  const stale = await a.heartbeat();
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STALE_SEQUENCE');

  const body = { schemaVersion: 1, deviceId: a.deviceId, bootId: a.bootId, sequence: 1000, agentTime: new Date().toISOString(), agentVersion: 't', health: { status: 'ok', details: [] }, vpnInterface: null, capabilities: [] };
  const nonce = 'fixed-nonce-value-1234';
  assert.equal((await a.signed('POST', '/api/v1/agent/heartbeat', body, { nonce })).status, 200);
  const replay = await a.signed('POST', '/api/v1/agent/heartbeat', body, { nonce });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'REPLAY_DETECTED');

  const tampered = await a.signed('POST', '/api/v1/agent/heartbeat', { ...body, sequence: 1001 }, { tamper: (raw) => raw.replace('1001', '9999') });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.error.code, 'AGENT_SIGNATURE_INVALID');

  const old = await a.signed('POST', '/api/v1/agent/heartbeat', { ...body, sequence: 1002 }, { timestamp: Date.now() - 600_000 });
  assert.equal(old.body.error.code, 'AGENT_TIMESTAMP_SKEW');
});

test('a device cannot submit telemetry as another device', async () => {
  const [a, b] = net.agents;
  // Claims to be b in the header but signs with a's key.
  const spoofHeader = await a.signed('POST', '/api/v1/agent/heartbeat', { schemaVersion: 1 }, { deviceId: b.deviceId });
  assert.equal(spoofHeader.status, 401);
  // Authenticates as a but names b in the body.
  const res = await a.signed('POST', '/api/v1/agent/telemetry', {
    schemaVersion: 1,
    deviceId: b.deviceId,
    measuredAt: new Date().toISOString(),
    interface: { name: 'nx0', state: 'up', listenPort: 51820, publicKey: null, appliedConfigVersion: null, source: 'wgctrl' },
    peers: [],
    measurements: [],
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'DEVICE_ID_MISMATCH');
});

test('telemetry validation: unavailable measurements stay null; fake values are refused', async () => {
  const [a] = net.agents;
  const now = new Date().toISOString();
  const unavailable = { type: 'rtt', target: { kind: 'control_plane', ref: null }, value: null, unit: 'ms', valid: false, source: 'tcp_connect', error: 'timeout', measuredAt: now };
  assert.equal((await a.telemetry({ measurements: [unavailable] })).status, 200);
  const m = await Measurement.findOne({ deviceId: a.deviceId, type: 'rtt' }).lean();
  assert.equal(m.value, null);
  assert.equal(m.valid, false);

  for (const bad of [
    { ...unavailable, valid: true }, // valid but no value
    { ...unavailable, value: 0 }, // invalid but carries a value
    { ...unavailable, valid: true, value: 12, unit: 'percent' }, // wrong unit
    { ...unavailable, type: 'packet_loss', unit: 'percent', valid: true, value: 140 },
    { ...unavailable, extra: 1 },
  ]) {
    const res = await a.telemetry({ measurements: [bad] });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  const d = await deviceView(a.deviceId);
  assert.equal(d.health.latestRtt, null, 'invalid measurement never surfaces as a latency');
});

test('simulated interface data is never reported as healthy', async () => {
  const [a] = net.agents;
  await a.heartbeat();
  await a.telemetry({ source: 'simulated', state: 'up' });
  const d = await deviceView(a.deviceId);
  assert.equal(d.health.status, 'unknown');
});

test('peer link is "configured" until handshake evidence, then "connected"', async () => {
  const [a, b] = net.agents;
  const before = (await op.get(`/api/v1/topology?networkId=${net.networkId}`)).body.data;
  const peerEdge = before.edges.find((e) => e.kind === 'peer');
  assert.ok(['configured', 'connecting'].includes(peerEdge.state));

  await a.heartbeat();
  await b.heartbeat();
  const recent = new Date(Date.now() - 20_000).toISOString();
  const peerOf = (x) => ({ publicKey: x.wireguardPublicKey, endpoint: '192.168.1.30:51820', lastHandshakeAt: recent, rxBytes: 1000, txBytes: 2000, allowedIPs: [`${x.address}/32`] });
  assert.equal((await a.telemetry({ peers: [peerOf(b)] })).status, 200);
  assert.equal((await b.telemetry({ peers: [peerOf(a)] })).status, 200);

  const after = (await op.get(`/api/v1/topology?networkId=${net.networkId}`)).body.data;
  const edge = after.edges.find((e) => e.kind === 'peer');
  assert.equal(edge.state, 'connected');
  assert.equal(edge.path, 'direct');
  const d = await deviceView(a.deviceId);
  assert.equal(d.health.status, 'healthy');
  assert.ok(d.health.lastHandshakeAt);
  assert.ok(await Measurement.exists({ deviceId: a.deviceId, type: 'handshake_age', valid: true }));
});

test('wireguard-go (userspace) peer reports count as real observations; simulated ones do not', async () => {
  const [a, b] = net.agents;
  await a.heartbeat();
  await b.heartbeat();
  const recent = new Date(Date.now() - 5_000).toISOString();
  const peer = (x) => ({ publicKey: x.wireguardPublicKey, endpoint: '127.0.0.1:51831', lastHandshakeAt: recent, rxBytes: 10, txBytes: 10, allowedIPs: [`${x.address}/32`] });
  assert.equal((await a.telemetry({ source: 'wireguard-go', peers: [peer(b)] })).status, 200);
  assert.equal((await b.telemetry({ source: 'wireguard-go', peers: [peer(a)] })).status, 200);
  const edge = (await op.get(`/api/v1/topology?networkId=${net.networkId}`)).body.data.edges.find((e) => e.kind === 'peer');
  assert.equal(edge.state, 'connected');
  const d = await deviceView(a.deviceId);
  assert.equal(d.vpn.source, 'wireguard-go');
  assert.equal(d.health.status, 'healthy');
});

test('a peer dropped from the interface reverts its link to "configured"', async () => {
  const [a, b] = net.agents;
  await a.heartbeat();
  await b.heartbeat();
  // Both sides stop reporting each other (e.g. tunnel removed).
  assert.equal((await a.telemetry({ peers: [] })).status, 200);
  assert.equal((await b.telemetry({ peers: [] })).status, 200);
  const edge = (await op.get(`/api/v1/topology?networkId=${net.networkId}`)).body.data.edges.find((e) => e.kind === 'peer');
  assert.equal(edge.state, 'configured');
});

test('agent health thresholds from heartbeat freshness (unit)', () => {
  const config = loadConfig({ HEARTBEAT_INTERVAL_SECONDS: '30', HANDSHAKE_FRESH_SECONDS: '180' });
  const now = Date.now();
  const base = { enrollmentState: 'enrolled', vpn: { state: 'up', observedAt: new Date(now - 5000), source: 'wgctrl' } };
  const at = (s) => computeDeviceHealth({ ...base, lastHeartbeatAt: new Date(now - s * 1000) }, { now, config }).status;
  assert.equal(at(10), 'healthy');
  assert.equal(at(120), 'degraded'); // stale
  assert.equal(at(400), 'unreachable'); // offline
  const t = thresholds(config);
  const stale = peerLinkState({ observations: [{ observedAt: new Date(now), lastHandshakeAt: new Date(now - 400_000) }], now, t });
  assert.equal(stale.state, 'unreachable');
  const old = peerLinkState({ observations: [{ observedAt: new Date(now - 3600_000), lastHandshakeAt: new Date(now - 3600_000) }], now, t });
  assert.equal(old.state, 'unknown', 'stale observations do not prove anything');
});

test('interface key mismatch is flagged', async () => {
  const [a] = net.agents;
  await a.heartbeat();
  const res = await a.telemetry({ publicKey: net.agents[1].wireguardPublicKey });
  assert.equal(res.body.data.interfaceKeyMatches, false);
  const d = await Device.findById(a.deviceId).lean();
  assert.equal(d.vpn.keyMatches, false);
});
