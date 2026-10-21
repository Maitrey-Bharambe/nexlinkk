'use strict';

const { Schema, model, models } = require('mongoose');

// Append-only: there is no API route that creates, updates or deletes audit
// events. Only backend code calls audit.record().
const auditEventSchema = new Schema({
  at: { type: Date, required: true },
  actor: {
    type: { type: String, enum: ['user', 'device', 'system', 'anonymous'], required: true },
    id: { type: String, default: null },
    label: { type: String, default: null },
  },
  operation: { type: String, required: true },
  target: {
    type: { type: String, default: null },
    id: { type: String, default: null },
    label: { type: String, default: null },
  },
  networkId: { type: Schema.Types.ObjectId, default: null },
  decision: { type: String, enum: ['allow', 'deny'], required: true },
  outcome: { type: String, enum: ['success', 'failure', 'pending'], required: true },
  reason: { type: String, default: null },
  incidentId: { type: Schema.Types.ObjectId, default: null },
  actionId: { type: Schema.Types.ObjectId, default: null },
  requestId: { type: String, default: null },
  ip: { type: String, default: null },
  metadata: { type: Schema.Types.Mixed, default: null },
});
auditEventSchema.index({ at: -1 });
auditEventSchema.index({ networkId: 1, at: -1 });
auditEventSchema.index({ 'target.id': 1, at: -1 });
auditEventSchema.index({ operation: 1, at: -1 });

const AuditEvent = models.AuditEvent || model('AuditEvent', auditEventSchema);

module.exports = { AuditEvent };
