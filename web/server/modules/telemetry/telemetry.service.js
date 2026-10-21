'use strict';

const { Device } = require('../../database/models/device');
const { Membership, Network } = require('../../database/models/network');
const { Heartbeat, Measurement, PeerObservation } = require('../../database/models/telemetry');
const { conflict, badRequest } = require('../../utils/errors');

const days = (n) => n * 86400_000;
const REAL_WG_SOURCES = new Set(['wgctrl', 'wireguard-go']);

function assertSameDevice(device, bodyDeviceId) {
  // The authenticated identity wins. A body naming another device is rejected,
  // not silently re-attributed.
  if (String(device._id) !== bodyDeviceId) {
    throw badRequest('DEVICE_ID_MISMATCH', 'deviceId does not match the authenticated agent');
  }
}

function assertFresh(isoTime, config, label) {
  const t = new Date(isoTime).getTime();
  const now = Date.now();
  if (t - now > config.AGENT_CLOCK_SKEW_SECONDS * 1000) throw badRequest('TIMESTAMP_IN_FUTURE', `${label} is in the future`);
  if (now - t > 3600_000) throw badRequest('TIMESTAMP_STALE', `${label} is more than one hour old`);
}

async function recordHeartbeat(device, hb, { config, sourceAddress }) {
  assertSameDevice(device, hb.deviceId);
  const receivedAt = new Date();
  const agentTime = new Date(hb.agentTime);
  const clockSkewMs = agentTime.getTime() - receivedAt.getTime();

  // Atomic monotonic-sequence check: within one agent boot the sequence must
  // strictly increase; a new bootId resets it.
  const upd = await Device.updateOne(
    {
      _id: device._id,
      enrollmentState: 'enrolled',
      $or: [{ 'lastHeartbeat.bootId': { $ne: hb.bootId } }, { 'lastHeartbeat.sequence': { $lt: hb.sequence } }],
    },
    {
      lastHeartbeatAt: receivedAt,
      lastHeartbeat: { bootId: hb.bootId, sequence: hb.sequence, agentTime, health: hb.health.status, clockSkewMs },
      agentVersion: hb.agentVersion,
      capabilities: hb.capabilities,
    },
  );
  if (upd.matchedCount === 0) {
    throw conflict('STALE_SEQUENCE', 'Heartbeat sequence not newer than last accepted heartbeat for this boot');
  }

  const doc = await Heartbeat.create({
    deviceId: device._id,
    receivedAt,
    agentTime,
    bootId: hb.bootId,
    sequence: hb.sequence,
    agentVersion: hb.agentVersion,
    health: hb.health.status,
    healthDetails: hb.health.details,
    vpnInterface: hb.vpnInterface || { name: null, state: 'unknown' },
    clockSkewMs,
    sourceAddress,
    expiresAt: new Date(receivedAt.getTime() + days(config.HEARTBEAT_RETENTION_DAYS)),
  });
  return { heartbeat: doc, receivedAt, clockSkewMs };
}

function measurementDoc(device, m, { networkId, peerDeviceId, config, commandId = null }) {
  const receivedAt = new Date();
  return {
    deviceId: device._id,
    networkId,
    type: m.type,
    target: { kind: m.target.kind, ref: m.target.ref, peerDeviceId: peerDeviceId || null },
    value: m.value,
    unit: m.unit,
    valid: m.valid,
    source: m.source,
    sampleCount: m.sampleCount ?? null,
    error: m.error ?? null,
    measuredAt: new Date(m.measuredAt),
    receivedAt,
    commandId,
    expiresAt: new Date(receivedAt.getTime() + days(config.MEASUREMENT_RETENTION_DAYS)),
  };
}

/** Maps WireGuard public keys / tunnel addresses to devices in the same network. */
async function peerResolver(networkId, selfId) {
  if (!networkId) return { byKey: new Map(), byAddr: new Map() };
  const members = await Membership.find({ networkId, status: 'active', deviceId: { $ne: selfId } }).lean();
  const devices = await Device.find({ _id: { $in: members.map((m) => m.deviceId) } })
    .select('wireguardPublicKey')
    .lean();
  const byKey = new Map(devices.filter((d) => d.wireguardPublicKey).map((d) => [d.wireguardPublicKey, d._id]));
  const byAddr = new Map(members.map((m) => [m.address, m.deviceId]));
  return { byKey, byAddr };
}

async function ingestMeasurements(device, measurements, { networkId, config, commandId }) {
  if (!measurements.length) return 0;
  const { byKey, byAddr } = await peerResolver(networkId, device._id);
  const docs = measurements.map((m) => {
    const peerDeviceId = m.target.kind === 'peer' ? byKey.get(m.target.ref) || byAddr.get(m.target.ref) || null : null;
    return measurementDoc(device, m, { networkId, peerDeviceId, config, commandId });
  });
  await Measurement.insertMany(docs);
  return docs.length;
}

async function recordTelemetry(device, t, { config, sourceAddress }) {
  assertSameDevice(device, t.deviceId);
  assertFresh(t.measuredAt, config, 'measuredAt');
  for (const m of t.measurements) assertFresh(m.measuredAt, config, 'measurement.measuredAt');

  const now = new Date();
  const measuredAt = new Date(t.measuredAt);
  const membership = await Membership.findOne({ deviceId: device._id, status: 'active' }).lean();
  const networkId = membership?.networkId || null;

  const iface = t.interface;
  const keyMatches = iface.publicKey ? iface.publicKey === device.wireguardPublicKey : null;
  await Device.updateOne(
    { _id: device._id },
    {
      lastTelemetryAt: now,
      vpn: {
        interfaceName: iface.name,
        state: iface.state,
        listenPort: iface.listenPort,
        appliedConfigVersion: iface.appliedConfigVersion,
        observedAt: measuredAt,
        source: iface.source,
        keyMatches,
      },
      endpoints: { reported: t.endpointCandidates, reflexiveAddress: sourceAddress || null, observedAt: now },
    },
  );

  // Peer observations: only real WireGuard reads (kernel/WireGuardNT or
  // wireguard-go) are stored as observed state — never simulated data.
  const { byKey } = await peerResolver(networkId, device._id);
  const unknownPeers = [];
  const derived = [];
  if (REAL_WG_SOURCES.has(iface.source) && networkId) {
    const reported = [];
    for (const p of t.peers) {
      const peerDeviceId = byKey.get(p.publicKey);
      if (!peerDeviceId) {
        unknownPeers.push(p.publicKey);
        continue;
      }
      reported.push(peerDeviceId);
      const lastHandshakeAt = p.lastHandshakeAt ? new Date(p.lastHandshakeAt) : null;
      await PeerObservation.updateOne(
        { deviceId: device._id, peerDeviceId },
        {
          $set: {
            networkId,
            peerFingerprint: p.publicKey,
            lastHandshakeAt,
            endpoint: p.endpoint,
            // Relay transport is not implemented yet; a WireGuard peer endpoint is a direct UDP path.
            path: p.endpoint ? 'direct' : 'unknown',
            rxBytes: p.rxBytes,
            txBytes: p.txBytes,
            observedAt: measuredAt,
          },
          $setOnInsert: { firstObservedAt: measuredAt },
        },
        { upsert: true },
      );
      derived.push({
        type: 'handshake_age',
        target: { kind: 'peer', ref: p.publicKey },
        value: lastHandshakeAt ? Math.max(0, (measuredAt - lastHandshakeAt) / 1000) : null,
        unit: 's',
        valid: Boolean(lastHandshakeAt),
        source: 'wireguard',
        sampleCount: 1,
        error: lastHandshakeAt ? null : 'no handshake recorded by WireGuard',
        measuredAt: t.measuredAt,
      });
    }
    // A peer missing from a real WireGuard report is no longer on the
    // interface: drop the stale observation so the link reverts to "configured".
    await PeerObservation.deleteMany({ deviceId: device._id, peerDeviceId: { $nin: reported } });
  }

  const stored = await ingestMeasurements(device, [...t.measurements, ...derived], { networkId, config });
  const network = networkId ? await Network.findById(networkId).select('configVersion').lean() : null;
  return { stored, unknownPeers, configVersion: network?.configVersion ?? null, keyMatches };
}

module.exports = { recordHeartbeat, recordTelemetry, ingestMeasurements, assertSameDevice };
