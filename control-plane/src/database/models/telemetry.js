'use strict';

const { Schema, model, models } = require('mongoose');

// Raw telemetry is bounded by TTL indexes (expiresAt is set from the retention
// config at insert time) so the transactional collections never grow unbounded.

const heartbeatSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
  receivedAt: { type: Date, required: true },
  agentTime: Date,
  bootId: String,
  sequence: Number,
  agentVersion: String,
  health: { type: String, enum: ['ok', 'degraded', 'error'] },
  healthDetails: [{ type: String }],
  vpnInterface: { name: String, state: String },
  clockSkewMs: Number,
  sourceAddress: String,
  expiresAt: { type: Date, required: true },
});
heartbeatSchema.index({ deviceId: 1, receivedAt: -1 });
heartbeatSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const MEASUREMENT_TYPES = ['rtt', 'jitter', 'packet_loss', 'throughput', 'handshake_age'];
const TARGET_KINDS = ['control_plane', 'peer', 'relay', 'interface'];

const measurementSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
  networkId: { type: Schema.Types.ObjectId, ref: 'Network', default: null },
  type: { type: String, enum: MEASUREMENT_TYPES, required: true },
  target: {
    kind: { type: String, enum: TARGET_KINDS, required: true },
    ref: { type: String, default: null },
    peerDeviceId: { type: Schema.Types.ObjectId, ref: 'Device', default: null },
  },
  // null means "attempted but no value" — never coerced to zero.
  value: { type: Number, default: null },
  unit: { type: String, required: true },
  valid: { type: Boolean, required: true },
  source: { type: String, required: true },
  sampleCount: { type: Number, default: null },
  error: { type: String, default: null },
  measuredAt: { type: Date, required: true },
  receivedAt: { type: Date, required: true },
  commandId: { type: Schema.Types.ObjectId, default: null },
  expiresAt: { type: Date, required: true },
});
measurementSchema.index({ deviceId: 1, type: 1, measuredAt: -1 });
measurementSchema.index({ 'target.peerDeviceId': 1, measuredAt: -1 });
measurementSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Latest view one device has of one peer (from WireGuard peer status). This is
// *observed* state; configured peer relationships are derived from memberships.
const peerObservationSchema = new Schema(
  {
    networkId: { type: Schema.Types.ObjectId, ref: 'Network', required: true },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    peerDeviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    peerFingerprint: { type: String, required: true },
    lastHandshakeAt: { type: Date, default: null },
    endpoint: { type: String, default: null },
    path: { type: String, enum: ['direct', 'relay', 'unknown'], default: 'unknown' },
    rxBytes: { type: Number, default: null },
    txBytes: { type: Number, default: null },
    observedAt: { type: Date, required: true },
    firstObservedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
peerObservationSchema.index({ deviceId: 1, peerDeviceId: 1 }, { unique: true });
peerObservationSchema.index({ networkId: 1 });

const Heartbeat = models.Heartbeat || model('Heartbeat', heartbeatSchema);
const Measurement = models.Measurement || model('Measurement', measurementSchema);
const PeerObservation = models.PeerObservation || model('PeerObservation', peerObservationSchema);

// Agent log lines (the "agent console" in the UI). Bounded by TTL.
const agentEventSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
  at: { type: Date, required: true },
  receivedAt: { type: Date, required: true },
  level: { type: String, enum: ['debug', 'info', 'warn', 'error'], required: true },
  message: { type: String, required: true },
  fields: { type: Schema.Types.Mixed, default: {} },
  expiresAt: { type: Date, required: true },
});
agentEventSchema.index({ deviceId: 1, at: -1 });
agentEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AgentEvent = models.AgentEvent || model('AgentEvent', agentEventSchema);

module.exports = { Heartbeat, Measurement, PeerObservation, AgentEvent, MEASUREMENT_TYPES, TARGET_KINDS };
