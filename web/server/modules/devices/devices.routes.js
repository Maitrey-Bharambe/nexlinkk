'use strict';

const express = require('express');
const { z } = require('zod');
const { Device, EnrollmentToken, AgentCommand } = require('../../database/models/device');
const { Membership } = require('../../database/models/network');
const { Heartbeat, Measurement, AgentEvent, MEASUREMENT_TYPES } = require('../../database/models/telemetry');
const { ProposedAction } = require('../../database/models/incidents');
const { ACTIONS } = require('../policies/actionRegistry');
const { requestDeviceAction } = require('../approvals/actions.service');
const { analyzeDevice } = require('../diagnostics/diagnostics.service');
const { serializeActions } = require('../incidents/incidents.routes');
const { Incident } = require('../../database/models/incidents');
const { AuditEvent } = require('../../database/models/audit');
const { validate } = require('../../middleware/validate');
const { requirePermission, requireCsrf } = require('../../middleware/auth');
const { send, ah, objectId } = require('../../utils/http');
const { conflict } = require('../../utils/errors');
const { visibleNetworkIds, loadNetworkInScope, loadDeviceInScope } = require('../networks/scope');
const { loadNetworkState, serializeDevice } = require('../telemetry/state.service');
const { bumpConfigVersion } = require('../networks/networks.service');
const { createEnrollmentRequest, enrollmentStatus } = require('../enrollment/enrollment.service');
const audit = require('../audit/audit.service');

const deviceParams = z.object({ deviceId: objectId }).strict();
const listQuery = z
  .object({
    networkId: objectId.optional(),
    status: z.enum(['healthy', 'degraded', 'unreachable', 'unknown', 'pending_enrollment', 'revoked']).optional(),
  })
  .strict();
const enrollBody = z
  .object({
    networkId: objectId,
    name: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[\w .-]+$/, 'Letters, digits, space, dot, dash and underscore only'),
  })
  .strict();
const revokeBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(300).default(150) }).strict();
const actionBody = z
  .object({
    actionType: z.enum(Object.keys(ACTIONS)),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const measurementQuery = z
  .object({
    type: z.enum(MEASUREMENT_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

function devicesRouter({ config, limits }) {
  const r = express.Router();

  r.get(
    '/devices',
    requirePermission('devices:read'),
    validate({ query: listQuery }),
    ah(async (req, res) => {
      const { networkId, status } = req.valid.query;
      let ids = await visibleNetworkIds(req.user);
      if (networkId) ids = ids.filter((id) => String(id) === networkId);
      const state = await loadNetworkState(ids, config);
      let out = state.devices.map((d) =>
        serializeDevice(d, { health: state.health.get(String(d._id)), membership: state.membershipByDevice.get(String(d._id)) }),
      );
      if (status) out = out.filter((d) => d.health?.status === status);
      out.sort((a, b) => a.name.localeCompare(b.name));
      send(res, out);
    }),
  );

  r.post(
    '/devices/enrollment-requests',
    requirePermission('devices:enroll'),
    requireCsrf,
    limits.sensitive,
    validate({ body: enrollBody }),
    ah(async (req, res) => {
      const network = await loadNetworkInScope(req.user, req.valid.body.networkId, { write: true });
      const { device, token, expiresAt } = await createEnrollmentRequest({
        network,
        name: req.valid.body.name,
        user: req.user,
        ttlMinutes: config.ENROLLMENT_TOKEN_TTL_MINUTES,
      });
      await audit.record(
        {
          operation: 'device.enrollment_request',
          target: { type: 'device', id: String(device._id), label: device.name },
          networkId: network._id,
          metadata: { expiresAt },
        },
        req,
      );
      req.app.locals.realtime?.emitNetwork(network._id, 'device:update', { deviceId: String(device._id) });
      // Token travels only in this response body — never in a URL, log or audit record.
      res.set('Cache-Control', 'no-store');
      send(
        res,
        {
          device: serializeDevice(device.toObject(), {}),
          enrollment: { token, expiresAt, singleUse: true },
        },
        201,
      );
    }),
  );

  r.get(
    '/devices/:deviceId',
    requirePermission('devices:read'),
    validate({ params: deviceParams }),
    ah(async (req, res) => {
      const { device } = await loadDeviceInScope(req.user, req.valid.params.deviceId);
      const state = await loadNetworkState([device.networkId], config);
      const id = String(device._id);
      const [heartbeats, enrollment] = await Promise.all([
        Heartbeat.find({ deviceId: device._id }).sort({ receivedAt: -1 }).limit(20).lean(),
        enrollmentStatus(device._id),
      ]);
      const names = new Map(state.devices.map((d) => [String(d._id), d.name]));
      send(res, {
        ...serializeDevice(device.toObject(), { health: state.health.get(id), membership: state.membershipByDevice.get(id) }),
        vpn: device.vpn,
        endpoints: device.endpoints,
        relay: req.app.locals.relay?.status(id) || { connected: false },
        services: device.services || [],
        enrollment,
        peerLinks: state.links
          .filter((l) => l.source === id || l.target === id)
          .map((l) => {
            const peerId = l.source === id ? l.target : l.source;
            return { ...l, peerDeviceId: peerId, peerName: names.get(peerId) || null };
          }),
        recentHeartbeats: heartbeats.map((h) => ({
          id: String(h._id),
          receivedAt: h.receivedAt,
          agentTime: h.agentTime,
          sequence: h.sequence,
          health: h.health,
          healthDetails: h.healthDetails,
          vpnInterface: h.vpnInterface,
          clockSkewMs: h.clockSkewMs,
        })),
      });
    }),
  );

  r.get(
    '/devices/:deviceId/history',
    requirePermission('devices:read'),
    validate({ params: deviceParams }),
    ah(async (req, res) => {
      const { device } = await loadDeviceInScope(req.user, req.valid.params.deviceId);
      const [heartbeats, incidents, events, memberships] = await Promise.all([
        Heartbeat.find({ deviceId: device._id }).sort({ receivedAt: -1 }).limit(200).select('receivedAt health vpnInterface sequence').lean(),
        Incident.find({ deviceId: device._id }).sort({ detectedAt: -1 }).limit(50).lean(),
        AuditEvent.find({ 'target.id': String(device._id) }).sort({ at: -1 }).limit(50).lean(),
        Membership.find({ deviceId: device._id }).sort({ joinedAt: -1 }).lean(),
      ]);
      send(res, {
        heartbeats,
        incidents: incidents.map((i) => ({ id: String(i._id), category: i.category, state: i.state, severity: i.severity, detectedAt: i.detectedAt, title: i.title })),
        events: events.map((e) => ({ id: String(e._id), at: e.at, operation: e.operation, decision: e.decision, outcome: e.outcome, actor: e.actor, reason: e.reason })),
        memberships: memberships.map((m) => ({ networkId: String(m.networkId), address: m.address, status: m.status, joinedAt: m.joinedAt, endedAt: m.endedAt })),
      });
    }),
  );

  r.get(
    '/devices/:deviceId/measurements',
    requirePermission('telemetry:read'),
    validate({ params: deviceParams, query: measurementQuery }),
    ah(async (req, res) => {
      const { device } = await loadDeviceInScope(req.user, req.valid.params.deviceId);
      const q = { deviceId: device._id };
      if (req.valid.query.type) q.type = req.valid.query.type;
      const rows = await Measurement.find(q).sort({ measuredAt: -1 }).limit(req.valid.query.limit).lean();
      send(
        res,
        rows.map((m) => ({
          id: String(m._id),
          type: m.type,
          target: { kind: m.target.kind, ref: m.target.ref, peerDeviceId: m.target.peerDeviceId ? String(m.target.peerDeviceId) : null },
          value: m.value,
          unit: m.unit,
          valid: m.valid,
          source: m.source,
          sampleCount: m.sampleCount,
          error: m.error,
          measuredAt: m.measuredAt,
        })),
      );
    }),
  );

  // "Agent console": the agent's own log lines plus the commands it ran.
  r.get(
    '/devices/:deviceId/activity',
    requirePermission('devices:read'),
    validate({ params: deviceParams, query: activityQuery }),
    ah(async (req, res) => {
      const { device } = await loadDeviceInScope(req.user, req.valid.params.deviceId);
      const [events, commands] = await Promise.all([
        AgentEvent.find({ deviceId: device._id }).sort({ at: -1, _id: -1 }).limit(req.valid.query.limit).lean(),
        AgentCommand.find({ deviceId: device._id }).sort({ createdAt: -1 }).limit(20).lean(),
      ]);
      send(res, {
        agentVersion: device.agentVersion,
        lastHeartbeatAt: device.lastHeartbeatAt,
        events: events.map((e) => ({ id: String(e._id), at: e.at, level: e.level, message: e.message, fields: e.fields || {} })),
        commands: commands.map((c) => ({
          id: String(c._id),
          type: c.type,
          status: c.status,
          createdAt: c.createdAt,
          deliveredAt: c.deliveredAt,
          completedAt: c.completedAt,
          error: c.result?.error || null,
          output: c.result?.output || null,
        })),
      });
    }),
  );

  r.get(
    '/devices/:deviceId/actions',
    requirePermission('actions:read'),
    validate({ params: deviceParams }),
    ah(async (req, res) => {
      const { device } = await loadDeviceInScope(req.user, req.valid.params.deviceId);
      const actions = await ProposedAction.find({ deviceId: device._id }).sort({ createdAt: -1 }).limit(15).lean();
      send(res, await serializeActions(actions));
    }),
  );

  // Ask the agent to do something from the device page. Goes through the
  // policy engine and still needs an approval before the agent runs it.
  r.post(
    '/devices/:deviceId/actions',
    requirePermission('actions:request'),
    requireCsrf,
    limits.sensitive,
    validate({ params: deviceParams, body: actionBody }),
    ah(async (req, res) => {
      const { device } = await loadDeviceInScope(req.user, req.valid.params.deviceId, { write: true });
      const action = await requestDeviceAction({ device, user: req.user, ...req.valid.body, config, req });
      send(res, (await serializeActions([action.toObject()]))[0], 201);
    }),
  );

  // On-demand AI health analysis (Groq via the diagnostic service). Read-only:
  // the provider gets an empty action allowlist and its output is grounding-checked.
  r.post(
    '/devices/:deviceId/analysis',
    requirePermission('incidents:diagnose'),
    requireCsrf,
    limits.sensitive,
    validate({ params: deviceParams }),
    ah(async (req, res) => {
      const { device } = await loadDeviceInScope(req.user, req.valid.params.deviceId);
      send(res, await analyzeDevice({ device, config, req }));
    }),
  );

  r.post(
    '/devices/:deviceId/revoke',
    requirePermission('devices:revoke'),
    requireCsrf,
    limits.sensitive,
    validate({ params: deviceParams, body: revokeBody }),
    ah(async (req, res) => {
      const { device, network } = await loadDeviceInScope(req.user, req.valid.params.deviceId, { write: true });
      if (device.enrollmentState === 'revoked') throw conflict('ALREADY_REVOKED', 'Device already revoked');
      const now = new Date();
      await Device.updateOne(
        { _id: device._id },
        { enrollmentState: 'revoked', revokedAt: now, revokedBy: req.user._id, revocationReason: req.valid.body.reason },
      );
      // Invalidate any unused enrollment token and stop queued work.
      await EnrollmentToken.updateMany({ deviceId: device._id, usedAt: null }, { expiresAt: now });
      await Membership.updateMany({ deviceId: device._id, status: 'active' }, { status: 'revoked', endedAt: now });
      await AgentCommand.updateMany({ deviceId: device._id, status: { $in: ['queued', 'delivered'] } }, { status: 'cancelled', completedAt: now });
      await bumpConfigVersion(network._id);
      req.app.locals.relay?.disconnect(device._id, 'device revoked');
      await audit.record(
        {
          operation: 'device.revoke',
          target: { type: 'device', id: String(device._id), label: device.name },
          networkId: network._id,
          reason: req.valid.body.reason,
        },
        req,
      );
      req.app.locals.realtime?.emitNetwork(network._id, 'device:update', { deviceId: String(device._id) });
      send(res, { id: String(device._id), enrollmentState: 'revoked', revokedAt: now });
    }),
  );

  r.delete(
    '/devices/:deviceId/membership',
    requirePermission('devices:membership'),
    requireCsrf,
    validate({ params: deviceParams }),
    ah(async (req, res) => {
      const { device, network } = await loadDeviceInScope(req.user, req.valid.params.deviceId, { write: true });
      const m = await Membership.findOneAndUpdate(
        { deviceId: device._id, networkId: network._id, status: 'active' },
        { status: 'removed', holdsAddress: false, endedAt: new Date() },
        { new: true },
      );
      if (!m) throw conflict('NO_ACTIVE_MEMBERSHIP', 'Device has no active membership in this network');
      await bumpConfigVersion(network._id);
      await audit.record(
        {
          operation: 'device.membership_remove',
          target: { type: 'device', id: String(device._id), label: device.name },
          networkId: network._id,
          metadata: { address: m.address },
        },
        req,
      );
      req.app.locals.realtime?.emitNetwork(network._id, 'device:update', { deviceId: String(device._id) });
      send(res, { deviceId: String(device._id), networkId: String(network._id), status: 'removed' });
    }),
  );

  return r;
}

module.exports = { devicesRouter };
