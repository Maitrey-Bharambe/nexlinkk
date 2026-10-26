'use strict';

const { rateLimit } = require('express-rate-limit');

const handler = (req, res) =>
  res.status(429).json({
    ok: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down', requestId: req.id },
  });

/**
 * Client address for rate-limit keys. Some proxies (Azure App Service) append
 * the client's source port to X-Forwarded-For ("1.2.3.4:5678", "[::1]:5678");
 * the port changes per connection, so it must not be part of the key.
 */
function clientKey(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const v6 = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  const v4 = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return v4 ? v4[1] : ip;
}

function createRateLimits() {
  const base = { standardHeaders: 'draft-7', legacyHeaders: false, handler, keyGenerator: clientKey };
  return {
    api: rateLimit({ ...base, windowMs: 60_000, limit: 600 }),
    login: rateLimit({
      ...base,
      windowMs: 15 * 60_000,
      limit: 10,
      keyGenerator: (req) => `${clientKey(req)}|${String(req.body?.email || '').toLowerCase().slice(0, 254)}`,
    }),
    signup: rateLimit({ ...base, windowMs: 60 * 60_000, limit: 10 }),
    enrollment: rateLimit({ ...base, windowMs: 15 * 60_000, limit: 20 }),
    sensitive: rateLimit({ ...base, windowMs: 60_000, limit: 30 }),
    agent: rateLimit({ ...base, windowMs: 60_000, limit: 240 }),
  };
}

module.exports = { createRateLimits, clientKey };
