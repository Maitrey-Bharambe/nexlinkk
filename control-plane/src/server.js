'use strict';

require('dotenv').config();
const http = require('node:http');
const { loadConfig } = require('./config/env');
const { createLogger } = require('./config/logger');
const { connectDatabase, disconnectDatabase } = require('./database');
const { createApp } = require('./app');
const { attachRealtime } = require('./sockets');
const { startDetector } = require('./modules/incidents/detector');
const { sweepTimedOutCommands } = require('./modules/approvals/actions.service');

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  await connectDatabase(config.MONGODB_URI, logger);

  const app = createApp({ config, logger });
  const server = http.createServer(app);
  const realtime = attachRealtime(server, { config, logger });
  app.locals.realtime = realtime;

  const stopDetector = startDetector({ config, logger, realtime });
  const sweeper = setInterval(() => {
    sweepTimedOutCommands({ config, realtime }).catch((err) => logger.error({ err }, 'command sweep failed'));
  }, 10_000);
  sweeper.unref();

  server.listen(config.PORT, () => logger.info({ port: config.PORT }, 'control plane listening'));

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    stopDetector();
    clearInterval(sweeper);
    realtime.close();
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err.message);
  process.exit(1);
});
