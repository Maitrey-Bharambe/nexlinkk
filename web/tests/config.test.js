'use strict';

// Category: unit-tested behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../server/config/env');
const { resolveMongoUri } = require('../server/database/devMongo');

test('one port by default, PUBLIC_URL normalised, relay on unless disabled', () => {
  const c = loadConfig({ PUBLIC_URL: 'https://nexlink.example.com/' });
  assert.equal(c.PORT, 3000);
  assert.equal(c.PUBLIC_URL, 'https://nexlink.example.com');
  assert.equal(c.RELAY_ENABLED, true);
  assert.equal(loadConfig({ RELAY_ENABLED: 'false' }).RELAY_ENABLED, false);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'not a url' }), /PUBLIC_URL/);
});

test('production never guesses a database', async () => {
  const prod = loadConfig({ NODE_ENV: 'production', MONGODB_URI: '' });
  await assert.rejects(() => resolveMongoUri({ ...prod, MONGODB_URI: undefined }), /MONGODB_URI is required/);
  const explicit = await resolveMongoUri(loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://db.internal/nexlink' }));
  assert.equal(explicit.uri, 'mongodb://db.internal/nexlink');
});
