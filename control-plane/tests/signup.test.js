'use strict';

// Category: integration against a real (ephemeral) MongoDB, in-process HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, FakeAgent } = require('./helpers');
const { AuditEvent } = require('../src/database/models/audit');
const { Network } = require('../src/database/models/network');
const { createApp } = require('../src/app');
const { createLogger } = require('../src/config/logger');

let ctx;
test.before(async () => {
  ctx = await setup();
});
test.after(() => ctx.teardown());

async function signup(body) {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/v1/auth/signup').send(body);
  const csrf = res.body?.data?.csrfToken;
  return {
    res,
    agent,
    post: (url, b = {}) => agent.post(url).set('x-csrf-token', csrf).send(b),
    get: (url) => agent.get(url),
  };
}

const PW = 'a-long-enough-password';

test('first signup bootstraps an admin and signs them in', async () => {
  const { res, get } = await signup({ email: 'first@nx.test', displayName: 'First', password: PW });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user.role, 'admin');
  assert.match(res.headers['set-cookie'][0], /nx_session=.*HttpOnly/);
  assert.equal((await get('/api/v1/auth/me')).status, 200);
  assert.ok(await AuditEvent.exists({ operation: 'auth.signup', decision: 'allow' }));
});

test('later signups are operators; role in the body is rejected', async () => {
  const sneaky = await signup({ email: 'eve@nx.test', displayName: 'Eve', password: PW, role: 'admin' });
  assert.equal(sneaky.res.status, 400, 'unknown field "role" rejected');
  const { res } = await signup({ email: 'maya@nx.test', displayName: 'Maya', password: PW });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.user.role, 'operator');
});

test('duplicate email and weak passwords are rejected', async () => {
  const dup = await signup({ email: 'MAYA@nx.test', displayName: 'Maya 2', password: PW });
  assert.equal(dup.res.status, 409);
  assert.equal(dup.res.body.error.code, 'EMAIL_TAKEN');
  const weak = await signup({ email: 'weak@nx.test', displayName: 'Weak', password: 'short' });
  assert.equal(weak.res.status, 400);
});

test('register-this-PC creates a private network on first use and issues a one-time token', async () => {
  const s = await signup({ email: 'raj@nx.test', displayName: "Raj's Lab", password: PW });
  const first = await s.post('/api/v1/onboarding/register-device', { deviceName: 'raj-laptop' });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.createdNetwork, true);
  assert.match(first.body.data.network.cidr, /^10\.\d+\.0\.0\/24$/);
  assert.equal(first.body.data.network.name, 'raj-s-lab-net');
  assert.equal(first.body.data.device.enrollmentState, 'pending');
  assert.match(first.body.data.enrollment.token, /^nxe_/);
  assert.equal(first.headers['cache-control'], 'no-store');

  // Second PC reuses the same network.
  const second = await s.post('/api/v1/onboarding/register-device', { deviceName: 'raj-desktop' });
  assert.equal(second.body.data.createdNetwork, false);
  assert.equal(second.body.data.network.id, first.body.data.network.id);

  // The PC is "registered" only once the agent enrolls with the token.
  const agent = new FakeAgent(ctx.app);
  const enrolled = await agent.enroll(first.body.data.enrollment.token);
  assert.equal(enrolled.status, 201);
  const dev = (await s.get(`/api/v1/devices/${first.body.data.device.id}`)).body.data;
  assert.equal(dev.enrollmentState, 'enrolled');
  assert.equal(dev.membership.address, enrolled.body.data.address);
});

test('each user gets a distinct, non-overlapping range and cannot see others', async () => {
  const a = await signup({ email: 'a@nx.test', displayName: 'A', password: PW });
  const b = await signup({ email: 'b@nx.test', displayName: 'B', password: PW });
  const na = (await a.post('/api/v1/onboarding/register-device', { deviceName: 'a-pc' })).body.data.network;
  const nb = (await b.post('/api/v1/onboarding/register-device', { deviceName: 'b-pc' })).body.data.network;
  assert.notEqual(na.cidr, nb.cidr);
  assert.equal((await a.get(`/api/v1/networks/${nb.id}`)).status, 404);
  assert.equal(await Network.countDocuments({ cidr: na.cidr, status: 'active' }), 1);
});

test('signup can be disabled', async () => {
  // Same database connection, different config.
  const app = createApp({ config: { ...ctx.config, ALLOW_SIGNUP: false }, logger: createLogger('silent') });
  const res = await request(app).post('/api/v1/auth/signup').send({ email: 'x@nx.test', displayName: 'X', password: PW });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'SIGNUP_DISABLED');
});
