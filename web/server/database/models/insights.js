'use strict';

const { Schema, model, models } = require('mongoose');

/**
 * AI network briefings. Produced by the diagnostic service from evidence the
 * control plane collected, validated (schema + grounding, no actions allowed)
 * before storing. `inputHash` lets the scheduler skip unchanged networks.
 */
const briefingSchema = new Schema({
  networkId: { type: Schema.Types.ObjectId, ref: 'Network', required: true },
  generatedAt: { type: Date, required: true },
  trigger: { type: String, enum: ['schedule', 'operator'], required: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['completed', 'failed', 'rejected'], required: true },
  provider: { type: String, default: null },
  inputHash: { type: String, required: true },
  result: { type: Schema.Types.Mixed, default: null },
  evidence: [{ _id: false, ref: String, kind: String, summary: String, observedAt: Date }],
  error: { type: String, default: null },
  expiresAt: { type: Date, required: true },
});
briefingSchema.index({ networkId: 1, generatedAt: -1 });
briefingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AiBriefing = models.AiBriefing || model('AiBriefing', briefingSchema);

module.exports = { AiBriefing };
