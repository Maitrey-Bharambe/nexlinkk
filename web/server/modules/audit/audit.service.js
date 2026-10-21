'use strict';

const { AuditEvent } = require('../../database/models/audit');

const SECRET_KEYS = /pass|secret|token|key|signature|cookie|csrf/i;

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // Public-key fingerprints are safe to keep; anything else credential-shaped is dropped.
    out[k] = SECRET_KEYS.test(k) && !/fingerprint/i.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function actorFromReq(req) {
  if (req?.user) return { type: 'user', id: String(req.user._id), label: req.user.email };
  if (req?.device) return { type: 'device', id: String(req.device._id), label: req.device.name };
  return { type: 'anonymous', id: null, label: null };
}

/**
 * The only writer of audit events. Failures to audit are logged loudly but do
 * not crash the request path.
 */
async function record(entry, req) {
  const doc = {
    at: new Date(),
    actor: entry.actor || actorFromReq(req),
    operation: entry.operation,
    target: entry.target || {},
    networkId: entry.networkId || null,
    decision: entry.decision || 'allow',
    outcome: entry.outcome || 'success',
    reason: entry.reason || null,
    incidentId: entry.incidentId || null,
    actionId: entry.actionId || null,
    requestId: req?.id ? String(req.id) : null,
    ip: req?.ip || null,
    metadata: entry.metadata ? redact(entry.metadata) : null,
  };
  try {
    const ev = await AuditEvent.create(doc);
    req?.app?.locals?.realtime?.emitAudit(ev);
    return ev;
  } catch (err) {
    (req?.log || console).error({ err, operation: entry.operation }, 'failed to write audit event');
    return null;
  }
}

const SYSTEM_ACTOR = { type: 'system', id: 'control-plane', label: 'NexLink control plane' };

module.exports = { record, redact, SYSTEM_ACTOR };
