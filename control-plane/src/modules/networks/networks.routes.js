'use strict';

const express = require('express');
const { z } = require('zod');
const { Network, Membership } = require('../../database/models/network');
const { User } = require('../../database/models/identity');
const { Device } = require('../../database/models/device');
const { validate } = require('../../middleware/validate');
const { requirePermission, requireCsrf } = require('../../middleware/auth');
const { send, ah, objectId } = require('../../utils/http');
const { conflict, badRequest, forbidden } = require('../../utils/errors');
const { createNetwork, serializeNetwork, bumpConfigVersion } = require('./networks.service');
const { networkScopeFilter, loadNetworkInScope, roleOnNetwork } = require('./scope');
const { loadNetworkState, serializeDevice } = require('../telemetry/state.service');
const audit = require('../audit/audit.service');

const idParams = z.object({ networkId: objectId }).strict();
const createBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[\w .-]+$/, 'Letters, digits, space, dot, dash and underscore only'),
    cidr: z.string().trim().max(18),
  })
  .strict();
const collaboratorBody = z.object({ email: z.string().email(), role: z.enum(['operator', 'viewer']) }).strict();

function summarize(state, networkId) {
  const counts = { total: 0, healthy: 0, degraded: 0, unreachable: 0, unknown: 0, pending_enrollment: 0, revoked: 0 };
  for (const d of state.devices.filter((x) => String(x.networkId) === String(networkId))) {
    counts.total++;
    const s = state.health.get(String(d._id))?.status || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  const links = state.links.filter((l) => l.networkId === String(networkId));
  const linkCounts = links.reduce((acc, l) => ({ ...acc, [l.state]: (acc[l.state] || 0) + 1 }), {});
  // Network status is derived from observations only. "configured" means the
  // record exists — not that any tunnel is up.
  let status = 'configured';
  if (links.length && linkCounts.connected === links.length) status = 'operational';
  else if (linkCounts.connected || linkCounts.degraded) status = 'partially_operational';
  else if (links.length && (linkCounts.unreachable || 0) > 0) status = 'impaired';
  return { devices: counts, links: { total: links.length, ...linkCounts }, observedStatus: status };
}

function networksRouter({ config, limits }) {
  const r = express.Router();

  r.get(
    '/networks',
    requirePermission('networks:read'),
    ah(async (req, res) => {
      const nets = await Network.find({ ...networkScopeFilter(req.user), status: 'active' }).sort({ createdAt: 1 }).lean();
      const state = await loadNetworkState(nets.map((n) => n._id), config);
      send(res, nets.map((n) => serializeNetwork(n, { myRole: roleOnNetwork(req.user, n), summary: summarize(state, n._id) })));
    }),
  );

  r.post(
    '/networks',
    requirePermission('networks:create'),
    requireCsrf,
    validate({ body: createBody }),
    ah(async (req, res) => {
      try {
        const network = await createNetwork({ ...req.valid.body, ownerId: req.user._id });
        await audit.record(
          {
            operation: 'network.create',
            target: { type: 'network', id: String(network._id), label: network.name },
            networkId: network._id,
            metadata: { cidr: network.cidr },
          },
          req,
        );
        req.app.locals.realtime?.emitNetwork(network._id, 'network:update', { networkId: String(network._id) }, req.user._id);
        send(res, serializeNetwork(network.toObject(), { myRole: 'owner' }), 201);
      } catch (err) {
        await audit.record(
          {
            operation: 'network.create',
            decision: 'deny',
            outcome: 'failure',
            reason: err.code || 'error',
            metadata: { cidr: req.valid.body.cidr, name: req.valid.body.name },
          },
          req,
        );
        throw err;
      }
    }),
  );

  r.get(
    '/networks/:networkId',
    requirePermission('networks:read'),
    validate({ params: idParams }),
    ah(async (req, res) => {
      const network = await loadNetworkInScope(req.user, req.valid.params.networkId);
      const state = await loadNetworkState([network._id], config);
      const devices = state.devices.map((d) =>
        serializeDevice(d, { health: state.health.get(String(d._id)), membership: state.membershipByDevice.get(String(d._id)) }),
      );
      send(
        res,
        serializeNetwork(network.toObject(), {
          myRole: roleOnNetwork(req.user, network),
          summary: summarize(state, network._id),
          devices,
          links: state.links,
        }),
      );
    }),
  );

  r.delete(
    '/networks/:networkId',
    requirePermission('networks:delete'),
    requireCsrf,
    limits.sensitive,
    validate({ params: idParams }),
    ah(async (req, res) => {
      const network = await loadNetworkInScope(req.user, req.valid.params.networkId, { write: true });
      const active = await Membership.countDocuments({ networkId: network._id, status: 'active' });
      const pending = await Device.countDocuments({ networkId: network._id, enrollmentState: 'pending' });
      if (active || pending) {
        await audit.record(
          {
            operation: 'network.delete',
            target: { type: 'network', id: String(network._id), label: network.name },
            networkId: network._id,
            decision: 'deny',
            outcome: 'failure',
            reason: `${active} active device(s), ${pending} pending enrollment(s)`,
          },
          req,
        );
        throw conflict(
          'NETWORK_NOT_EMPTY',
          `Revoke or remove ${active} active device(s) and ${pending} pending enrollment(s) first`,
        );
      }
      await Network.updateOne({ _id: network._id }, { status: 'deleted', deletedAt: new Date() });
      await Membership.updateMany({ networkId: network._id, holdsAddress: true }, { holdsAddress: false });
      await audit.record(
        { operation: 'network.delete', target: { type: 'network', id: String(network._id), label: network.name }, networkId: network._id },
        req,
      );
      send(res, { id: String(network._id), status: 'deleted' });
    }),
  );

  r.post(
    '/networks/:networkId/collaborators',
    requirePermission('networks:create'),
    requireCsrf,
    validate({ params: idParams, body: collaboratorBody }),
    ah(async (req, res) => {
      const network = await loadNetworkInScope(req.user, req.valid.params.networkId, { write: true });
      if (req.user.role !== 'admin' && String(network.ownerId) !== String(req.user._id)) {
        throw forbidden('OWNER_ONLY', 'Only the owner or an admin can share a network');
      }
      const user = await User.findOne({ email: req.valid.body.email.toLowerCase() });
      if (!user) throw badRequest('USER_NOT_FOUND', 'No user with that email');
      await Network.updateOne({ _id: network._id }, { $pull: { collaborators: { userId: user._id } } });
      await Network.updateOne({ _id: network._id }, { $push: { collaborators: { userId: user._id, role: req.valid.body.role } } });
      await bumpConfigVersion(network._id);
      await audit.record(
        {
          operation: 'network.share',
          target: { type: 'network', id: String(network._id), label: network.name },
          networkId: network._id,
          metadata: { userId: String(user._id), role: req.valid.body.role },
        },
        req,
      );
      send(res, { networkId: String(network._id), userId: String(user._id), role: req.valid.body.role });
    }),
  );

  return r;
}

module.exports = { networksRouter, summarize };
