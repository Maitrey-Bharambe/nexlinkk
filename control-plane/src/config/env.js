'use strict';

const { z } = require('zod');

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/nexlink'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  ALLOW_SIGNUP: bool.default('true'),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(168).default(12),
  PASSWORD_SCRYPT_N: z.coerce.number().int().min(16384).default(131072),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

  ENROLLMENT_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  AGENT_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(5).max(600).default(120),
  HANDSHAKE_FRESH_SECONDS: z.coerce.number().int().min(30).default(180),

  MEASUREMENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  HEARTBEAT_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(3),

  INCIDENT_DETECTOR_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(30),
  DIAGNOSTIC_SERVICE_URL: z.string().url().optional(),
  DIAGNOSTIC_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(15000),
});

/**
 * Validates configuration from the environment. Invalid configuration aborts
 * startup instead of silently falling back to unsafe defaults.
 */
function loadConfig(overrides = {}) {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  return {
    ...c,
    isProduction: c.NODE_ENV === 'production',
    corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
  };
}

module.exports = { loadConfig };
