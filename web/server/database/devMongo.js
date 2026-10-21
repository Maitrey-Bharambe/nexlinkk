'use strict';

const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const DEV_PORT = 27017;
const DEV_URI = `mongodb://127.0.0.1:${DEV_PORT}/nexlink`;

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.setTimeout(400);
    s.once('connect', () => s.destroy() || resolve(true));
    s.once('timeout', () => s.destroy() || resolve(false));
    s.once('error', () => resolve(false));
  });
}

/**
 * Where MongoDB is. MONGODB_URI wins. Without it, development uses whatever
 * already listens on 127.0.0.1:27017, or starts an embedded mongod with data
 * in .data/mongo — so `npm run dev` is the only command a developer needs.
 * Production never guesses: it requires MONGODB_URI.
 */
async function resolveMongoUri(config, logger) {
  if (config.MONGODB_URI) return { uri: config.MONGODB_URI, stop: async () => {} };
  if (config.isProduction) throw new Error('MONGODB_URI is required in production (MongoDB Atlas, a managed instance, or the compose service)');
  if (await portOpen(DEV_PORT)) {
    logger?.info({ uri: DEV_URI }, 'using the MongoDB already running on this machine');
    return { uri: DEV_URI, stop: async () => {} };
  }
  // Dev dependency: loaded only on this path.
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const dbPath = path.join(__dirname, '..', '..', '.data', 'mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  logger?.info({ dbPath }, 'starting embedded MongoDB (first run downloads it)');
  const server = await MongoMemoryServer.create({
    instance: { port: DEV_PORT, ip: '127.0.0.1', dbPath, storageEngine: 'wiredTiger' },
  });
  return { uri: DEV_URI, stop: () => server.stop({ doCleanup: false }) };
}

module.exports = { resolveMongoUri, portOpen, DEV_URI };
