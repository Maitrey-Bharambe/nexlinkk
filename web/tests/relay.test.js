'use strict';

// Category: integration (ephemeral MongoDB) + real WebSockets on a real HTTP
// server + simulated agents with real Ed25519 keys. Payloads stand in for
// WireGuard ciphertext; the relay must forward them only inside a network.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { setup, createUser, login, networkWithAgents } = require('./helpers');
const { canonicalRequest } = require('../server/middleware/agentAuth');
const { createRelay, RELAY_PATH } = require('../server/modules/relay/relay');

let ctx;
let op;
let server;
let relay;
let base;
let lab;
let other;

test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'relay-op@nx.test', role: 'operator' });
  op = await login(ctx.app, 'relay-op@nx.test');
  lab = await networkWithAgents(ctx.app, op, { name: 'relay-lab', cidr: '10.95.0.0/24', count: 2 });
  other = await networkWithAgents(ctx.app, op, { name: 'relay-other', cidr: '10.96.0.0/24', count: 1 });
  relay = createRelay({ config: ctx.config, logger: { info() {}, warn() {} } });
  ctx.app.locals.relay = relay;
  server = http.createServer(ctx.app);
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  relay.close();
  await new Promise((r) => server.close(r));
  await ctx.teardown();
});

function connect(agent, { badSignature = false } = {}) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString('base64url');
  let sig = agent.sign(canonicalRequest({ method: 'GET', path: RELAY_PATH, timestamp: ts, nonce, deviceId: agent.deviceId, body: Buffer.alloc(0) }));
  if (badSignature) sig = Buffer.alloc(64, 1).toString('base64');
  const ws = new WebSocket(base + RELAY_PATH, {
    headers: { 'x-nexlink-device': agent.deviceId, 'x-nexlink-timestamp': String(ts), 'x-nexlink-nonce': nonce, 'x-nexlink-signature': sig },
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

const frame = (toId, payload) => Buffer.concat([Buffer.from(toId, 'hex'), Buffer.from(payload)]);
const nextMessage = (ws, ms = 1500) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    ws.once('message', (d) => {
      clearTimeout(t);
      resolve(Buffer.from(d));
    });
  });

test('unsigned or badly signed agents cannot open the relay', async () => {
  const [a] = lab.agents;
  await assert.rejects(() => connect(a, { badSignature: true }), (e) => e.status === 401);
  const ws = new WebSocket(base + RELAY_PATH);
  const status = await new Promise((r) => ws.once('unexpected-response', (_q, res) => r(res.statusCode)));
  assert.equal(status, 401);
});

test('packets reach the peer, stamped with the sender id by the relay', async () => {
  const [a, b] = lab.agents;
  const wa = await connect(a);
  const wb = await connect(b);
  const got = nextMessage(wb);
  wa.send(frame(b.deviceId, 'wireguard ciphertext'));
  const m = await got;
  assert.ok(m, 'b received the packet');
  assert.equal(m.subarray(0, 12).toString('hex'), a.deviceId);
  assert.equal(m.subarray(12).toString(), 'wireguard ciphertext');

  const status = (await op.get(`/api/v1/devices/${a.deviceId}`)).body.data.relay;
  assert.equal(status.connected, true);
  wa.close();
  wb.close();
});

test('the relay never forwards across networks', async () => {
  const [a] = lab.agents;
  const [x] = other.agents;
  const wa = await connect(a);
  const wx = await connect(x);
  const got = nextMessage(wx, 800);
  wa.send(frame(x.deviceId, 'should not arrive'));
  assert.equal(await got, null);
  wa.close();
  wx.close();
});

test('revoking a device drops its relay connection at once', async () => {
  const [, b] = lab.agents;
  const wb = await connect(b);
  const closed = new Promise((r) => wb.once('close', (code) => r(code)));
  const res = await op.post(`/api/v1/devices/${b.deviceId}/revoke`, { reason: 'lost laptop' });
  assert.equal(res.status, 200);
  assert.equal(await closed, 4403);
  await assert.rejects(() => connect(b), (e) => e.status === 403);
});
