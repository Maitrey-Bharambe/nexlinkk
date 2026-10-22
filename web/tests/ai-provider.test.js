'use strict';

// Category: integration (ephemeral MongoDB) + a stub OpenAI-compatible server
// standing in for Groq. Checks the built-in provider: one deployable app,
// same grounding rules, nothing secret sent or echoed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, createUser, login, networkWithAgents } = require('./helpers');

const KEY = 'gsk_test_key_never_echoed_123';
let ctx;
let op;
let net;
let stub;
let last = null;
let fail = false;

test.before(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      last = { auth: req.headers.authorization, path: req.url, body: JSON.parse(raw) };
      res.setHeader('content-type', 'application/json');
      if (fail) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: `invalid api key ${KEY}` } }));
      }
      const user = JSON.parse(last.body.messages[1].content);
      const ref = user.evidence[0].ref;
      const content = JSON.stringify({
        incident_id: user.incident.id,
        summary: 'Two devices enrolled, no handshake yet.',
        observations: [{ statement: 'The network has two enrolled devices.', evidence_refs: [ref] }],
        hypotheses: [],
        evidence: [ref],
        uncertainties: [],
        proposed_actions: [],
        requires_human_approval: true,
      });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  ctx = await setup({ GROQ_API_KEY: KEY, GROQ_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1`, BRIEFING_INTERVAL_MINUTES: '0' });
  await createUser(ctx.config, { email: 'ai-op@nx.test', role: 'operator' });
  op = await login(ctx.app, 'ai-op@nx.test');
  net = await networkWithAgents(ctx.app, op, { name: 'ai-lab', cidr: '10.99.0.0/24', count: 2 });
});
test.after(async () => {
  await new Promise((r) => stub.close(r));
  await ctx.teardown();
});

test('built-in provider works with no diagnostic service configured', async () => {
  assert.equal(ctx.config.DIAGNOSTIC_SERVICE_URL, undefined);
  const view = await op.get('/api/v1/insights');
  assert.equal(view.body.data.ai.configured, true);
  assert.equal(view.body.data.ai.provider, 'built-in');

  const res = await op.post('/api/v1/insights/briefings', { networkId: net.networkId });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'completed');
  assert.match(res.body.data.provider, /^groq:/);
  assert.equal(last.path, '/v1/chat/completions');
  assert.equal(last.auth, `Bearer ${KEY}`);
  assert.equal(last.body.response_format.type, 'json_object');
  const sent = JSON.parse(last.body.messages[1].content);
  assert.deepEqual(sent.allowed_actions, [], 'briefings offer the model no actions');
  assert.ok(sent.evidence.every((e) => !('data' in e)), 'raw data payloads never leave the app');
});

test('incident diagnosis can use the built-in provider too', async () => {
  const reg = await op.get('/api/v1/diagnostics/registry');
  assert.equal(reg.body.data.llmProviderConfigured, true);
});

test('upstream errors are recorded without the API key', async () => {
  fail = true;
  const res = await op.post('/api/v1/insights/briefings', { networkId: net.networkId });
  fail = false;
  assert.equal(res.body.data.status, 'failed');
  assert.match(res.body.data.error, /groq HTTP 401/);
  assert.ok(!res.body.data.error.includes(KEY), 'key must be redacted');
});
