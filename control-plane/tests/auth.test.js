'use strict';

// Category: integration against a real (ephemeral) MongoDB, in-process HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, createUser, login } = require('./helpers');
const { AuditEvent } = require('../src/database/models/audit');
const { Session } = require('../src/database/models/identity');

let ctx;
test.before(async () => {
  ctx = await setup();
  await createUser(ctx.config, { email: 'admin@nx.test', role: 'admin' });
  await createUser(ctx.config, { email: 'op@nx.test', role: 'operator' });
  await createUser(ctx.config, { email: 'viewer@nx.test', role: 'viewer' });
  await createUser(ctx.config, { email: 'lock@nx.test', role: 'viewer' });
});
test.after(() => ctx.teardown());

test('login sets an HttpOnly SameSite=Strict cookie and returns no token in the body', async () => {
  const res = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'admin@nx.test', password: 'correct-horse-battery-staple' });
  assert.equal(res.status, 200);
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /nx_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(JSON.stringify(res.body).includes(cookie.split(';')[0].split('=')[1]), false);
  const stored = await Session.findOne().lean();
  assert.notEqual(stored.tokenHash, cookie.split(';')[0].split('=')[1], 'only the hash is stored');
});

test('wrong password and unknown user give the same generic error and are audited', async () => {
  const a = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'admin@nx.test', password: 'nope-nope-nope' });
  const b = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'ghost@nx.test', password: 'nope-nope-nope' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error.code, b.body.error.code);
  assert.ok(await AuditEvent.exists({ operation: 'auth.login', decision: 'deny' }));
});

test('account locks after repeated failures', async () => {
  for (let i = 0; i < 5; i++) {
    await request(ctx.app).post('/api/v1/auth/login').send({ email: 'lock@nx.test', password: 'bad-password-x' });
  }
  const res = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'lock@nx.test', password: 'correct-horse-battery-staple' });
  assert.equal(res.status, 401, 'correct password refused while locked');
});

test('unauthenticated requests are rejected', async () => {
  const res = await request(ctx.app).get('/api/v1/networks');
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test('state-changing requests require the CSRF token', async () => {
  const c = await login(ctx.app, 'admin@nx.test');
  const noToken = await c.agent.post('/api/v1/networks').send({ name: 'x', cidr: '10.9.0.0/24' });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.error.code, 'CSRF_TOKEN_INVALID');
  const wrong = await c.agent.post('/api/v1/networks').set('x-csrf-token', 'forged').send({ name: 'x', cidr: '10.9.0.0/24' });
  assert.equal(wrong.status, 403);
});

test('non-JSON writes are refused', async () => {
  const c = await login(ctx.app, 'admin@nx.test');
  const res = await c.agent.post('/api/v1/networks').set('x-csrf-token', c.csrf).type('form').send('name=x&cidr=10.9.0.0/24');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('RBAC is enforced in the backend', async () => {
  const viewer = await login(ctx.app, 'viewer@nx.test');
  const res = await viewer.post('/api/v1/networks', { name: 'v-net', cidr: '10.10.0.0/24' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'PERMISSION_DENIED');
  assert.ok(await AuditEvent.exists({ operation: 'permission.denied', 'actor.label': 'viewer@nx.test' }));

  const op = await login(ctx.app, 'op@nx.test');
  assert.equal((await op.get('/api/v1/users')).status, 403);
  assert.equal((await op.post('/api/v1/users', { email: 'x@nx.test', displayName: 'x', password: 'long-enough-password', role: 'admin' })).status, 403);
});

test('admin can create users; mass-assignment fields are rejected', async () => {
  const admin = await login(ctx.app, 'admin@nx.test');
  const extra = await admin.post('/api/v1/users', {
    email: 'new@nx.test',
    displayName: 'New',
    password: 'long-enough-password',
    role: 'viewer',
    passwordHash: 'x',
  });
  assert.equal(extra.status, 400, 'unknown field rejected');
  const ok = await admin.post('/api/v1/users', { email: 'new@nx.test', displayName: 'New', password: 'long-enough-password', role: 'viewer' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.passwordHash, undefined);
});

test('me + logout invalidates the session server-side', async () => {
  const c = await login(ctx.app, 'op@nx.test');
  const me = await c.get('/api/v1/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.role, 'operator');
  assert.ok(me.body.data.user.permissions.includes('devices:enroll'));
  assert.equal((await c.post('/api/v1/auth/logout')).status, 200);
  assert.equal((await c.get('/api/v1/auth/me')).status, 401);
});
