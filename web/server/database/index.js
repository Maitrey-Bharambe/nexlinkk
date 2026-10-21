'use strict';

const mongoose = require('mongoose');

const models = {
  ...require('./models/identity'),
  ...require('./models/network'),
  ...require('./models/device'),
  ...require('./models/telemetry'),
  ...require('./models/incidents'),
  ...require('./models/audit'),
};

// Unknown filter keys are rejected instead of silently matching everything.
// Operator injection is prevented at the trust boundary: every request value is
// parsed by a zod schema into scalars before it can reach a query, so a value
// like {"$ne": null} never arrives where a string/ObjectId is expected.
mongoose.set('strictQuery', true);

async function connectDatabase(uri, logger) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  // Build declared indexes (unique / partial / TTL). These are the schema
  // "migrations" for MongoDB: they enforce the integrity constraints.
  await syncIndexes();
  logger?.info({ db: mongoose.connection.name }, 'mongodb connected, indexes synced');
  return mongoose.connection;
}

async function syncIndexes() {
  for (const m of Object.values(models)) {
    if (m && m.prototype instanceof mongoose.Model) await m.syncIndexes();
  }
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

module.exports = { connectDatabase, disconnectDatabase, syncIndexes, models, mongoose };
