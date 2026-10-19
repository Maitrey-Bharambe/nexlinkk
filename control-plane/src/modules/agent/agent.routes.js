'use strict';

const express = require('express');
const { AgentCommand, Device } = require('../../database/models/device');
const { Membership, Network } = require('../../database/models/network');
const { ProposedAction } = require('../../database/models/incidents');
const { agentAuth } = require('../../middleware/agentAuth');
const { validate } = require('../../middleware/validate');
const { send, ah, objectId } = require('../../utils/http');
const { notFound, conflict, badRequest } = require('../../utils/errors');
const { z } = require('zod');
const { heartbeatSchema, telemetrySchema, commandResultSchema, enrollSchema, agentEventsSchema } = require('../telemetry/telemetry.schema');
const { AgentEvent } = require('../../database/models/telemetry');
const { recordHeartbeat, recordTelemetry, ingestMeasurements } = require('../telemetry/telemetry.service');
const { completeEnrollment } = require('../enrollment/enrollment.service');
const { finalizeCommand } = require('../approvals/actions.service');
const audit = require('../audit/audit.service');

const PERSISTENT_KEEPALIVE_SEC = 25;

/**
 * Agent-only API. Mounted with its own body parser (keeps the raw bytes for
 * signature verification) and its own authentication path. No user session
 * or cookie is consulted here, and these routes are not reachable with one.
 */
function agentRouter({ config, limits }) {
  const r = express.Router();
  r.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  r.post(
    '/enroll',
    limits.enrollment,
    validate({ body: enrollSchema }),
    ah(async (req, res) => {
      let out;
      try {
        out = await completeEnrollment(req.valid.body, { clockSkewSec: config.AGENT_CLOCK_SKEW_SECONDS });
      } catch (err) {
        await audit.record(
          {
            actor: { type: 'anonymous', id: null, label: 'enrolling agent' },
            operation: 'device.enroll',
            decision: 'deny',
            outcome: 'failure',
            reason: err.code || 'error',
          },
          req,
        );
        throw err;
      }
      const { device, network, membership } = out;
      req.device = device;
      await audit.record(
        {
          operation: 'device.enroll',
          target: { type: 'device', id: String(device._id), label: device.name },
          networkId: network._id,
          metadata: { identityFingerprint: device.identityFingerprint, address: membership.address, platform: device.platform },
        },
        req,
      );
      req.app.locals.realtime?.emitNetwork(network._id, 'device:update', { deviceId: String(device._id) });
      send(
        res,
        {
          deviceId: String(device._id),
          deviceName: device.name,
          identityFingerprint: device.identityFingerprint,
          network: { id: String(network._id), name: network.name, cidr: network.cidr },
          address: membership.address,
          heartbeatIntervalSeconds: config.HEARTBEAT_INTERVAL_SECONDS,
        },
        201,
      );
    }),
  );

  const authed = agentAuth(config);

  r.post(
    '/heartbeat',
    limits.agent,
    authed,
    validate({ body: heartbeatSchema }),
    ah(async (req, res) => {
      const { receivedAt, clockSkewMs } = await recordHeartbeat(req.device, req.valid.body, { config, sourceAddress: req.ip });
      req.app.locals.realtime?.emitNetwork(req.device.networkId, 'device:update', { deviceId: String(req.device._id) });
      send(res, {
        receivedAt,
        clockSkewMs,
        nextHeartbeatSeconds: config.HEARTBEAT_INTERVAL_SECONDS,
        pendingCommands: await AgentCommand.countDocuments({ deviceId: req.device._id, status: 'queued' }),
      });
    }),
  );

  r.post(
    '/telemetry',
    limits.agent,
    authed,
    validate({ body: telemetrySchema }),
    ah(async (req, res) => {
      const out = await recordTelemetry(req.device, req.valid.body, { config, sourceAddress: req.ip });
      req.app.locals.realtime?.emitNetwork(req.device.networkId, 'device:update', { deviceId: String(req.device._id) });
      send(res, { accepted: out.stored, unknownPeers: out.unknownPeers, configVersion: out.configVersion, interfaceKeyMatches: out.keyMatches });
    }),
  );

  // Agent log lines for the console's "agent console" panel. Attributed to the
  // authenticated device only; secret-looking fields are redacted again here.
  r.post(
    '/events',
    limits.agent,
    authed,
    validate({ body: agentEventsSchema }),
    ah(async (req, res) => {
      const b = req.valid.body;
      if (String(req.device._id) !== b.deviceId) {
        throw badRequest('DEVICE_ID_MISMATCH', 'deviceId does not match the authenticated agent');
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + config.HEARTBEAT_RETENTION_DAYS * 86400_000);
      const SECRET = /token|secret|password|private|signature|key$/i;
      const docs = b.events.map((e) => ({
        deviceId: req.device._id,
        // Agent clocks can drift; never store a time in the future.
        at: new Date(Math.min(new Date(e.at).getTime(), now.getTime())),
        receivedAt: now,
        level: e.level,
        message: e.message,
        fields: Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, SECRET.test(k) ? '[redacted]' : v])),
        expiresAt,
      }));
      await AgentEvent.insertMany(docs);
      req.app.locals.realtime?.emitNetwork(req.device.networkId, 'agent:event', { deviceId: String(req.device._id) });
      send(res, { accepted: docs.length });
    }),
  );

  // Desired WireGuard configuration for this device. The agent decides whether
  // it is allowed to apply it (privileged mode is opt-in on the host).
  r.get(
    '/config',
    limits.agent,
    authed,
    ah(async (req, res) => {
      const membership = await Membership.findOne({ deviceId: req.device._id, status: 'active' }).lean();
      if (!membership) return send(res, { configVersion: null, network: null, address: null, peers: [] });
      const network = await Network.findById(membership.networkId).lean();
      const others = await Membership.find({ networkId: network._id, status: 'active', deviceId: { $ne: req.device._id } }).lean();
      const peers = await Device.find({ _id: { $in: others.map((m) => m.deviceId) }, enrollmentState: 'enrolled' }).lean();
      const addrOf = new Map(others.map((m) => [String(m.deviceId), m.address]));
      send(res, {
        configVersion: network.configVersion,
        network: { id: String(network._id), name: network.name, cidr: network.cidr },
        address: `${membership.address}/${network.prefixLength}`,
        peers: peers
          .filter((p) => p.wireguardPublicKey)
          .map((p) => ({
            deviceId: String(p._id),
            name: p.name,
            publicKey: p.wireguardPublicKey,
            allowedIPs: [`${addrOf.get(String(p._id))}/32`],
            // Candidates only: the agent must not assume any of these is reachable.
            endpointCandidates: [
              ...(p.endpoints?.reported || []).map((e) => ({ endpoint: e, kind: 'host_reported' })),
              ...(p.endpoints?.reflexiveAddress && p.vpn?.listenPort
                ? [{ endpoint: `${p.endpoints.reflexiveAddress.replace(/^::ffff:/, '')}:${p.vpn.listenPort}`, kind: 'reflexive_guess' }]
                : []),
            ],
            persistentKeepaliveSeconds: PERSISTENT_KEEPALIVE_SEC,
          })),
      });
    }),
  );

  r.get(
    '/commands',
    limits.agent,
    authed,
    ah(async (req, res) => {
      const out = [];
      for (let i = 0; i < 5; i++) {
        const c = await AgentCommand.findOneAndUpdate(
          { deviceId: req.device._id, status: 'queued', deadlineAt: { $gt: new Date() } },
          { status: 'delivered', deliveredAt: new Date() },
          { new: true, sort: { createdAt: 1 } },
        );
        if (!c) break;
        await ProposedAction.updateOne({ _id: c.actionId, status: 'queued' }, { status: 'executing' });
        out.push({ id: String(c._id), type: c.type, params: c.params, deadlineAt: c.deadlineAt });
      }
      send(res, out);
    }),
  );

  r.post(
    '/commands/:commandId/result',
    limits.agent,
    authed,
    validate({ params: z.object({ commandId: objectId }).strict(), body: commandResultSchema }),
    ah(async (req, res) => {
      // Scoped to the authenticated device: another device's command id is "not found".
      const cmd = await AgentCommand.findOne({ _id: req.valid.params.commandId, deviceId: req.device._id });
      if (!cmd) throw notFound('Command');
      if (cmd.status !== 'delivered') throw conflict('COMMAND_NOT_IN_FLIGHT', `Command is ${cmd.status}`);
      const b = req.valid.body;
      const updated = await AgentCommand.findOneAndUpdate(
        { _id: cmd._id, status: 'delivered' },
        { status: b.status, completedAt: new Date(), result: { output: b.output, error: b.error ?? null, startedAt: b.startedAt, finishedAt: b.finishedAt } },
        { new: true },
      );
      if (!updated) throw conflict('COMMAND_NOT_IN_FLIGHT', 'Command state changed concurrently');
      const membership = await Membership.findOne({ deviceId: req.device._id, status: 'active' }).lean();
      await ingestMeasurements(req.device, b.measurements, { networkId: membership?.networkId || null, config, commandId: cmd._id });
      await audit.record(
        {
          operation: 'agent.command_result',
          target: { type: 'device', id: String(req.device._id), label: req.device.name },
          networkId: membership?.networkId || null,
          actionId: cmd.actionId,
          outcome: b.status === 'succeeded' ? 'success' : 'failure',
          metadata: { commandType: cmd.type, measurements: b.measurements.length },
        },
        req,
      );
      const action = await finalizeCommand({ command: updated, config, realtime: req.app.locals.realtime, req });
      send(res, { commandId: String(cmd._id), verification: action?.verification || null });
    }),
  );

  return r;
}

module.exports = { agentRouter };
