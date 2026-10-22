'use strict';

const { Schema, model, models } = require('mongoose');

/**
 * Device-code enrollment ("join with a code"). The agent creates its keys,
 * proves it holds them, and gets a short code to show on screen. An operator
 * approves that code in the console; the agent, polling with a secret only it
 * knows, then receives its enrollment. No token is ever typed or sent around.
 */
const deviceCodeSchema = new Schema({
  userCode: { type: String, required: true }, // 8 chars, shown as XXXX-XXXX
  deviceCodeHash: { type: String, required: true }, // sha256 of the agent's polling secret
  status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending' },
  identityPublicKey: { type: String, required: true },
  identityFingerprint: { type: String, required: true },
  wireguardPublicKey: { type: String, required: true },
  hostname: { type: String, required: true },
  platform: { type: String, required: true },
  agentVersion: { type: String, required: true },
  requestedFrom: { type: String, default: null },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  decidedAt: { type: Date, default: null },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  deviceId: { type: Schema.Types.ObjectId, ref: 'Device', default: null },
  purgeAt: { type: Date, required: true },
});
// A code is unique while it can still be approved.
deviceCodeSchema.index({ userCode: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
deviceCodeSchema.index({ deviceCodeHash: 1 }, { unique: true });
deviceCodeSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const DeviceCode = models.DeviceCode || model('DeviceCode', deviceCodeSchema);

module.exports = { DeviceCode };
