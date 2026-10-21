'use strict';

/**
 * NexLink in one process: the Next.js console, the REST API (/api/v1), the
 * agent API, Socket.IO live updates and the encrypted agent relay all share
 * one HTTP server and one port. One thing to run, one thing to deploy.
 *
 *   npm run dev          development (embedded MongoDB if MONGODB_URI is unset)
 *   npm run build && npm start     production (needs MONGODB_URI)
 */
if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';
require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });

const http = require('node:http');
const { EventEmitter } = require('node:events');
const next = require('next');
const { loadConfig } = require('./server/config/env');
const { createLogger } = require('./server/config/logger');
const { connectDatabase, disconnectDatabase } = require('./server/database');
const { resolveMongoUri } = require('./server/database/devMongo');
const { createApp } = require('./server/app');
const { attachRealtime } = require('./server/sockets');
const { createRelay, RELAY_PATH } = require('./server/modules/relay/relay');
const { startDetector } = require('./server/modules/incidents/detector');
const { sweepTimedOutCommands } = require('./server/modules/approvals/actions.service');
const { ensureDiagnosticService } = require('./server/modules/insights/diagnosticProcess');
const { startBriefings } = require('./server/modules/insights/insights.service');

const isApi = (url) => url.startsWith('/api/') || url === '/healthz';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const mongo = await resolveMongoUri(config, logger);
  await connectDatabase(mongo.uri, logger);
  // Before createApp: may enable DIAGNOSTIC_SERVICE_URL for the dev AI service.
  const stopAi = await ensureDiagnosticService(config, logger);

  // Next attaches its own upgrade listener to `httpServer` (on the first
  // request). A placeholder keeps it off the real server so it cannot close
  // our WebSocket upgrades; /_next/ upgrades (dev HMR) are forwarded to it.
  // Not web.getUpgradeHandler(): in a dev custom server that is not the HMR
  // handler, and an HMR socket left hanging in "connecting" makes Chromium
  // queue every other WebSocket to this host (Socket.IO) behind it.
  const nextUpgrades = new EventEmitter();
  const web = next({ dev: !config.isProduction, dir: __dirname, httpServer: nextUpgrades, quiet: config.isProduction });
  await web.prepare();
  const handleWeb = web.getRequestHandler();

  const api = createApp({ config, logger });
  const server = http.createServer((req, res) => (isApi(req.url) ? api(req, res) : handleWeb(req, res)));

  const realtime = attachRealtime(server, { config, logger });
  api.locals.realtime = realtime;
  const relay = createRelay({ config, logger });
  api.locals.relay = relay;

  server.on('upgrade', (req, socket, head) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/socket.io/')) return; // Socket.IO's own listener
    if (path === RELAY_PATH) return relay.handleUpgrade(req, socket, head);
    if (path.startsWith('/_next/') && nextUpgrades.listenerCount('upgrade')) return nextUpgrades.emit('upgrade', req, socket, head);
    socket.destroy();
  });

  const stopDetector = startDetector({ config, logger, realtime });
  const stopBriefings = startBriefings({ config, logger, realtime });
  const sweeper = setInterval(() => {
    sweepTimedOutCommands({ config, realtime }).catch((err) => logger.error({ err }, 'command sweep failed'));
  }, 10_000);
  sweeper.unref();

  server.listen(config.PORT, config.HOST, () => {
    logger.info(
      { port: config.PORT, publicUrl: config.PUBLIC_URL || null, mode: config.isProduction ? 'production' : 'development' },
      `NexLink ready on http://localhost:${config.PORT}`,
    );
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    stopDetector();
    stopBriefings();
    stopAi();
    clearInterval(sweeper);
    relay.close();
    realtime.close();
    server.close();
    await disconnectDatabase();
    await mongo.stop();
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
