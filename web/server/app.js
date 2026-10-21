'use strict';

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const crypto = require('node:crypto');

const { attachUser, requireUser } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { createRateLimits } = require('./middleware/rateLimits');
const { badRequest } = require('./utils/errors');
const { authRouter } = require('./modules/auth/auth.routes');
const { networksRouter } = require('./modules/networks/networks.routes');
const { devicesRouter } = require('./modules/devices/devices.routes');
const { agentRouter } = require('./modules/agent/agent.routes');
const { incidentsRouter } = require('./modules/incidents/incidents.routes');
const { approvalsRouter } = require('./modules/approvals/approvals.routes');
const { auditRouter } = require('./modules/audit/audit.routes');
const { topologyRouter } = require('./modules/topology/topology.routes');
const { onboardingRouter } = require('./modules/onboarding/onboarding.routes');
const { insightsRouter } = require('./modules/insights/insights.routes');

function createApp({ config, logger }) {
  const app = express();
  const limits = createRateLimits();
  const deps = { config, logger, limits };

  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  // No CORS: the console is served by this same process, so every browser
  // call is same-origin and the session cookie stays SameSite=Strict.

  // Liveness of this process only — says nothing about any VPN tunnel.
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'nexlink' }));
  // Public facts the console needs to build join commands and invite links.
  app.get('/api/v1/meta', (_req, res) =>
    res.json({ ok: true, data: { publicUrl: config.PUBLIC_URL || null, relay: config.RELAY_ENABLED } }),
  );

  // Agent API: own parser (raw body for signatures) and own auth; no cookies.
  app.use('/api/v1/agent', agentRouter(deps));

  // User API.
  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));
  api.use((req, _res, next) => {
    // JSON-only writes: a cross-site HTML form cannot send application/json.
    // req.is() is null when there is no body, false when the type mismatches.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.is('application/json') === false) {
      return next(badRequest('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    }
    next();
  });
  api.use(cookieParser());
  api.use(limits.api);
  api.use(attachUser);
  api.use(authRouter(deps));
  api.use(requireUser);
  api.use(networksRouter(deps));
  api.use(devicesRouter(deps));
  api.use(incidentsRouter(deps));
  api.use(approvalsRouter(deps));
  api.use(auditRouter(deps));
  api.use(topologyRouter(deps));
  api.use(onboardingRouter(deps));
  api.use(insightsRouter(deps));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
