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
const { planWithGroq } = require('./providers/groq');

/** True when an AI planner is available: built-in (GROQ_API_KEY) or the HTTP service. */
const aiConfigured = (config) => Boolean(config.DIAGNOSTIC_SERVICE_URL || config.GROQ_API_KEY);

/**
 * Asks the AI planner: the built-in Groq provider, or the external diagnostic
 * service when DIAGNOSTIC_SERVICE_URL is set. Either way the output is
 * untrusted: it is validated against the same schema and grounding rules,
 * and its proposed actions still go through the policy engine.
 */
async function callDiagnosticService({ config, incident, device, evidence, allowedActions }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.DIAGNOSTIC_SERVICE_TIMEOUT_MS);
  const request = {
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
    allowed_actions:
      allowedActions ?? describeActions().filter((a) => a.available).map((a) => ({ id: a.id, description: a.description, risk: a.risk })),
  };
  try {
    if (!config.DIAGNOSTIC_SERVICE_URL) {
      if (!config.GROQ_API_KEY) throw new Error('no AI provider configured');
      return await planWithGroq({ config, request, signal: ctrl.signal });
    }
    const res = await fetch(new URL('/v1/diagnose', config.DIAGNOSTIC_SERVICE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(request),
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
  if (mode === 'diagnostic_service' && !aiConfigured(config)) {
    throw conflict('DIAGNOSTIC_SERVICE_DISABLED', 'No AI provider configured (set GROQ_API_KEY); use deterministic mode');
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
  run.toolsRun = toolsRun;

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

/**
 * On-demand AI health analysis of one device, without an incident.
 *
 * Same evidence (read-only tools), same diagnostic service, same schema and
 * grounding validation as an incident diagnosis — but the allowlist is empty,
 * so the provider can only explain, never propose an action. Nothing is
 * stored except an audit record; the result is returned to the caller.
 */
async function analyzeDevice({ device, config, req }) {
  if (!aiConfigured(config)) {
    throw conflict('DIAGNOSTIC_SERVICE_DISABLED', 'No AI provider configured — set GROQ_API_KEY');
  }
  const now = new Date();
  const analysisId = `analysis-${device._id}-${now.getTime()}`;
  const check = {
    _id: analysisId,
    category: 'health_check',
    severity: 'low',
    title: `Health check of ${device.name} requested by an operator (analysis only, no actions)`,
    detectedAt: now,
    evidence: [],
  };
  const { evidence, toolsRun } = await collectEvidence({ device, incident: check, config });

  const finish = async (outcome, extra) => {
    await audit.record(
      {
        operation: 'device.analyze',
        target: { type: 'device', id: String(device._id), label: device.name },
        networkId: device.networkId,
        outcome: outcome === 'completed' ? 'success' : 'failure',
        metadata: { evidence: evidence.length, provider: extra.provider || null },
        reason: extra.error || null,
      },
      req,
    );
    return { id: analysisId, status: outcome, analyzedAt: now, toolsRun, evidence: evidence.map(({ ref, kind, summary, observedAt }) => ({ ref, kind, summary, observedAt })), ...extra };
  };

  let out;
  try {
    out = await callDiagnosticService({ config, incident: check, device, evidence, allowedActions: [] });
  } catch (err) {
    return finish('failed', { error: err.name === 'AbortError' ? 'diagnostic service timed out' : err.message });
  }
  const validated = validateDiagnosticResult(out.result, { incidentId: analysisId, evidenceRefs: evidence.map((x) => x.ref) });
  if (!validated.ok) return finish('rejected', { provider: out.provider, error: validated.errors.slice(0, 5).join('; ') });
  if (validated.value.proposed_actions.length) {
    return finish('rejected', { provider: out.provider, error: 'analysis proposed actions although none are allowed' });
  }
  return finish('completed', { provider: out.provider, result: validated.value });
}

module.exports = { runDiagnostics, callDiagnosticService, analyzeDevice, aiConfigured };
