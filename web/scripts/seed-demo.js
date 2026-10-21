'use strict';

/**
 * DEVELOPMENT / DEMO ONLY: fills every console page with a demo scenario.
 *
 * Nothing is written straight into MongoDB. Every record is produced by the
 * real system: networks and registrations through the API as the dev admin,
 * devices enrolled by the real Go agent (own keys, proof of possession),
 * a real WireGuard tunnel between two of them (`nexlink-agent lab`), and
 * incidents created as explicitly-labelled [TEST] drills that go through the
 * real diagnosis → policy → approval → agent → verification path. The audit
 * log therefore records all of it.
 *
 *   node scripts/seed-demo.js setup       networks + devices (enroll, revoke, pending)
 *   node scripts/seed-demo.js scenarios   incidents, diagnoses, approvals (needs the lab running)
 *   node scripts/seed-demo.js remove      delete the demo networks and everything in them
 *
 * scripts\demo-data.ps1 (repo root) runs setup → lab → scenarios in one go.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = process.env.NEXLINK_SERVER || 'http://127.0.0.1:3000';
const AGENT = path.join(ROOT, 'networking-agent', 'bin', process.platform === 'win32' ? 'nexlink-agent.exe' : 'nexlink-agent');
const STATE = path.join(ROOT, 'networking-agent', 'bin', 'demo');
const CREDS = path.join(__dirname, '..', '.data', 'dev-admin.txt');

const NETWORKS = [
  { name: 'demo-campus', cidr: '10.88.0.0/24' },
  { name: 'demo-branch', cidr: '10.89.0.0/24' },
];
const DEVICES = {
  a: 'demo-laptop-a', // runs in the lab: real tunnel with b
  b: 'demo-laptop-b',
  desktop: 'demo-desktop', // enrolled, never started → unknown
  old: 'demo-old-laptop', // enrolled, then revoked
  printer: 'demo-printer', // registered, token never used → pending
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

// ── API session as the dev admin ─────────────────────────────────────
let cookie = '';
let csrf = '';

async function api(method, p, body) {
  const headers = { 'content-type': 'application/json', cookie };
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(SERVER + '/api/v1' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(`${method} ${p}: ${json.error?.code || res.status} ${json.error?.message || ''}`);
    err.code = json.error?.code;
    throw err;
  }
  return json.data;
}

async function login() {
  if (!fs.existsSync(CREDS)) throw new Error(`missing ${CREDS} (dev admin credentials)`);
  const text = fs.readFileSync(CREDS, 'utf8');
  const email = text.match(/email:\s*(\S+)/)?.[1];
  const password = text.match(/password:\s*(\S+)/)?.[1];
  const res = await fetch(SERVER + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`login failed: ${json.error?.code}`);
  cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');
  csrf = json.data.csrfToken;
  log(`signed in as ${json.data.user.email}`);
}

// ── helpers ──────────────────────────────────────────────────────────
async function demoNetworks() {
  const nets = await api('GET', '/networks');
  const list = Array.isArray(nets) ? nets : nets.items || nets.networks || [];
  return list.filter((n) => NETWORKS.some((d) => d.name === n.name));
}

async function devicesIn(networkId) {
  const res = await api('GET', `/devices?networkId=${networkId}`);
  return Array.isArray(res) ? res : res.items || res.devices || [];
}

function enrollWithAgent(name, token) {
  const dir = path.join(STATE, name);
  const r = spawnSync(AGENT, ['enroll', '--server', SERVER, '--state-dir', dir], {
    env: { ...process.env, NEXLINK_ENROLLMENT_TOKEN: token },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`agent enroll ${name} failed: ${(r.stderr || r.stdout || '').trim()}`);
  log(`enrolled ${name} with the real agent (keys in ${path.relative(ROOT, dir)})`);
}

// ── setup: networks and devices ──────────────────────────────────────
async function setup() {
  if (!fs.existsSync(AGENT)) throw new Error(`agent binary not found: ${AGENT}`);
  if ((await demoNetworks()).length) throw new Error('demo data already exists — run "remove" first');
  fs.mkdirSync(STATE, { recursive: true });

  const nets = {};
  for (const n of NETWORKS) {
    nets[n.name] = await api('POST', '/networks', n);
    log(`network ${n.name} ${n.cidr}`);
  }
  const campus = nets['demo-campus'].id;
  const branch = nets['demo-branch'].id;

  const register = async (name, networkId) => (await api('POST', '/devices/enrollment-requests', { networkId, name }));
  // demo-desktop lives in demo-branch: in demo-campus it would be a configured peer that never
  // connects, which (correctly) marks the two laptops "degraded" instead of healthy.
  for (const [key, net] of [['a', campus], ['b', campus], ['old', campus], ['desktop', branch]]) {
    const reg = await register(DEVICES[key], net);
    enrollWithAgent(DEVICES[key], reg.enrollment.token);
  }
  await register(DEVICES.printer, branch);
  log(`${DEVICES.printer} registered in demo-branch (token not used → pending)`);

  const old = (await devicesIn(campus)).find((d) => d.name === DEVICES.old);
  await api('POST', `/devices/${old.id}/revoke`, { reason: 'demo: laptop reported lost' });
  log(`${DEVICES.old} revoked`);
  console.log('\n  setup done. Start the tunnel, then run "scenarios":');
  console.log(`  nexlink-agent lab --server ${SERVER} --a ${path.join(STATE, DEVICES.a)} --b ${path.join(STATE, DEVICES.b)} --duration 0`);
}

// ── scenarios: incidents, diagnoses, approvals ───────────────────────
async function waitFor(what, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function testIncident(device, category, note, peer) {
  try {
    return await api('POST', '/incidents/test', { deviceId: device.id, category, note, ...(peer ? { peerDeviceId: peer.id } : {}) });
  } catch (err) {
    if (err.code !== 'INCIDENT_ALREADY_OPEN') throw err;
    const list = await api('GET', `/incidents?state=active`);
    const items = Array.isArray(list) ? list : list.items || [];
    return items.find((i) => i.deviceId === device.id && i.category === category);
  }
}

async function diagnose(incident, mode = 'deterministic') {
  const run = await api('POST', `/incidents/${incident.id}/diagnostics`, { mode });
  return run.actions || [];
}

async function waitVerified(incidentId, actionId) {
  return waitFor(
    'agent to execute and verify the approved action',
    async () => {
      const inc = await api('GET', `/incidents/${incidentId}`);
      const a = inc.actions.find((x) => x.id === actionId);
      return a?.verification?.outcome ? a : null;
    },
    90_000,
  );
}

async function scenarios() {
  const [campus] = (await demoNetworks()).filter((n) => n.name === 'demo-campus');
  if (!campus) throw new Error('no demo-campus network — run "setup" first');
  const devs = await devicesIn(campus.id);
  const a = devs.find((d) => d.name === DEVICES.a);
  const b = devs.find((d) => d.name === DEVICES.b);

  log('waiting for the lab tunnel (demo-laptop-a ⇄ demo-laptop-b) to report a handshake…');
  await waitFor(
    'a connected tunnel — is "nexlink-agent lab" running?',
    async () => {
      const topo = await api('GET', `/topology?networkId=${campus.id}`);
      return topo.edges.find((e) => e.kind === 'peer' && e.state === 'connected');
    },
    150_000,
  );
  log('tunnel connected');

  // 1 · stale-handshake drill → deterministic diagnosis → approved peer test → verified
  const i1 = await testIncident(a, 'peer_handshake_stale', 'demo drill: check the tunnel to demo-laptop-b', b);
  const acts1 = await diagnose(i1);
  const test1 = acts1.find((x) => x.actionType === 'run_connectivity_test' && x.status === 'awaiting_approval');
  if (test1) {
    await api('POST', `/actions/${test1.id}/approve`, { reason: 'demo: verify the tunnel' });
    const done = await waitVerified(i1.id, test1.id);
    log(`incident 1: approved connectivity test → verification ${done.verification.outcome}`);
  } else log('incident 1: no approvable connectivity test proposed (skipped approval)');

  // 2 · AI diagnosis on the same incident (Groq when configured; skipped if the service is down)
  try {
    await diagnose(i1, 'diagnostic_service');
    log('incident 1: AI diagnosis stored');
  } catch (err) {
    log(`incident 1: AI diagnosis skipped (${err.code || err.message})`);
  }

  // 3 · latency drill → action left awaiting approval (fills the approvals queue)
  const i2 = await testIncident(b, 'latency_high', 'demo drill: users report slow file copies');
  const acts2 = await diagnose(i2);
  log(`incident 2: ${acts2.filter((x) => x.status === 'awaiting_approval').length} action(s) waiting in the approvals queue`);

  // 4 · interface-down drill → refresh proposed but rejected by policy (privileged mode is off)
  const i3 = await testIncident(a, 'vpn_interface_down', 'demo drill: interface reported down');
  const acts3 = await diagnose(i3);
  log(`incident 3: ${acts3.filter((x) => x.status === 'rejected_by_policy').length} action(s) rejected by policy`);

  // 5 · device-page action: connectivity test to the control plane, approved and verified
  const req = await api('POST', `/devices/${b.id}/actions`, { actionType: 'run_connectivity_test', params: { target: 'control_plane', count: 5 } });
  const action = req.action || req;
  if (action.status === 'awaiting_approval') {
    await api('POST', `/actions/${action.id}/approve`, { reason: 'demo: control channel check' });
    log('device action: connectivity test to the control plane approved');
  }

  console.log('\n  scenarios done — every console page now has data.');
}

// ── remove ───────────────────────────────────────────────────────────
async function remove() {
  const mongoose = require('mongoose');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nexlink');
  const db = mongoose.connection.db;
  const nets = await db.collection('networks').find({ name: { $in: NETWORKS.map((n) => n.name) } }).toArray();
  const netIds = nets.map((n) => n._id);
  const devIds = (await db.collection('devices').find({ networkId: { $in: netIds } }).project({ _id: 1 }).toArray()).map((d) => d._id);
  const byDev = { $or: [{ deviceId: { $in: devIds } }, { peerDeviceId: { $in: devIds } }] };
  const byNet = { networkId: { $in: netIds } };
  // Approvals and diagnostic runs carry no networkId: reach them through their action / incident.
  const ids = async (c, q) => (await db.collection(c).find(q).project({ _id: 1 }).toArray()).map((x) => x._id);
  const actionIds = await ids('proposedactions', byNet);
  const incidentIds = await ids('incidents', byNet);
  const plan = [
    ['heartbeats', byDev], ['measurements', byDev], ['peerobservations', byDev], ['agentevents', byDev],
    ['agentcommands', byDev], ['agentnonces', byDev], ['enrollmenttokens', byDev], ['memberships', byDev],
    ['approvals', { actionId: { $in: actionIds } }], ['diagnosticruns', { incidentId: { $in: incidentIds } }],
    ['proposedactions', byNet], ['incidents', byNet],
    ['devices', { _id: { $in: devIds } }], ['networks', { _id: { $in: netIds } }],
  ];
  for (const [c, q] of plan) {
    const n = (await db.collection(c).deleteMany(q)).deletedCount;
    if (n) log(`${c}: ${n}`);
  }
  await mongoose.disconnect();
  fs.rmSync(STATE, { recursive: true, force: true });
  log('demo networks, devices and agent keys removed (the audit log keeps its records — it is append-only)');
}

const cmd = process.argv[2];
const run = { setup: async () => (await login(), setup()), scenarios: async () => (await login(), scenarios()), remove }[cmd];
if (!run) {
  console.log('usage: node scripts/seed-demo.js setup | scenarios | remove');
  process.exit(1);
}
run().catch((err) => {
  console.error(`\n  ✗ ${err.message}`);
  process.exit(1);
});
