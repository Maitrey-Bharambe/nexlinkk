'use strict';

const { z } = require('zod');
const { objectId } = require('../../utils/http');
const { MEASUREMENT_TYPES, TARGET_KINDS } = require('../../database/models/telemetry');

/**
 * Telemetry protocol, schema version 1. The Go agent mirrors these structs in
 * networking-agent/internal/telemetry. Unknown fields are rejected.
 */

const SCHEMA_VERSION = 1;
const CAPABILITIES = ['telemetry', 'connectivity_probe', 'wireguard_inspect', 'wireguard_apply', 'relay', 'remote_session', 'transfer_test'];
const SERVICE_NAMES = ['rdp', 'ssh', 'vnc', 'http', 'https', 'tcp'];
const UNIT_FOR_TYPE = { rtt: 'ms', jitter: 'ms', packet_loss: 'percent', throughput: 'bps', handshake_age: 's' };
const SOURCES = ['tcp_connect', 'icmp', 'udp_echo', 'wireguard', 'http', 'agent'];

const isoDate = z.string().datetime({ offset: true });
const wgKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'Expected base64 WireGuard key');
const endpoint = z.string().max(64).regex(/^[\w.:[\]%-]+$/, 'Invalid endpoint');

const measurementSchema = z
  .object({
    type: z.enum(MEASUREMENT_TYPES),
    target: z
      .object({
        kind: z.enum(TARGET_KINDS),
        // For peer targets: the peer's WireGuard public key or tunnel address.
        ref: z.string().max(128).nullable(),
      })
      .strict(),
    value: z.number().finite().nullable(),
    unit: z.string().max(16),
    valid: z.boolean(),
    source: z.enum(SOURCES),
    sampleCount: z.number().int().min(0).max(10_000).nullable().optional(),
    error: z.string().max(200).nullable().optional(),
    measuredAt: isoDate,
  })
  .strict()
  .superRefine((m, ctx) => {
    if (UNIT_FOR_TYPE[m.type] !== m.unit) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: `${m.type} must use unit ${UNIT_FOR_TYPE[m.type]}` });
    }
    // An unavailable measurement is valid:false with value:null — never a fake zero.
    if (m.valid && m.value === null) ctx.addIssue({ code: 'custom', path: ['value'], message: 'valid measurement needs a value' });
    if (!m.valid && m.value !== null) ctx.addIssue({ code: 'custom', path: ['value'], message: 'invalid measurement must have null value' });
    if (m.value !== null && m.value < 0) ctx.addIssue({ code: 'custom', path: ['value'], message: 'must be >= 0' });
    if (m.type === 'packet_loss' && m.value !== null && m.value > 100) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'packet loss is a percentage' });
    }
  });

const heartbeatSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    deviceId: objectId,
    bootId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    agentTime: isoDate,
    agentVersion: z.string().max(32),
    health: z
      .object({ status: z.enum(['ok', 'degraded', 'error']), details: z.array(z.string().max(200)).max(10) })
      .strict(),
    vpnInterface: z
      .object({ name: z.string().max(32).nullable(), state: z.enum(['up', 'down', 'absent', 'unknown']) })
      .strict()
      .nullable(),
    capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
    services: z
      .array(z.object({ name: z.enum(SERVICE_NAMES), port: z.number().int().min(1).max(65535) }).strict())
      .max(8)
      .optional(),
  })
  .strict();

const telemetrySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    deviceId: objectId,
    measuredAt: isoDate,
    interface: z
      .object({
        name: z.string().max(32).nullable(),
        state: z.enum(['up', 'down', 'absent', 'unknown']),
        listenPort: z.number().int().min(1).max(65535).nullable(),
        publicKey: wgKey.nullable(),
        appliedConfigVersion: z.number().int().min(0).nullable(),
        // wgctrl = read from the kernel/WireGuardNT; wireguard-go = real WireGuard
        // in userspace (e.g. `nexlink-agent lab`); unavailable = could not read;
        // simulated = explicit test fixture, never treated as real connectivity.
        source: z.enum(['wgctrl', 'wireguard-go', 'unavailable', 'simulated']),
      })
      .strict(),
    peers: z
      .array(
        z
          .object({
            publicKey: wgKey,
            endpoint: endpoint.nullable(),
            lastHandshakeAt: isoDate.nullable(),
            rxBytes: z.number().int().min(0).nullable(),
            txBytes: z.number().int().min(0).nullable(),
            allowedIPs: z.array(z.string().max(43)).max(32),
          })
          .strict(),
      )
      .max(256),
    endpointCandidates: z.array(endpoint).max(16).default([]),
    measurements: z.array(measurementSchema).max(100),
  })
  .strict();

const commandResultSchema = z
  .object({
    status: z.enum(['succeeded', 'failed']),
    startedAt: isoDate,
    finishedAt: isoDate,
    output: z.record(z.string(), z.unknown()).default({}),
    error: z.string().max(500).nullable().optional(),
    measurements: z.array(measurementSchema).max(100).default([]),
  })
  .strict();

const enrollSchema = z
  .object({
    enrollmentToken: z.string().regex(/^nxe_[A-Za-z0-9_-]{43}$/, 'Malformed enrollment token'),
    identityPublicKey: z.string().max(64),
    wireguardPublicKey: wgKey,
    agentVersion: z.string().max(32),
    platform: z.string().max(32),
    timestamp: z.number().int(),
    signature: z.string().max(128),
  })
  .strict();

const deviceCodeStartSchema = z
  .object({
    identityPublicKey: z.string().max(64),
    wireguardPublicKey: wgKey,
    hostname: z.string().trim().min(1).max(64),
    agentVersion: z.string().max(32),
    platform: z.string().max(32),
    timestamp: z.number().int(),
    signature: z.string().max(128),
  })
  .strict();

const deviceCodePollSchema = z.object({ deviceCode: z.string().regex(/^nxd_[A-Za-z0-9_-]{43}$/, 'Malformed device code') }).strict();

// Agent log lines streamed to the console's "agent console" panel.
const agentEventsSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    deviceId: objectId,
    events: z
      .array(
        z
          .object({
            at: isoDate,
            level: z.enum(['debug', 'info', 'warn', 'error']),
            message: z.string().min(1).max(300),
            fields: z
              .record(z.string().max(40), z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]))
              .refine((o) => Object.keys(o).length <= 12, 'at most 12 fields')
              .default({}),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

module.exports = {
  SCHEMA_VERSION,
  agentEventsSchema,
  CAPABILITIES,
  UNIT_FOR_TYPE,
  measurementSchema,
  heartbeatSchema,
  telemetrySchema,
  commandResultSchema,
  enrollSchema,
  deviceCodeStartSchema,
  deviceCodePollSchema,
};
