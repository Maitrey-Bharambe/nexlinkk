'use strict';

const { z } = require('zod');

// An empty `KEY=` line in .env means "not set".
const optional = (t) => z.preprocess((v) => (v === '' ? undefined : v), t.optional());

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // One port serves everything: console pages, REST API, Socket.IO, agent relay.
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Unset in development = an embedded MongoDB is started under .data/mongo.
  // Required in production (Atlas, a managed instance, or the compose service).
  MONGODB_URI: optional(z.string().min(1)),
  // The address agents and invited PCs use to reach this server, e.g.
  // https://nexlink.example.com. Unset = taken from each request's Host header.
  PUBLIC_URL: optional(
    z
      .string()
      .url()
      .transform((u) => u.replace(/\/+$/, '')),
  ),
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
  // Development: start diagnostic-service/.venv automatically when it is not running.
  AI_AUTOSTART: bool.default('true'),
  // AI network briefings: re-evaluated on this interval, regenerated only when
  // the network's observed state changed. 0 disables the schedule.
  BRIEFING_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(10),

  // Encrypted relay for peers that cannot reach each other directly (NAT,
  // CGNAT, firewalls). It forwards WireGuard ciphertext only.
  RELAY_ENABLED: bool.default('true'),
  RELAY_MAX_BYTES_PER_SECOND: z.coerce.number().int().min(16384).default(4 * 1024 * 1024),
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
    cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
  };
}

module.exports = { loadConfig };
