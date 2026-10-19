'use strict';

// Category: unit-tested behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config/env');

test('LAN origins are only accepted when CORS_ALLOW_PRIVATE_LAN is on', () => {
  const strict = loadConfig({ CORS_ORIGINS: 'http://localhost:3000', CORS_ALLOW_PRIVATE_LAN: 'false' });
  assert.equal(strict.isAllowedOrigin('http://localhost:3000'), true);
  assert.equal(strict.isAllowedOrigin(undefined), true, 'same-origin / non-browser requests');
  assert.equal(strict.isAllowedOrigin('http://192.168.0.105:3000'), false);

  const lan = loadConfig({ CORS_ORIGINS: 'http://localhost:3000', CORS_ALLOW_PRIVATE_LAN: 'true' });
  for (const ok of ['http://192.168.0.105:3000', 'http://10.1.2.3:3000', 'http://172.20.0.5:3000']) {
    assert.equal(lan.isAllowedOrigin(ok), true, ok);
  }
  for (const bad of ['http://8.8.8.8:3000', 'http://192.168.0.105.evil.com:3000', 'https://example.com', 'http://172.32.0.1:3000', 'http://1921680105:3000']) {
    assert.equal(lan.isAllowedOrigin(bad), false, bad);
  }
});
