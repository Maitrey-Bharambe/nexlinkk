'use strict';

const express = require('express');
const { z } = require('zod');
const { Network } = require('../../database/models/network');
const { validate } = require('../../middleware/validate');
const { requirePermission, requireCsrf } = require('../../middleware/auth');
const { send, ah, objectId } = require('../../utils/http');
const { conflict, notFound } = require('../../utils/errors');
const { visibleNetworkIds } = require('../networks/scope');
const { computeAnalytics, generateBriefing, serializeBriefing, latestBriefings } = require('./insights.service');

const query = z.object({ networkId: objectId.optional() }).strict();
const body = z.object({ networkId: objectId }).strict();

/**
 * AI insights: network analytics (computed from records) and the latest AI
 * briefing per network (grounded in that same evidence, explain-only).
 */
function insightsRouter({ config, limits }) {
  const r = express.Router();

  r.get(
    '/insights',
    requirePermission('networks:read'),
    validate({ query }),
    ah(async (req, res) => {
      const visible = await visibleNetworkIds(req.user);
      const ids = req.valid.query.networkId ? visible.filter((x) => String(x) === req.valid.query.networkId) : visible;
      const [networks, analytics, briefs] = await Promise.all([
        Network.find({ _id: { $in: visible } }, { name: 1, cidr: 1 }).sort({ name: 1 }).lean(),
        computeAnalytics(ids, config),
        latestBriefings(ids),
      ]);
      const byId = new Map(networks.map((n) => [String(n._id), n]));
      const { _state, ...rest } = analytics;
      send(res, {
        networks: networks.map((n) => ({ id: String(n._id), name: n.name, cidr: n.cidr })),
        scope: req.valid.query.networkId || 'all',
        analytics: rest,
        briefings: briefs.map((b) => ({
          networkId: b.networkId,
          networkName: byId.get(b.networkId)?.name || null,
          latest: serializeBriefing(b.latest, byId.get(b.networkId)),
          lastAttempt: b.lastAttempt && b.lastAttempt.status !== 'completed' ? serializeBriefing(b.lastAttempt, byId.get(b.networkId)) : null,
        })),
        ai: {
          configured: Boolean(config.DIAGNOSTIC_SERVICE_URL),
          scheduleMinutes: config.DIAGNOSTIC_SERVICE_URL ? config.BRIEFING_INTERVAL_MINUTES : 0,
        },
      });
    }),
  );

  r.post(
    '/insights/briefings',
    requirePermission('incidents:diagnose'),
    requireCsrf,
    limits.sensitive,
    validate({ body }),
    ah(async (req, res) => {
      if (!config.DIAGNOSTIC_SERVICE_URL) throw conflict('DIAGNOSTIC_SERVICE_DISABLED', 'DIAGNOSTIC_SERVICE_URL is not configured — start the diagnostic service');
      const visible = await visibleNetworkIds(req.user);
      if (!visible.some((x) => String(x) === req.valid.body.networkId)) throw notFound('Network');
      const network = await Network.findById(req.valid.body.networkId).lean();
      if (!network) throw notFound('Network');
      const b = await generateBriefing({ network, config, trigger: 'operator', user: req.user, req });
      req.app.locals.realtime?.emitNetwork(network._id, 'insight:update', { networkId: String(network._id) });
      send(res, serializeBriefing(b.toObject(), network), 201);
    }),
  );

  return r;
}

module.exports = { insightsRouter };
