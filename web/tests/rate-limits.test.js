'use strict';

// Category: unit. Rate-limit keys ignore the source port some proxies append.
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientKey } = require('../server/middleware/rateLimits');

test('client key strips a proxy-appended port and keeps plain addresses', () => {
  const key = (ip) => clientKey({ ip });
  assert.equal(key('106.192.50.188:49668'), '106.192.50.188');
  assert.equal(key('106.192.50.188'), '106.192.50.188');
  assert.equal(key('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(key('2001:db8::1'), '2001:db8::1');
  assert.equal(key('::ffff:10.0.0.5'), '::ffff:10.0.0.5');
  assert.equal(key('106.192.50.188:1'), key('106.192.50.188:65000'), 'same client, different ports → same key');
});
