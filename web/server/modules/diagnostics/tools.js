'use strict';

const { Heartbeat, Measurement, PeerObservation } = require('../../database/models/telemetry');
const { Incident, ProposedAction } = require('../../database/models/incidents');
const { AgentCommand } = require('../../database/models/device');
const { AuditEvent } = require('../../database/models/audit');
const { loadNetworkState } = require('../telemetry/state.service');
const { currentRelay } = require('../relay/relay');

/**
 * Read-only diagnostic tool registry. These are the ONLY data sources a
 * diagnostic planner (deterministic or LLM-backed) can draw on. Each tool
 * returns evidence items with stable refs; observations must cite these refs.
 * No tool can mutate state, run shell commands, or reach arbitrary APIs.
 */

const e = (ref, kind, summary, observedAt, data) => ({ ref, kind, summary, observedAt: observedAt || null, data: data ?? null });

// Where a measurement went — spelled out so tunnel and internet paths are never confused.
const LABEL = {
  peer: 'tunnel to peer (through WireGuard)',
  control_plane: 'control plane over the internet (not the tunnel)',
  relay: 'relay',
  interface: 'local interface',
};

const TOOLS = {
  get_device_status: {
    description: 'Computed agent / VPN / overall health for the affected device',
    async run({ device, state }) {
      const h = state.health.get(String(device._id));
      return [
        e(`device:${device._id}:health`, 'device_health', `Overall ${h.status}; agent ${h.agent.status}; VPN ${h.vpn.state}`, h.evaluatedAt, {
          status: h.status,
          agent: h.agent,
          vpn: { state: h.vpn.state, source: h.vpn.source || null, observedAt: h.vpn.observedAt, stale: h.vpn.stale },
          reasons: h.reasons,
        }),
      ];
    },
  },
  get_heartbeat_history: {
    description: 'Last 10 heartbeats received from the agent (server timestamps)',
    async run({ device }) {
      const hbs = await Heartbeat.find({ deviceId: device._id }).sort({ receivedAt: -1 }).limit(10).lean();
      if (!hbs.length) return [e(`device:${device._id}:heartbeats`, 'heartbeat_history', 'No heartbeats on record', null, { count: 0 })];
      return hbs.map((h) =>
        e(`heartbeat:${h._id}`, 'heartbeat', `seq ${h.sequence} health=${h.health} vpn=${h.vpnInterface?.state || 'unknown'}`, h.receivedAt, {
          health: h.health,
          details: h.healthDetails,
          vpn: h.vpnInterface,
          clockSkewMs: h.clockSkewMs,
        }),
      );
    },
  },
  get_latest_vpn_handshake: {
    description: 'WireGuard handshake observations reported by this device and its peers',
    async run({ device }) {
      const obs = await PeerObservation.find({ $or: [{ deviceId: device._id }, { peerDeviceId: device._id }] }).lean();
      if (!obs.length) return [e(`device:${device._id}:handshakes`, 'handshake', 'No WireGuard peer observations reported', null, { count: 0 })];
      return obs.map((o) =>
        e(
          `peerobs:${o._id}`,
          'handshake',
          `${String(o.deviceId) === String(device._id) ? 'This device' : 'Peer'} saw last handshake ${o.lastHandshakeAt ? o.lastHandshakeAt.toISOString() : 'never'}`,
          o.observedAt,
          { observer: String(o.deviceId), peer: String(o.peerDeviceId), lastHandshakeAt: o.lastHandshakeAt, endpoint: o.endpoint },
        ),
      );
    },
  },
  get_recent_network_events: {
    description: 'Recent audit events and incidents for the device',
    async run({ device }) {
      const [events, incidents] = await Promise.all([
        AuditEvent.find({ 'target.id': String(device._id) }).sort({ at: -1 }).limit(10).lean(),
        Incident.find({ deviceId: device._id }).sort({ detectedAt: -1 }).limit(5).lean(),
      ]);
      return [
        ...events.map((a) => e(`audit:${a._id}`, 'audit_event', `${a.operation} (${a.decision}/${a.outcome})`, a.at, { operation: a.operation })),
        ...incidents.map((i) => e(`incident:${i._id}`, 'incident', `${i.category} ${i.state}`, i.detectedAt, { category: i.category, state: i.state })),
      ];
    },
  },
  get_network_measurements: {
    description: 'Most recent RTT / loss / jitter / handshake-age measurements (last 30 min)',
    async run({ device }) {
      const since = new Date(Date.now() - 1800_000);
      const ms = await Measurement.find({ deviceId: device._id, measuredAt: { $gte: since } }).sort({ measuredAt: -1 }).limit(20).lean();
      if (!ms.length) return [e(`device:${device._id}:measurements`, 'measurement', 'No measurements in the last 30 minutes', null, { count: 0 })];
      return ms.map((m) =>
        e(
          `measurement:${m._id}`,
          m.type,
          m.valid ? `${LABEL[m.target.kind] || m.target.kind}: ${m.type}=${m.value}${m.unit} (${m.source})` : `${LABEL[m.target.kind] || m.target.kind}: ${m.type} unavailable — ${m.error || 'no value'}`,
          m.measuredAt,
          { value: m.value, unit: m.unit, valid: m.valid, source: m.source, target: m.target.kind },
        ),
      );
    },
  },
  get_route_information: {
    description: 'Endpoint candidates and reflexive address reported for the device',
    async run({ device }) {
      return [
        e(`device:${device._id}:endpoints`, 'endpoints', `Reported ${device.endpoints?.reported?.length || 0} endpoint candidate(s)`, device.endpoints?.observedAt, {
          reported: device.endpoints?.reported || [],
          reflexiveAddress: device.endpoints?.reflexiveAddress || null,
          note: 'Routing-table collection from the agent is not implemented yet',
        }),
      ];
    },
  },
  get_recent_transfer_tests: {
    description: 'Data-transfer tests through the tunnel (last 24 h): size, duration, throughput, path, and whether the peer confirmed the checksum',
    async run({ device, state }) {
      const since = new Date(Date.now() - 86400_000);
      const acts = await ProposedAction.find({ deviceId: device._id, actionType: 'run_transfer_test', createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(5).lean();
      if (!acts.length) return [e(`device:${device._id}:transfers`, 'transfer_test', 'No transfer tests in the last 24 hours', null, { count: 0 })];
      const cmds = new Map((await AgentCommand.find({ _id: { $in: acts.map((a) => a.commandId).filter(Boolean) } }).lean()).map((c) => [String(c._id), c]));
      return acts.map((a) => {
        const out = cmds.get(String(a.commandId))?.result?.output || {};
        const link = state.links.find((l) => [l.source, l.target].includes(String(a.params?.peerDeviceId)) && [l.source, l.target].includes(String(device._id)));
        const done = typeof out.bytesSent === 'number';
        const summary = done
          ? `Transfer test to peer: ${(out.bytesSent / 1048576).toFixed(1)} MB in ${(out.durationMs / 1000).toFixed(2)} s = ${Number(out.mbitPerSecond).toFixed(1)} Mbit/s through the tunnel; peer confirmed ${(out.bytesConfirmed / 1048576).toFixed(1)} MB, checksum ${out.integrityMatch ? 'matches' : 'MISMATCH'}; link path now ${link?.path || 'unknown'}`
          : `Transfer test ${a.status}${a.verification?.outcome ? ` (${a.verification.outcome})` : ''}: ${(a.verification?.notes || []).join('; ') || 'no result'}`;
        return e(`action:${a._id}`, 'transfer_test', summary, a.updatedAt || a.createdAt, {
          megabytes: a.params?.megabytes ?? null,
          mbitPerSecond: out.mbitPerSecond ?? null,
          durationMs: out.durationMs ?? null,
          integrityMatch: out.integrityMatch ?? null,
          path: link?.path || null,
          outcome: a.verification?.outcome || null,
        });
      });
    },
  },
  check_relay_health: {
    description: 'Encrypted relay: is this device connected to it, how much it relayed, which tunnels use it',
    async run({ device, state, config }) {
      const id = String(device._id);
      if (!config.RELAY_ENABLED) return [e(`relay:${id}`, 'relay', 'Relay disabled by configuration; only direct UDP paths are possible', null, { enabled: false })];
      const st = currentRelay()?.status(id) || { connected: false };
      const viaRelay = state.links.filter((l) => (l.source === id || l.target === id) && l.path === 'relay').length;
      const summary = st.connected
        ? `Agent connected to the relay since ${new Date(st.since).toISOString()}; ${st.rxBytes + st.txBytes} bytes relayed, ${st.dropped} frames dropped; ${viaRelay} tunnel(s) currently via relay`
        : `Agent not connected to the relay (userspace agents connect automatically; kernel/WireGuard-app mode cannot use it); ${viaRelay} tunnel(s) via relay`;
      return [e(`relay:${id}`, 'relay', summary, st.since || null, { enabled: true, connected: st.connected, dropped: st.dropped ?? null, tunnelsViaRelay: viaRelay })];
    },
  },
};

async function collectEvidence({ device, incident, config }) {
  const state = await loadNetworkState([device.networkId], config);
  const evidence = [];
  const toolsRun = [];
  for (const [name, tool] of Object.entries(TOOLS)) {
    const startedAt = new Date();
    try {
      const items = await tool.run({ device, incident, state, config });
      evidence.push(...items);
      toolsRun.push({ tool: name, ok: true, items: items.length, refs: items.map((x) => x.ref).slice(0, 50), startedAt, ms: Date.now() - startedAt });
    } catch (err) {
      toolsRun.push({ tool: name, ok: false, error: err.message.slice(0, 200), items: 0, refs: [], startedAt, ms: Date.now() - startedAt });
    }
  }
  // Incident's own detection evidence is citable too.
  for (const item of incident.evidence || []) evidence.push(item.toObject ? item.toObject() : item);
  const unique = [...new Map(evidence.map((x) => [x.ref, x])).values()];
  return { evidence: unique, toolsRun, state };
}

const describeTools = () => Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, readOnly: true }));

module.exports = { TOOLS, collectEvidence, describeTools };
