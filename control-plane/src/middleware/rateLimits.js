'use strict';

const { rateLimit } = require('express-rate-limit');

const handler = (req, res) =>
  res.status(429).json({
    ok: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down', requestId: req.id },
  });

function createRateLimits() {
  const base = { standardHeaders: 'draft-7', legacyHeaders: false, handler };
  return {
    api: rateLimit({ ...base, windowMs: 60_000, limit: 600 }),
    login: rateLimit({
      ...base,
      windowMs: 15 * 60_000,
      limit: 10,
      keyGenerator: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase().slice(0, 254)}`,
    }),
    signup: rateLimit({ ...base, windowMs: 60 * 60_000, limit: 10 }),
    enrollment: rateLimit({ ...base, windowMs: 15 * 60_000, limit: 20 }),
    sensitive: rateLimit({ ...base, windowMs: 60_000, limit: 30 }),
    agent: rateLimit({ ...base, windowMs: 60_000, limit: 240 }),
  };
}

module.exports = { createRateLimits };
