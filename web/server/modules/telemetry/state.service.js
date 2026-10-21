'use strict';

const { Device } = require('../../database/models/device');
const { Membership, Network } = require('../../database/models/network');
const { PeerObservation, Measurement } = require('../../database/models/telemetry');
const { computeDeviceHealth, peerLinkState, thresholds } = require('./health');

const pairKey = (a, b) => [String(a), String(b)].sort().join(':');

/**
 * Loads everything needed to evaluate device health and peer links for a set
 * of networks, in a fixed number of queries.
 */
async function loadNetworkState(networkIds, config, now = Date.now()) {
  const t = thresholds(config);
  const [networks, devices, memberships, observations] = await Promise.all([
    Network.find({ _id: { $in: networkIds } }).lean(),
    Device.find({ networkId: { $in: networkIds } }).lean(),
    Membership.find({ networkId: { $in: networkIds }, status: { $in: ['active', 'revoked'] } }).lean(),
    PeerObservation.find({ networkId: { $in: networkIds } }).lean(),
  ]);
  const deviceIds = devices.map((d) => d._id);
  const since = new Date(now - Math.max(t.telemetryFreshSec, 900) * 1000);
  const measurements = await Measurement.find({ deviceId: { $in: deviceIds }, measuredAt: { $gte: since } })
    .sort({ measuredAt: -1 })
    .limit(5000)
    .lean();

  const obsByPair = new Map();
  for (const o of observations) {
    const k = pairKey(o.deviceId, o.peerDeviceId);
    if (!obsByPair.has(k)) obsByPair.set(k, []);
    obsByPair.get(k).push(o);
  }
  const measByDevice = new Map();
  for (const m of measurements) {
    const k = String(m.deviceId);
    if (!measByDevice.has(k)) measByDevice.set(k, []);
    measByDevice.get(k).push(m);
  }

  const activeByNetwork = new Map();
  for (const m of memberships.filter((x) => x.status === 'active')) {
    const k = String(m.networkId);
    if (!activeByNetwork.has(k)) activeByNetwork.set(k, []);
    activeByNetwork.get(k).push(m);
  }

  // Configured relationships = every pair of active members (full mesh).
  const links = [];
  for (const [networkId, members] of activeByNetwork) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i].deviceId;
        const b = members[j].deviceId;
        const obs = obsByPair.get(pairKey(a, b)) || [];
        const peerMeas = [
          ...(measByDevice.get(String(a)) || []).filter((m) => String(m.target?.peerDeviceId) === String(b)),
          ...(measByDevice.get(String(b)) || []).filter((m) => String(m.target?.peerDeviceId) === String(a)),
        ];
        const link = peerLinkState({ observations: obs, peerMeasurements: peerMeas, now, t });
        links.push({
          id: pairKey(a, b),
          networkId,
          source: String(a),
          target: String(b),
          configured: true,
          ...link,
          observedBy: obs.map((o) => ({ deviceId: String(o.deviceId), observedAt: o.observedAt, lastHandshakeAt: o.lastHandshakeAt, endpoint: o.endpoint })),
        });
      }
    }
  }

  const membershipByDevice = new Map(memberships.map((m) => [String(m.deviceId), m]));
  const health = new Map();
  for (const d of devices) {
    const id = String(d._id);
    const m = membershipByDevice.get(id);
    const peers = m && m.status === 'active' ? (activeByNetwork.get(String(m.networkId)) || []).length - 1 : 0;
    const myLinks = links.filter((l) => l.source === id || l.target === id);
    health.set(
      id,
      computeDeviceHealth(d, {
        now,
        config,
        peerLinks: myLinks,
        measurements: measByDevice.get(id) || [],
        expectedPeers: Math.max(0, peers),
      }),
    );
  }

  return { networks, devices, memberships, membershipByDevice, links, health, measByDevice };
}

function serializeDevice(d, { health, membership }) {
  return {
    id: String(d._id),
    name: d.name,
    networkId: String(d.networkId),
    enrollmentState: d.enrollmentState,
    identityFingerprint: d.identityFingerprint,
    wireguardFingerprint: d.wireguardFingerprint,
    agentVersion: d.agentVersion,
    platform: d.platform,
    capabilities: d.capabilities || [],
    enrolledAt: d.enrolledAt,
    revokedAt: d.revokedAt,
    revocationReason: d.revocationReason,
    lastHeartbeatAt: d.lastHeartbeatAt,
    lastTelemetryAt: d.lastTelemetryAt,
    membership: membership
      ? { networkId: String(membership.networkId), address: membership.address, status: membership.status, joinedAt: membership.joinedAt }
      : null,
    health: health || null,
    createdAt: d.createdAt,
  };
}

module.exports = { loadNetworkState, serializeDevice, pairKey };
