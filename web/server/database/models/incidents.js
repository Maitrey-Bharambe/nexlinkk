'use strict';

const { Schema, model, models } = require('mongoose');

const INCIDENT_CATEGORIES = [
  'agent_offline',
  'vpn_interface_down',
  'peer_handshake_stale',
  'packet_loss_high',
  'latency_high',
];
const INCIDENT_STATES = ['open', 'investigating', 'awaiting_approval', 'mitigating', 'resolved', 'closed'];

const evidenceSchema = new Schema(
  {
    ref: { type: String, required: true }, // e.g. "measurement:<id>", "heartbeat:<id>", "device:<id>:vpn"
    kind: { type: String, required: true },
    summary: { type: String, required: true },
    observedAt: { type: Date, default: null },
    data: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const incidentSchema = new Schema(
  {
    category: { type: String, enum: INCIDENT_CATEGORIES, required: true },
    severity: { type: String, enum: ['low', 'medium', 'high'], required: true },
    state: { type: String, enum: INCIDENT_STATES, default: 'open' },
    // True while the incident is unresolved; drives the one-open-incident-per-condition index.
    active: { type: Boolean, default: true },
    source: { type: String, enum: ['detector', 'test'], required: true },
    title: { type: String, required: true },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    networkId: { type: Schema.Types.ObjectId, ref: 'Network', required: true },
    peerDeviceId: { type: Schema.Types.ObjectId, ref: 'Device', default: null },
    detectedAt: { type: Date, required: true },
    lastObservedAt: { type: Date, required: true },
    evidence: [evidenceSchema],
    resolution: {
      method: { type: String, default: null }, // condition_cleared_observed | closed_by_operator
      verifiedAt: { type: Date, default: null },
      evidence: [evidenceSchema],
      note: { type: String, default: null },
      closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
  },
  { timestamps: true },
);
incidentSchema.index(
  { deviceId: 1, category: 1, peerDeviceId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
incidentSchema.index({ networkId: 1, detectedAt: -1 });
incidentSchema.index({ state: 1, detectedAt: -1 });

const diagnosticRunSchema = new Schema(
  {
    incidentId: { type: Schema.Types.ObjectId, ref: 'Incident', required: true },
    method: { type: String, enum: ['deterministic_rules_v1', 'diagnostic_service'], required: true },
    provider: { type: String, default: null },
    status: { type: String, enum: ['running', 'completed', 'failed', 'rejected'], default: 'running' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    evidence: [evidenceSchema],
    // Which read-only checks ran, how many evidence items each produced.
    toolsRun: [{ _id: false, tool: String, ok: Boolean, error: String, items: Number, refs: [String], startedAt: Date, ms: Number }],
    // Validated against the structured diagnostic schema before storage.
    result: { type: Schema.Types.Mixed, default: null },
    validationErrors: [{ type: String }],
  },
  { timestamps: true },
);
diagnosticRunSchema.index({ incidentId: 1, startedAt: -1 });

const ACTION_STATES = [
  'rejected_by_policy',
  'awaiting_approval',
  'rejected',
  'queued',
  'executing',
  'completed',
  'cancelled',
];
const VERIFICATION_OUTCOMES = [
  'successful',
  'failed',
  'partially_successful',
  'timed_out',
  'verification_inconclusive',
];

const proposedActionSchema = new Schema(
  {
    // null for actions requested directly from a device page (no incident).
    incidentId: { type: Schema.Types.ObjectId, ref: 'Incident', default: null },
    diagnosticRunId: { type: Schema.Types.ObjectId, ref: 'DiagnosticRun', default: null },
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    networkId: { type: Schema.Types.ObjectId, ref: 'Network', required: true },
    actionType: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    rationale: { type: String, default: null },
    proposedBy: { type: { type: String, enum: ['deterministic_rules', 'diagnostic_service', 'user'] }, ref: String },
    risk: { type: String, enum: ['low', 'medium', 'high'], default: null },
    requiresApproval: { type: Boolean, default: true },
    validation: {
      valid: { type: Boolean, required: true },
      reasons: [{ type: String }],
      checkedAt: { type: Date, required: true },
    },
    status: { type: String, enum: ACTION_STATES, required: true },
    commandId: { type: Schema.Types.ObjectId, ref: 'AgentCommand', default: null },
    verification: {
      outcome: { type: String, enum: [...VERIFICATION_OUTCOMES, null], default: null },
      checkedAt: { type: Date, default: null },
      notes: [{ type: String }],
      evidence: [evidenceSchema],
    },
  },
  { timestamps: true },
);
proposedActionSchema.index({ status: 1, createdAt: -1 });
proposedActionSchema.index({ incidentId: 1 });
proposedActionSchema.index({ deviceId: 1, actionType: 1, createdAt: -1 });

const approvalSchema = new Schema(
  {
    actionId: { type: Schema.Types.ObjectId, ref: 'ProposedAction', required: true },
    approverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    decision: { type: String, enum: ['approved', 'rejected'], required: true },
    reason: { type: String, maxlength: 500, default: null },
    decidedAt: { type: Date, required: true },
  },
  { timestamps: true },
);
// One decision per action: a second approve/reject is a conflict, not an overwrite.
approvalSchema.index({ actionId: 1 }, { unique: true });

const Incident = models.Incident || model('Incident', incidentSchema);
const DiagnosticRun = models.DiagnosticRun || model('DiagnosticRun', diagnosticRunSchema);
const ProposedAction = models.ProposedAction || model('ProposedAction', proposedActionSchema);
const Approval = models.Approval || model('Approval', approvalSchema);

module.exports = {
  Incident,
  DiagnosticRun,
  ProposedAction,
  Approval,
  INCIDENT_CATEGORIES,
  INCIDENT_STATES,
  VERIFICATION_OUTCOMES,
};
