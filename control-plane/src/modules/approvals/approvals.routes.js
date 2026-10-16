'use strict';

const express = require('express');
const { z } = require('zod');
const { ProposedAction } = require('../../database/models/incidents');
const { Device } = require('../../database/models/device');
const { validate } = require('../../middleware/validate');
const { requirePermission, requireCsrf } = require('../../middleware/auth');
const { send, ah, objectId } = require('../../utils/http');
const { visibleNetworkIds } = require('../networks/scope');
const { approveAction, rejectAction } = require('./actions.service');
const { serializeActions } = require('../incidents/incidents.routes');

const actionParams = z.object({ actionId: objectId }).strict();
const approveBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();
const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const listQuery = z
  .object({ status: z.enum(['awaiting_approval', 'queued', 'completed', 'rejected', 'rejected_by_policy', 'all']).default('awaiting_approval') })
  .strict();

function approvalsRouter({ config, limits }) {
  const r = express.Router();

  r.get(
    '/approvals',
    requirePermission('actions:read'),
    validate({ query: listQuery }),
    ah(async (req, res) => {
      const q = { networkId: { $in: await visibleNetworkIds(req.user) } };
      if (req.valid.query.status !== 'all') q.status = req.valid.query.status;
      const actions = await ProposedAction.find(q).sort({ createdAt: -1 }).limit(100).lean();
      const devices = await Device.find({ _id: { $in: actions.map((a) => a.deviceId) } }).select('name').lean();
      const names = new Map(devices.map((d) => [String(d._id), d.name]));
      const out = await serializeActions(actions);
      send(res, out.map((a) => ({ ...a, deviceName: names.get(a.deviceId) || null })));
    }),
  );

  // Approval is gated by the policy engine inside approveAction (risk-based
  // permission + scope + state), not only by this coarse route permission.
  r.post(
    '/actions/:actionId/approve',
    requirePermission('actions:read'),
    requireCsrf,
    limits.sensitive,
    validate({ params: actionParams, body: approveBody }),
    ah(async (req, res) => {
      const action = await approveAction({ actionId: req.valid.params.actionId, user: req.user, reason: req.valid.body.reason, config, req });
      send(res, (await serializeActions([action.toObject()]))[0]);
    }),
  );

  r.post(
    '/actions/:actionId/reject',
    requirePermission('actions:approve:low'),
    requireCsrf,
    limits.sensitive,
    validate({ params: actionParams, body: rejectBody }),
    ah(async (req, res) => {
      const action = await rejectAction({ actionId: req.valid.params.actionId, user: req.user, reason: req.valid.body.reason, req });
      send(res, (await serializeActions([action.toObject()]))[0]);
    }),
  );

  return r;
}

module.exports = { approvalsRouter };
