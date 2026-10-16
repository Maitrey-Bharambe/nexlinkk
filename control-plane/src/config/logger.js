'use strict';

const pino = require('pino');

// Anything that can carry a credential is redacted before it reaches a log sink.
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-nexlink-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.enrollmentToken',
  '*.csrfToken',
  '*.privateKey',
];

function createLogger(level = 'info') {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'nexlink-control-plane' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger, REDACT_PATHS };
