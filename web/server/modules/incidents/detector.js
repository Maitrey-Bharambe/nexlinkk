'use strict';

const { Incident } = require('../../database/models/incidents');
const { Network } = require('../../database/models/network');
const { loadNetworkState } = require('../telemetry/state.service');
const { latestValid, ageSec } = require('../telemetry/health');
const audit = require('../audit/audit.service');

const LOSS_HIGH_PCT = 20;
const RTT_HIGH_MS = 300;
const MEASUREMENT_FRESH_SEC = 600;
const NEVER_REPORTED_GRACE_SEC = 600;

const ev = (ref, kind, summary, observedAt, data = null) => ({ ref, kind, summary, observedAt: observedAt || null, data });

/**
 * Evaluates every incident condition for one device. Each result is
 *   holds: true  — condition observed now
 *   holds: false — condition observed NOT to hold (fresh evidence)
 *   holds: null  — cannot tell; nothing is opened or resolved
 */
function evaluateConditions({ device, health, links, measurements, now }) {
  const id = String(device._id);
  const out = [];
  const agent = health.agent;

  // 1. Agent heartbeat
  let agentHolds = null;
  if (agent.status === 'offline') agentHolds = true;
  else if (agent.status === 'online') agentHolds = false;
  else if (agent.status === 'never_seen' && ageSec(device.enrolledAt, now) > NEVER_REPORTED_GRACE_SEC) agentHolds = true;
  out.push({
    category: 'agent_offline',
    severity: 'high',
    holds: agentHolds,
    title: agent.status === 'never_seen' ? `${device.name}: agent enrolled but never reported` : `${device.name}: agent heartbeats stopped`,
    evidence: [
      ev(
        `device:${id}:heartbeat`,
        'heartbeat_freshness',
        agent.lastHeartbeatAt ? `Last heartbeat ${agent.ageSec}s ago (status ${agent.status})` : 'No heartbeat ever received',
        agent.lastHeartbeatAt,
        { status: agent.status, ageSec: agent.ageSec },
      ),
    ],
  });

  const agentOnline = agent.status === 'online';
  const vpn = health.vpn;

  // 2. VPN interface
  let vpnHolds = null;
  if (agentOnline && vpn.source !== 'simulated') {
    if (vpn.state === 'down' || vpn.state === 'absent') vpnHolds = true;
    else if (vpn.state === 'up') vpnHolds = false;
  }
  out.push({
    category: 'vpn_interface_down',
    severity: 'medium',
    holds: vpnHolds,
    title: `${device.name}: WireGuard interface ${vpn.state}`,
    evidence: [
      ev(`device:${id}:vpn`, 'vpn_interface', `Interface ${vpn.interfaceName || '(unnamed)'} reported ${vpn.state} via ${vpn.source || 'n/a'}`, vpn.observedAt, {
        state: vpn.state,
        source: vpn.source || null,
      }),
    ],
  });

  // 3. Peer handshakes (one condition per configured peer)
  for (const link of links) {
    const peerId = link.source === id ? link.target : link.source;
    let holds = null;
    if (agentOnline && vpn.state === 'up' && vpn.source !== 'simulated') {
      if (link.state === 'unreachable') holds = true;
      else if (link.state === 'connected' || link.state === 'degraded') holds = false;
      else if (link.state === 'connecting') {
        const mine = link.observedBy.find((o) => o.deviceId === id);
        if (mine && ageSec(device.enrolledAt, now) > NEVER_REPORTED_GRACE_SEC) holds = true;
      }
    }
    out.push({
      category: 'peer_handshake_stale',
      peerDeviceId: peerId,
      severity: 'medium',
      holds,
      title: `${device.name}: no fresh WireGuard handshake with peer`,
      evidence: [
        ev(`link:${link.id}`, 'peer_link', `Link state ${link.state}${link.reason ? ` (${link.reason})` : ''}`, link.lastHandshakeAt, {
          state: link.state,
          lastHandshakeAt: link.lastHandshakeAt,
          path: link.path,
        }),
      ],
    });
  }

  // 4/5. Loss and latency from the most recent valid measurement
  const fresh = measurements.filter((m) => ageSec(m.measuredAt, now) <= MEASUREMENT_FRESH_SEC);
  for (const [category, type, limit, unit, severity] of [
    ['packet_loss_high', 'packet_loss', LOSS_HIGH_PCT, '%', 'medium'],
    ['latency_high', 'rtt', RTT_HIGH_MS, 'ms', 'low'],
  ]) {
    const m = latestValid(fresh, type);
    out.push({
      category,
      severity,
      holds: m ? m.value > limit : null,
      title: `${device.name}: ${type === 'rtt' ? 'latency' : 'packet loss'} above ${limit}${unit}`,
      evidence: m
        ? [ev(`measurement:${m._id}`, type, `${type} ${m.value}${m.unit} to ${m.target.kind}${m.target.ref ? ` ${m.target.ref}` : ''} via ${m.source}`, m.measuredAt, { value: m.value, unit: m.unit })]
        : [],
    });
  }
  return out;
}

async function applyConditions({ device, conditions, realtime }) {
  const now = new Date();
  for (const c of conditions) {
    const key = { deviceId: device._id, category: c.category, peerDeviceId: c.peerDeviceId || null, active: true };
    if (c.holds === true) {
      const existing = await Incident.findOne(key);
      if (existing) {
        existing.lastObservedAt = now;
        existing.evidence = [...c.evidence, ...existing.evidence].slice(0, 20);
        await existing.save();
        continue;
      }
      try {
        const inc = await Incident.create({
          ...key,
          severity: c.severity,
          source: 'detector',
          title: c.title,
          networkId: device.networkId,
          detectedAt: now,
          lastObservedAt: now,
          evidence: c.evidence,
        });
        await audit.record({
          actor: audit.SYSTEM_ACTOR,
          operation: 'incident.detect',
          target: { type: 'device', id: String(device._id), label: device.name },
          networkId: device.networkId,
          incidentId: inc._id,
          metadata: { category: c.category },
        });
        realtime?.emitNetwork(device.networkId, 'incident:update', { incidentId: String(inc._id) });
      } catch (err) {
        if (err?.code !== 11000) throw err; // another detector pass won the race
      }
    } else if (c.holds === false) {
      // Only detector-raised incidents auto-resolve, and only on positive evidence.
      const inc = await Incident.findOne({ ...key, source: 'detector' });
      if (!inc) continue;
      inc.state = 'resolved';
      inc.active = false;
      inc.resolution = {
        method: 'condition_cleared_observed',
        verifiedAt: now,
        evidence: c.evidence,
        note: 'Detector observed the condition no longer holds',
      };
      await inc.save();
      await audit.record({
        actor: audit.SYSTEM_ACTOR,
        operation: 'incident.resolve',
        target: { type: 'device', id: String(device._id), label: device.name },
        networkId: device.networkId,
        incidentId: inc._id,
        metadata: { category: c.category, method: 'condition_cleared_observed' },
      });
      realtime?.emitNetwork(device.networkId, 'incident:update', { incidentId: String(inc._id) });
    }
  }
}

async function runDetector({ config, realtime, networkIds, deviceId } = {}) {
  const ids = networkIds || (await Network.find({ status: 'active' }).select('_id').lean()).map((n) => n._id);
  if (!ids.length) return { evaluated: 0 };
  const state = await loadNetworkState(ids, config);
  const now = Date.now();
  let evaluated = 0;
  for (const device of state.devices) {
    if (device.enrollmentState !== 'enrolled') continue;
    if (deviceId && String(device._id) !== String(deviceId)) continue;
    const id = String(device._id);
    const conditions = evaluateConditions({
      device,
      health: state.health.get(id),
      links: state.links.filter((l) => l.source === id || l.target === id),
      measurements: state.measByDevice.get(id) || [],
      now,
    });
    await applyConditions({ device, conditions, realtime });
    evaluated++;
  }
  return { evaluated };
}

function startDetector({ config, logger, realtime }) {
  if (!config.INCIDENT_DETECTOR_INTERVAL_SECONDS) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDetector({ config, realtime });
    } catch (err) {
      logger.error({ err }, 'incident detector pass failed');
    } finally {
      running = false;
    }
  }, config.INCIDENT_DETECTOR_INTERVAL_SECONDS * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { evaluateConditions, applyConditions, runDetector, startDetector, LOSS_HIGH_PCT, RTT_HIGH_MS };
