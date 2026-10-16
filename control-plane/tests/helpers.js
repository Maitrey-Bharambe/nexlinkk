'use strict';

/**
 * Test harness. Uses a throwaway mongod (mongodb-memory-server) and a
 * simulated agent that performs the real enrollment + signing protocol with
 * genuine Ed25519/X25519 keys. Category: "simulated test fixture" — no
 * WireGuard interface or host networking is touched.
 */
const crypto = require('node:crypto');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { loadConfig } = require('../src/config/env');
const { createLogger } = require('../src/config/logger');
const { connectDatabase } = require('../src/database');
const { createApp } = require('../src/app');
const { User } = require('../src/database/models/identity');
const { hashPassword } = require('../src/modules/auth/passwords');
const { canonicalRequest } = require('../src/middleware/agentAuth');
const { enrollmentMessage } = require('../src/modules/enrollment/enrollment.service');
const { sha256Hex } = require('../src/utils/crypto');

const PASSWORD = 'correct-horse-battery-staple';

async function setup(overrides = {}) {
  const mongod = await MongoMemoryServer.create();
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: mongod.getUri('nexlink_test'),
    PASSWORD_SCRYPT_N: '16384',
    INCIDENT_DETECTOR_INTERVAL_SECONDS: '0',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  const logger = createLogger('silent');
  await connectDatabase(config.MONGODB_URI);
  const app = createApp({ config, logger });
  return {
    app,
    config,
    async teardown() {
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}

async function createUser(config, { email, role, displayName }) {
  return User.create({ email, role, displayName: displayName || email, passwordHash: await hashPassword(PASSWORD, config.PASSWORD_SCRYPT_N) });
}

/** Logs in and returns a client that carries the session cookie and CSRF token. */
async function login(app, email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    agent,
    csrf,
    get: (url) => agent.get(url),
    post: (url, body = {}) => agent.post(url).set('x-csrf-token', csrf).send(body),
    del: (url) => agent.delete(url).set('x-csrf-token', csrf),
  };
}

const b64 = (b64url) => Buffer.from(b64url, 'base64url').toString('base64');

/** A software agent speaking the real NexLink agent protocol. */
class FakeAgent {
  constructor(app) {
    this.app = app;
    const id = crypto.generateKeyPairSync('ed25519');
    this.identityPrivate = id.privateKey;
    this.identityPublicKey = b64(id.publicKey.export({ format: 'jwk' }).x);
    const wg = crypto.generateKeyPairSync('x25519');
    this.wireguardPublicKey = b64(wg.publicKey.export({ format: 'jwk' }).x);
    this.bootId = crypto.randomBytes(8).toString('hex');
    this.sequence = 0;
    this.deviceId = null;
  }

  sign(message) {
    return crypto.sign(null, Buffer.from(message), this.identityPrivate).toString('base64');
  }

  enrollBody(token, overrides = {}) {
    const timestamp = Date.now();
    const signature = this.sign(
      enrollmentMessage({ tokenHash: sha256Hex(token), identityPublicKey: this.identityPublicKey, wireguardPublicKey: this.wireguardPublicKey, timestamp }),
    );
    return {
      enrollmentToken: token,
      identityPublicKey: this.identityPublicKey,
      wireguardPublicKey: this.wireguardPublicKey,
      agentVersion: '0.1.0-test',
      platform: 'test',
      timestamp,
      signature,
      ...overrides,
    };
  }

  async enroll(token) {
    const res = await request(this.app).post('/api/v1/agent/enroll').send(this.enrollBody(token));
    if (res.status === 201) this.deviceId = res.body.data.deviceId;
    return res;
  }

  /** Signed request. `tamper` lets tests alter parts after signing. */
  signed(method, path, body, { nonce, timestamp, deviceId, tamper } = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = timestamp ?? Date.now();
    const n = nonce ?? crypto.randomBytes(16).toString('base64url');
    const dev = deviceId ?? this.deviceId;
    const sig = this.sign(canonicalRequest({ method, path, timestamp: ts, nonce: n, deviceId: dev, body: Buffer.from(raw) }));
    let req = request(this.app)[method.toLowerCase()](path)
      .set('x-nexlink-device', dev)
      .set('x-nexlink-timestamp', String(ts))
      .set('x-nexlink-nonce', n)
      .set('x-nexlink-signature', sig);
    if (body !== undefined) req = req.set('content-type', 'application/json').send(tamper ? tamper(raw) : raw);
    return req;
  }

  heartbeat(overrides = {}) {
    this.sequence += 1;
    return this.signed('POST', '/api/v1/agent/heartbeat', {
      schemaVersion: 1,
      deviceId: this.deviceId,
      bootId: this.bootId,
      sequence: this.sequence,
      agentTime: new Date().toISOString(),
      agentVersion: '0.1.0-test',
      health: { status: 'ok', details: [] },
      vpnInterface: { name: 'nx0', state: 'up' },
      capabilities: ['telemetry', 'connectivity_probe', 'wireguard_inspect'],
      ...overrides,
    });
  }

  telemetry({ state = 'up', source = 'wgctrl', peers = [], measurements = [], publicKey } = {}) {
    return this.signed('POST', '/api/v1/agent/telemetry', {
      schemaVersion: 1,
      deviceId: this.deviceId,
      measuredAt: new Date().toISOString(),
      interface: { name: 'nx0', state, listenPort: 51820, publicKey: publicKey ?? this.wireguardPublicKey, appliedConfigVersion: null, source },
      peers,
      endpointCandidates: ['192.168.1.20:51820'],
      measurements,
    });
  }
}

/** Creates a network + N enrolled fake agents. */
async function networkWithAgents(app, client, { name = 'lab', cidr = '10.77.0.0/24', count = 2 } = {}) {
  const net = await client.post('/api/v1/networks', { name, cidr });
  if (net.status !== 201) throw new Error(`network create failed ${JSON.stringify(net.body)}`);
  const agents = [];
  for (let i = 0; i < count; i++) {
    const er = await client.post('/api/v1/devices/enrollment-requests', { networkId: net.body.data.id, name: `node-${i}` });
    const a = new FakeAgent(app);
    const res = await a.enroll(er.body.data.enrollment.token);
    if (res.status !== 201) throw new Error(`enroll failed ${JSON.stringify(res.body)}`);
    a.address = res.body.data.address;
    agents.push(a);
  }
  return { networkId: net.body.data.id, agents };
}

module.exports = { setup, createUser, login, FakeAgent, networkWithAgents, PASSWORD };
