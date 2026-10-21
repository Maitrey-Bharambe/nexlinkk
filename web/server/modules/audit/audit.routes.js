'use strict';

const express = require('express');
const { z } = require('zod');
const { AuditEvent } = require('../../database/models/audit');
const { validate } = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { send, ah, objectId } = require('../../utils/http');
const { visibleNetworkIds } = require('../networks/scope');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    decision: z.enum(['allow', 'deny']).optional(),
    networkId: objectId.optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** Read-only. There is deliberately no POST/PUT/DELETE for audit events. */
function auditRouter() {
  const r = express.Router();
  r.get(
    '/audit-events',
    requirePermission('audit:read'),
    validate({ query: listQuery }),
    ah(async (req, res) => {
      const { q, decision, networkId, before, limit } = req.valid.query;
      const filter = {};
      if (req.user.role !== 'admin') {
        // Non-admins see events in their networks plus their own actions.
        filter.$or = [{ networkId: { $in: await visibleNetworkIds(req.user) } }, { 'actor.id': String(req.user._id) }];
      }
      if (networkId) filter.networkId = networkId;
      if (decision) filter.decision = decision;
      if (before) filter.at = { $lt: new Date(before) };
      if (q) {
        const re = new RegExp(escapeRe(q), 'i');
        const text = [{ operation: re }, { 'actor.label': re }, { 'target.label': re }, { 'target.id': q }, { reason: re }];
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, { $or: text }];
          delete filter.$or;
        } else filter.$or = text;
      }
      const rows = await AuditEvent.find(filter).sort({ at: -1 }).limit(limit).lean();
      send(
        res,
        rows.map((e) => ({
          id: String(e._id),
          at: e.at,
          actor: e.actor,
          operation: e.operation,
          target: e.target,
          networkId: e.networkId ? String(e.networkId) : null,
          decision: e.decision,
          outcome: e.outcome,
          reason: e.reason,
          incidentId: e.incidentId ? String(e.incidentId) : null,
          actionId: e.actionId ? String(e.actionId) : null,
          requestId: e.requestId,
          metadata: e.metadata,
        })),
      );
    }),
  );
  return r;
}

module.exports = { auditRouter };
