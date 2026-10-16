'use strict';

const express = require('express');
const { z } = require('zod');
const { Network } = require('../../database/models/network');
const { Incident } = require('../../database/models/incidents');
const { AuditEvent } = require('../../database/models/audit');
const { ProposedAction } = require('../../database/models/incidents');
const { validate } = require('../../middleware/validate');
const { requirePermission } = require('../../middleware/auth');
const { send, ah, objectId } = require('../../utils/http');
const { visibleNetworkIds } = require('../networks/scope');
const { loadNetworkState } = require('../telemetry/state.service');

const topoQuery = z.object({ networkId: objectId.optional() }).strict();

function topologyRouter({ config }) {
  const r = express.Router();

  /**
   * Graph for React Flow. Edges carry an explicit `kind`:
   *   control   — agent ↔ control plane (heartbeat channel, NOT the data plane)
   *   peer      — configured WireGuard peer pair with its *observed* state
   * A peer edge's state is "configured" until there is handshake evidence.
   */
  r.get(
    '/topology',
    requirePermission('networks:read'),
    validate({ query: topoQuery }),
    ah(async (req, res) => {
      let ids = await visibleNetworkIds(req.user);
      if (req.valid.query.networkId) ids = ids.filter((x) => String(x) === req.valid.query.networkId);
      const state = await loadNetworkState(ids, config);
      const nodes = [{ id: 'control-plane', type: 'controlPlane', label: 'Control plane' }];
      const edges = [];
      for (const n of state.networks) {
        nodes.push({ id: `net:${n._id}`, type: 'network', label: n.name, cidr: n.cidr, networkId: String(n._id) });
      }
      for (const d of state.devices) {
        if (d.enrollmentState === 'pending') continue;
        const id = String(d._id);
        const h = state.health.get(id);
        const m = state.membershipByDevice.get(id);
        nodes.push({
          id,
          type: 'device',
          label: d.name,
          networkId: String(d.networkId),
          address: m?.status === 'active' ? m.address : null,
          enrollmentState: d.enrollmentState,
          status: h.status,
          agent: h.agent.status,
          vpn: h.vpn.state,
          vpnSource: h.vpn.source || null,
          lastHeartbeatAt: d.lastHeartbeatAt,
          lastHandshakeAt: h.lastHandshakeAt,
        });
        if (d.enrollmentState === 'enrolled') {
          edges.push({
            id: `ctl:${id}`,
            kind: 'control',
            source: id,
            target: 'control-plane',
            state: { online: 'connected', stale: 'degraded', offline: 'unreachable', never_seen: 'unknown' }[h.agent.status],
            observedAt: d.lastHeartbeatAt,
          });
        }
        if (m?.status === 'active') edges.push({ id: `mem:${id}`, kind: 'membership', source: id, target: `net:${d.networkId}`, state: 'configured' });
      }
      for (const l of state.links) {
        edges.push({
          id: `peer:${l.id}`,
          kind: 'peer',
          source: l.source,
          target: l.target,
          state: l.state,
          path: l.path,
          lastHandshakeAt: l.lastHandshakeAt,
          reason: l.reason || null,
          evidence: l.observedBy,
        });
      }
      send(res, { nodes, edges, generatedAt: new Date() });
    }),
  );

  r.get(
    '/overview',
    requirePermission('networks:read'),
    ah(async (req, res) => {
      const ids = await visibleNetworkIds(req.user);
      const state = await loadNetworkState(ids, config);
      const counts = { healthy: 0, degraded: 0, unreachable: 0, unknown: 0, pending_enrollment: 0, revoked: 0 };
      for (const h of state.health.values()) counts[h.status] = (counts[h.status] || 0) + 1;
      const [incidents, actions, pendingApprovals] = await Promise.all([
        Incident.find({ networkId: { $in: ids } }).sort({ detectedAt: -1 }).limit(6).lean(),
        AuditEvent.find(
          req.user.role === 'admin' ? { 'actor.type': 'user' } : { 'actor.type': 'user', $or: [{ networkId: { $in: ids } }, { 'actor.id': String(req.user._id) }] },
        )
          .sort({ at: -1 })
          .limit(8)
          .lean(),
        ProposedAction.countDocuments({ networkId: { $in: ids }, status: 'awaiting_approval' }),
      ]);
      const linkStates = state.links.reduce((acc, l) => ({ ...acc, [l.state]: (acc[l.state] || 0) + 1 }), {});
      send(res, {
        networks: state.networks.length,
        devices: { registered: state.devices.length, ...counts },
        peerLinks: { configured: state.links.length, ...linkStates },
        activeIncidents: await Incident.countDocuments({ networkId: { $in: ids }, active: true }),
        pendingApprovals,
        recentIncidents: incidents.map((i) => ({ id: String(i._id), title: i.title, category: i.category, severity: i.severity, state: i.state, source: i.source, detectedAt: i.detectedAt })),
        recentActions: actions.map((a) => ({ id: String(a._id), at: a.at, actor: a.actor.label, operation: a.operation, target: a.target, decision: a.decision, outcome: a.outcome })),
        evaluatedAt: new Date(),
      });
    }),
  );

  return r;
}

module.exports = { topologyRouter };
