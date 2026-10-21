'use strict';

const { DiagnosticRun, Incident } = require('../../database/models/incidents');
const { Device } = require('../../database/models/device');
const { collectEvidence, describeTools } = require('./tools');
const { planDeterministic } = require('./deterministic');
const { validateDiagnosticResult } = require('./diagnostic.schema');
const { proposeActions } = require('../approvals/actions.service');
const { describeActions } = require('../policies/actionRegistry');
const { conflict } = require('../../utils/errors');
const audit = require('../audit/audit.service');

/**
 * Calls the external diagnostic service (Python). Its output is untrusted:
 * it is validated against the same schema and grounding rules, and its
 * proposed actions still go through the policy engine.
 */
async function callDiagnosticService({ config, incident, device, evidence }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.DIAGNOSTIC_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(new URL('/v1/diagnose', config.DIAGNOSTIC_SERVICE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        incident: {
          id: String(incident._id),
          category: incident.category,
          severity: incident.severity,
          title: incident.title,
          detected_at: incident.detectedAt,
          device: { id: String(device._id), name: device.name },
        },
        evidence: evidence.map((x) => ({ ref: x.ref, kind: x.kind, summary: x.summary, observed_at: x.observedAt, data: x.data })),
        tools: describeTools(),
        allowed_actions: describeActions().filter((a) => a.available).map((a) => ({ id: a.id, description: a.description, risk: a.risk })),
      }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const b = await res.json();
        detail = `${b?.error?.code || ''} ${b?.error?.message || ''}`.trim().slice(0, 300);
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`diagnostic service HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const body = await res.json();
    return { result: body.result, provider: String(body.provider || 'unknown').slice(0, 64) };
  } finally {
    clearTimeout(timer);
  }
}

async function runDiagnostics({ incident, user, mode, config, req }) {
  if (mode === 'diagnostic_service' && !config.DIAGNOSTIC_SERVICE_URL) {
    throw conflict('DIAGNOSTIC_SERVICE_DISABLED', 'DIAGNOSTIC_SERVICE_URL is not configured; use deterministic mode');
  }
  const device = await Device.findById(incident.deviceId);
  const run = await DiagnosticRun.create({
    incidentId: incident._id,
    method: mode === 'diagnostic_service' ? 'diagnostic_service' : 'deterministic_rules_v1',
    requestedBy: user._id,
    startedAt: new Date(),
  });
  if (incident.active && incident.state === 'open') await Incident.updateOne({ _id: incident._id }, { state: 'investigating' });

  const { evidence, toolsRun, state } = await collectEvidence({ device, incident, config });
  run.evidence = evidence.map(({ ref, kind, summary, observedAt, data }) => ({ ref, kind, summary, observedAt, data }));

  let raw;
  let proposedByType = 'deterministic_rules';
  try {
    if (mode === 'diagnostic_service') {
      const out = await callDiagnosticService({ config, incident, device, evidence });
      raw = out.result;
      run.provider = out.provider;
      proposedByType = 'diagnostic_service';
    } else {
      raw = planDeterministic({ incident, device, evidence, state });
      run.provider = 'deterministic_rules_v1';
    }
  } catch (err) {
    run.status = 'failed';
    run.validationErrors = [`planner error: ${err.message}`];
    run.completedAt = new Date();
    await run.save();
    return { run, actions: [], toolsRun };
  }

  const validated = validateDiagnosticResult(raw, { incidentId: String(incident._id), evidenceRefs: evidence.map((x) => x.ref) });
  if (!validated.ok) {
    run.status = 'rejected';
    run.validationErrors = validated.errors.slice(0, 50);
    run.completedAt = new Date();
    await run.save();
    await audit.record(
      {
        actor: audit.SYSTEM_ACTOR,
        operation: 'diagnostic.result_rejected',
        target: { type: 'incident', id: String(incident._id) },
        networkId: incident.networkId,
        incidentId: incident._id,
        decision: 'deny',
        outcome: 'failure',
        reason: validated.errors.slice(0, 5).join('; '),
      },
      req,
    );
    return { run, actions: [], toolsRun };
  }

  run.result = validated.value;
  run.status = 'completed';
  run.completedAt = new Date();
  await run.save();

  const fresh = await Incident.findById(incident._id);
  const actions = await proposeActions({
    incident: fresh,
    run,
    proposals: validated.value.proposed_actions,
    proposedBy: { type: proposedByType, ref: String(run._id) },
    config,
    req,
  });
  await audit.record(
    {
      operation: 'diagnostic.run',
      target: { type: 'incident', id: String(incident._id) },
      networkId: incident.networkId,
      incidentId: incident._id,
      metadata: { method: run.method, actions: actions.length, evidence: evidence.length },
    },
    req,
  );
  return { run, actions, toolsRun };
}

module.exports = { runDiagnostics, callDiagnosticService };
