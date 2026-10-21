'use strict';

const { Schema, model, models } = require('mongoose');

const ENROLLMENT_STATES = ['pending', 'enrolled', 'revoked', 'expired'];
const VPN_STATES = ['up', 'down', 'absent', 'unknown'];

const deviceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 64 },
    networkId: { type: Schema.Types.ObjectId, ref: 'Network', required: true },
    enrollmentState: { type: String, enum: ENROLLMENT_STATES, default: 'pending' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Agent identity: an Ed25519 public key generated on the device. The private
    // key never leaves the device.
    identityPublicKey: { type: String, default: null },
    identityFingerprint: { type: String, default: null },
    // WireGuard public key (Curve25519). Private key stays on the device.
    wireguardPublicKey: { type: String, default: null },
    wireguardFingerprint: { type: String, default: null },

    agentVersion: { type: String, default: null },
    platform: { type: String, default: null },
    capabilities: [{ type: String }],
    // Local services the device owner chose to share into the tunnel for
    // remote sessions (`nexlink-agent run --share rdp,ssh`). Reported, not set here.
    services: [{ _id: false, name: String, port: Number }],
    enrolledAt: { type: Date, default: null },

    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    revocationReason: { type: String, default: null },

    // Server-side timestamps only. Agent clocks are recorded but never trusted for freshness.
    lastHeartbeatAt: { type: Date, default: null },
    lastHeartbeat: {
      bootId: String,
      sequence: Number,
      agentTime: Date,
      health: String,
      clockSkewMs: Number,
    },
    lastTelemetryAt: { type: Date, default: null },
    vpn: {
      interfaceName: { type: String, default: null },
      state: { type: String, enum: VPN_STATES, default: 'unknown' },
      listenPort: { type: Number, default: null },
      appliedConfigVersion: { type: Number, default: null },
      observedAt: { type: Date, default: null },
      source: { type: String, default: null },
      // Whether the interface key the agent reads matches the enrolled WireGuard key.
      keyMatches: { type: Boolean, default: null },
    },
    endpoints: {
      // Candidates the agent reports (local interface addresses + listen port).
      reported: [{ type: String }],
      // Source address the control plane saw — a server-reflexive hint, not proof
      // that a peer can reach it (NAT may still block inbound UDP).
      reflexiveAddress: { type: String, default: null },
      observedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);
deviceSchema.index(
  { identityFingerprint: 1 },
  { unique: true, partialFilterExpression: { identityFingerprint: { $type: 'string' } } },
);
deviceSchema.index(
  { wireguardPublicKey: 1 },
  { unique: true, partialFilterExpression: { wireguardPublicKey: { $type: 'string' } } },
);
deviceSchema.index({ networkId: 1, enrollmentState: 1 });

const enrollmentTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    networkId: { type: Schema.Types.ObjectId, ref: 'Network', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedByFingerprint: { type: String, default: null },
    failedAttempts: { type: Number, default: 0 },
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true },
);
enrollmentTokenSchema.index({ tokenHash: 1 }, { unique: true });
enrollmentTokenSchema.index({ deviceId: 1 });
enrollmentTokenSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

// Replay protection for signed agent requests: (device, nonce) may be used once.
const agentNonceSchema = new Schema({
  deviceId: { type: Schema.Types.ObjectId, required: true },
  nonce: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
agentNonceSchema.index({ deviceId: 1, nonce: 1 }, { unique: true });
agentNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const COMMAND_STATES = ['queued', 'delivered', 'succeeded', 'failed', 'timed_out', 'cancelled'];

const agentCommandSchema = new Schema(
  {
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    actionId: { type: Schema.Types.ObjectId, ref: 'ProposedAction', required: true },
    type: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: COMMAND_STATES, default: 'queued' },
    deadlineAt: { type: Date, required: true },
    deliveredAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    result: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);
agentCommandSchema.index({ deviceId: 1, status: 1, createdAt: 1 });
agentCommandSchema.index({ status: 1, deadlineAt: 1 });

const Device = models.Device || model('Device', deviceSchema);
const EnrollmentToken = models.EnrollmentToken || model('EnrollmentToken', enrollmentTokenSchema);
const AgentNonce = models.AgentNonce || model('AgentNonce', agentNonceSchema);
const AgentCommand = models.AgentCommand || model('AgentCommand', agentCommandSchema);

module.exports = { Device, EnrollmentToken, AgentNonce, AgentCommand, ENROLLMENT_STATES, VPN_STATES };
