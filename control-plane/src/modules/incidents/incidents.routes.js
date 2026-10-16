'use strict';

const express = require('express');
const { z } = require('zod');
const { Incident, DiagnosticRun, ProposedAction, Approval, INCIDENT_CATEGORIES, INCIDENT_STATES } = require('../../database/models/incidents');
const { Device } = require('../../database/models/device');
const { User } = require('../../database/models/identity');
const { validate } = require('../../middleware/validate');
const { requirePermission, requireCsrf } = require('../../middleware/auth');
const { send, ah, objectId } = require('../../utils/http');
const { notFound, conflict, forbidden } = require('../../utils/errors');
const { visibleNetworkIds, loadDeviceInScope, roleOnNetwork } = require('../networks/scope');
const { Network } = require('../../database/models/network');
const { runDiagnostics } = require('../diagnostics/diagnostics.service');
const { describeTools } = require('../diagnostics/tools');
const { describeActions } = require('../policies/actionRegistry');
const audit = require('../audit/audit.service');

const incidentParams = z.object({ incidentId: objectId }).strict();
const listQuery = z
  .object({
    state: z.enum([...INCIDENT_STATES, 'active']).optional(),
    deviceId: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const diagBody = z.object({ mode: z.enum(['deterministic', 'diagnostic_service']).default('deterministic') }).strict();
const testIncidentBody = z
  .object({ deviceId: objectId, category: z.enum(INCIDENT_CATEGORIES), note: z.string().trim().min(3).max(300) })
  .strict();
const closeBody = z.object({ note: z.string().trim().min(3).max(500) }).strict();

function serializeAction(a, approval, approverName) {
  return {
    id: String(a._id),
    incidentId: String(a.incidentId),
    deviceId: String(a.deviceId),
    networkId: String(a.networkId),
    actionType: a.actionType,
    params: a.params,
    rationale: a.rationale,
    proposedBy: a.proposedBy,
    risk: a.risk,
    requiresApproval: a.requiresApproval,
    validation: a.validation,
    status: a.status,
    verification: a.verification,
    approval: approval
      ? { decision: approval.decision, approverId: String(approval.approverId), approverName, reason: approval.reason, decidedAt: approval.decidedAt }
      : null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

async function serializeActions(actions) {
  const approvals = await Approval.find({ actionId: { $in: actions.map((a) => a._id) } }).lean();
  const users = await User.find({ _id: { $in: approvals.map((x) => x.approverId) } }).select('displayName').lean();
  const names = new Map(users.map((u) => [String(u._id), u.displayName]));
  const byAction = new Map(approvals.map((x) => [String(x.actionId), x]));
  return actions.map((a) => {
    const ap = byAction.get(String(a._id));
    return serializeAction(a, ap, ap ? names.get(String(ap.approverId)) : null);
  });
}

function serializeIncident(i, deviceName) {
  return {
    id: String(i._id),
    category: i.category,
    severity: i.severity,
    state: i.state,
    active: i.active,
    source: i.source,
    isTest: i.source === 'test',
    title: i.title,
    deviceId: String(i.deviceId),
    deviceName: deviceName || null,
    networkId: String(i.networkId),
    peerDeviceId: i.peerDeviceId ? String(i.peerDeviceId) : null,
    detectedAt: i.detectedAt,
    lastObservedAt: i.lastObservedAt,
    evidence: i.evidence,
    resolution: i.resolution,
  };
}

async function loadIncidentInScope(user, incidentId, { write = false } = {}) {
  const incident = await Incident.findById(incidentId);
  if (!incident) throw notFound('Incident');
  const network = await Network.findById(incident.networkId);
  const role = network && roleOnNetwork(user, network);
  if (!role) throw notFound('Incident');
  if (write && role === 'viewer') throw forbidden('SCOPE_DENIED', 'Read-only access to this network');
  return incident;
}

function incidentsRouter({ config, limits }) {
  const r = express.Router();

  r.get('/diagnostics/registry', requirePermission('incidents:read'), (_req, res) =>
    send(res, { tools: describeTools(), actions: describeActions(), llmProviderConfigured: Boolean(config.DIAGNOSTIC_SERVICE_URL) }),
  );

  r.get(
    '/incidents',
    requirePermission('incidents:read'),
    validate({ query: listQuery }),
    ah(async (req, res) => {
      const { state, deviceId, limit } = req.valid.query;
      const q = { networkId: { $in: await visibleNetworkIds(req.user) } };
      if (state === 'active') q.active = true;
      else if (state) q.state = state;
      if (deviceId) q.deviceId = deviceId;
      const rows = await Incident.find(q).sort({ detectedAt: -1 }).limit(limit).lean();
      const devices = await Device.find({ _id: { $in: rows.map((x) => x.deviceId) } }).select('name').lean();
      const names = new Map(devices.map((d) => [String(d._id), d.name]));
      send(res, rows.map((i) => serializeIncident(i, names.get(String(i.deviceId)))));
    }),
  );

  // Explicitly-labelled test events, for exercising the diagnostic pipeline
  // without breaking a real network. They never auto-resolve.
  r.post(
    '/incidents/test',
    requirePermission('incidents:create_test'),
    requireCsrf,
    validate({ body: testIncidentBody }),
    ah(async (req, res) => {
      const { device } = await loadDeviceInScope(req.user, req.valid.body.deviceId, { write: true });
      const now = new Date();
      let incident;
      try {
        incident = await Incident.create({
          category: req.valid.body.category,
          severity: 'low',
          source: 'test',
          title: `[TEST] ${device.name}: ${req.valid.body.category}`,
          deviceId: device._id,
          networkId: device.networkId,
          detectedAt: now,
          lastObservedAt: now,
          evidence: [{ ref: `test:${now.getTime()}`, kind: 'test_event', summary: `Test event: ${req.valid.body.note}`, observedAt: now }],
        });
      } catch (err) {
        if (err?.code === 11000) throw conflict('INCIDENT_ALREADY_OPEN', 'An active incident of this category already exists for the device');
        throw err;
      }
      await audit.record(
        {
          operation: 'incident.create_test',
          target: { type: 'device', id: String(device._id), label: device.name },
          networkId: device.networkId,
          incidentId: incident._id,
        },
        req,
      );
      send(res, serializeIncident(incident.toObject(), device.name), 201);
    }),
  );

  r.get(
    '/incidents/:incidentId',
    requirePermission('incidents:read'),
    validate({ params: incidentParams }),
    ah(async (req, res) => {
      const incident = await loadIncidentInScope(req.user, req.valid.params.incidentId);
      const [device, runs, actions] = await Promise.all([
        Device.findById(incident.deviceId).select('name').lean(),
        DiagnosticRun.find({ incidentId: incident._id }).sort({ startedAt: -1 }).limit(20).lean(),
        ProposedAction.find({ incidentId: incident._id }).sort({ createdAt: -1 }).lean(),
      ]);
      send(res, {
        ...serializeIncident(incident.toObject(), device?.name),
        diagnosticRuns: runs.map((x) => ({
          id: String(x._id),
          method: x.method,
          provider: x.provider,
          status: x.status,
          startedAt: x.startedAt,
          completedAt: x.completedAt,
          evidence: x.evidence,
          result: x.result,
          validationErrors: x.validationErrors,
        })),
        actions: await serializeActions(actions),
      });
    }),
  );

  r.post(
    '/incidents/:incidentId/diagnostics',
    requirePermission('incidents:diagnose'),
    requireCsrf,
    limits.sensitive,
    validate({ params: incidentParams, body: diagBody }),
    ah(async (req, res) => {
      const incident = await loadIncidentInScope(req.user, req.valid.params.incidentId, { write: true });
      const { run, actions, toolsRun } = await runDiagnostics({ incident, user: req.user, mode: req.valid.body.mode, config, req });
      req.app.locals.realtime?.emitNetwork(incident.networkId, 'incident:update', { incidentId: String(incident._id) });
      send(res, { runId: String(run._id), status: run.status, validationErrors: run.validationErrors, toolsRun, actions: await serializeActions(actions) }, 201);
    }),
  );

  r.get(
    '/incidents/:incidentId/actions',
    requirePermission('actions:read'),
    validate({ params: incidentParams }),
    ah(async (req, res) => {
      const incident = await loadIncidentInScope(req.user, req.valid.params.incidentId);
      const actions = await ProposedAction.find({ incidentId: incident._id }).sort({ createdAt: -1 }).lean();
      send(res, await serializeActions(actions));
    }),
  );

  // Manual close is recorded as "closed", never "resolved": no verification happened.
  r.post(
    '/incidents/:incidentId/close',
    requirePermission('incidents:close'),
    requireCsrf,
    validate({ params: incidentParams, body: closeBody }),
    ah(async (req, res) => {
      const incident = await loadIncidentInScope(req.user, req.valid.params.incidentId, { write: true });
      if (!incident.active) throw conflict('INCIDENT_NOT_ACTIVE', `Incident is already ${incident.state}`);
      incident.state = 'closed';
      incident.active = false;
      incident.resolution = { method: 'closed_by_operator', verifiedAt: null, evidence: [], note: req.valid.body.note, closedBy: req.user._id };
      await incident.save();
      await ProposedAction.updateMany({ incidentId: incident._id, status: 'awaiting_approval' }, { status: 'cancelled' });
      await audit.record(
        {
          operation: 'incident.close',
          target: { type: 'incident', id: String(incident._id) },
          networkId: incident.networkId,
          incidentId: incident._id,
          reason: req.valid.body.note,
        },
        req,
      );
      send(res, serializeIncident(incident.toObject()));
    }),
  );

  return r;
}

module.exports = { incidentsRouter, serializeActions, serializeIncident };
