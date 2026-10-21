'use strict';

/**
 * DEVELOPMENT ONLY: runs a real mongod binary (downloaded by
 * mongodb-memory-server) on 127.0.0.1:27017 with data persisted to ./.data,
 * for machines without MongoDB installed or Docker running.
 * Use a proper MongoDB deployment (local service, Docker, or Atlas) otherwise.
 */
const path = require('node:path');
const fs = require('node:fs');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  const dbPath = path.join(__dirname, '..', '.data', 'mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  const port = Number(process.env.DEV_MONGO_PORT || 27017);
  const server = await MongoMemoryServer.create({
    instance: { port, ip: '127.0.0.1', dbPath, storageEngine: 'wiredTiger' },
  });
  console.log(`dev mongod listening: ${server.getUri()}  (data: ${dbPath})`);
  console.log('Set MONGODB_URI=mongodb://127.0.0.1:%d/nexlink — Ctrl+C to stop', port);
  const stop = async () => {
    await server.stop({ doCleanup: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
