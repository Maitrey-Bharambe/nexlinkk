'use strict';

const { Heartbeat, Measurement, PeerObservation, AgentEvent } = require('../../database/models/telemetry');
const { Incident, ProposedAction } = require('../../database/models/incidents');
const { loadNetworkState } = require('../telemetry/state.service');

const WINDOWS = { '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };
const BUCKETS = 48;

const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// Agent log lines worth putting on a timeline: path changes and failures.
const NOTABLE = /relay|direct path|tunnel peers updated|remote session|failed|refused|disconnected|could not/i;

/**
 * One device's measurements over a window, bucketed for charts, with the
 * events that happened in the same window and per-peer connection details.
 * Every value comes from stored records; unmeasured buckets are null.
 */
async function deviceMetrics(device, windowKey, config, now = Date.now()) {
  const span = WINDOWS[windowKey];
  const from = new Date(now - span);
  const bucketMs = span / BUCKETS;

  const [ms, incidents, actions, heartbeats, events, state] = await Promise.all([
    Measurement.find({ deviceId: device._id, measuredAt: { $gte: from } }, { type: 1, value: 1, valid: 1, error: 1, measuredAt: 1, target: 1, source: 1, commandId: 1 })
      .sort({ measuredAt: 1 })
      .limit(50_000)
      .lean(),
    Incident.find({ $or: [{ deviceId: device._id }, { peerDeviceId: device._id }], detectedAt: { $gte: new Date(now - Math.max(span, 7 * 86400_000)) } })
      .sort({ detectedAt: -1 })
      .limit(50)
      .lean(),
    ProposedAction.find({ deviceId: device._id, createdAt: { $gte: from } }).sort({ createdAt: -1 }).limit(50).lean(),
    Heartbeat.find({ deviceId: device._id, receivedAt: { $gte: from } }, { receivedAt: 1 }).sort({ receivedAt: 1 }).lean(),
    AgentEvent.find({ deviceId: device._id, at: { $gte: from } }).sort({ at: -1 }).limit(400).lean(),
    loadNetworkState([device.networkId], config, now),
  ]);

  // ── series ───────────────────────────────────────────────────────────
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({ t: new Date(from.getTime() + i * bucketMs), rtt: [], loss: [], jitter: [], tput: [] }));
  for (const m of ms) {
    if (!m.valid || m.value == null || m.target?.kind !== 'peer') continue;
    const b = buckets[Math.min(BUCKETS - 1, Math.floor((new Date(m.measuredAt) - from) / bucketMs))];
    ({ rtt: b.rtt, packet_loss: b.loss, jitter: b.jitter, throughput: b.tput })[m.type]?.push(m.value);
  }
  const series = buckets.map((b) => ({
    t: b.t,
    rttAvg: round(avg(b.rtt)),
    rttP95: round(pct(b.rtt, 95)),
    lossAvg: round(avg(b.loss)),
    jitterAvg: round(avg(b.jitter)),
    throughputAvg: round(avg(b.tput), 0),
    samples: b.rtt.length,
  }));

  // ── events on the same time axis ─────────────────────────────────────
  const ev = [];
  for (const i of incidents) {
    if (i.detectedAt >= from) ev.push({ at: i.detectedAt, kind: 'incident', severity: 'bad', label: `${i.source === 'test' ? '[test] ' : ''}incident: ${i.category.replace(/_/g, ' ')}`, ref: String(i._id) });
    if (i.resolution?.verifiedAt && i.resolution.verifiedAt >= from) ev.push({ at: i.resolution.verifiedAt, kind: 'resolved', severity: 'good', label: `resolved: ${i.category.replace(/_/g, ' ')}`, ref: String(i._id) });
  }
  for (const a of actions) {
    ev.push({ at: a.createdAt, kind: 'action', severity: 'info', label: `${a.actionType.replace(/_/g, ' ')} · ${a.status.replace(/_/g, ' ')}`, ref: String(a._id), incidentId: a.incidentId ? String(a.incidentId) : null });
    if (a.verification?.checkedAt) ev.push({ at: a.verification.checkedAt, kind: 'verified', severity: a.verification.outcome === 'successful' ? 'good' : 'warn', label: `verified ${a.verification.outcome.replace(/_/g, ' ')}: ${a.actionType.replace(/_/g, ' ')}`, ref: String(a._id) });
  }
  // Heartbeat silences longer than 3 intervals: the agent was unreachable.
  const gapMs = config.HEARTBEAT_INTERVAL_SECONDS * 3000;
  for (let k = 1; k < heartbeats.length; k++) {
    const gap = heartbeats[k].receivedAt - heartbeats[k - 1].receivedAt;
    if (gap > gapMs) ev.push({ at: heartbeats[k - 1].receivedAt, until: heartbeats[k].receivedAt, kind: 'silence', severity: 'warn', label: `agent silent for ${Math.round(gap / 60_000)} min` });
  }
  for (const e of events) {
    if (e.level === 'warn' || e.level === 'error' || NOTABLE.test(e.message)) {
      ev.push({ at: e.at, kind: 'agent', severity: e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : 'info', label: e.message });
    }
  }
  ev.sort((a, b) => new Date(b.at) - new Date(a.at));

  // ── per-peer connection inspector ────────────────────────────────────
  const id = String(device._id);
  const names = new Map(state.devices.map((d) => [String(d._id), d.name]));
  const obs = await PeerObservation.find({ $or: [{ deviceId: device._id }, { peerDeviceId: device._id }] }).lean();
  const peers = state.links
    .filter((l) => l.source === id || l.target === id)
    .map((l) => {
      const peerId = l.source === id ? l.target : l.source;
      const mine = ms.filter((m) => m.target?.kind === 'peer' && String(m.target.peerDeviceId) === peerId);
      const rtt = mine.filter((m) => m.type === 'rtt' && m.valid && m.value != null).map((m) => m.value);
      const loss = mine.filter((m) => m.type === 'packet_loss' && m.valid && m.value != null).map((m) => m.value);
      // A connectivity failure: a probe that got no answer, or every packet lost.
      // (An invalid jitter value only means too few samples, not a failure.)
      const lastFailure = [...mine].reverse().find((m) => (m.type === 'rtt' && !m.valid) || (m.type === 'packet_loss' && m.value === 100));
      const pairObs = obs.filter((o) => [String(o.deviceId), String(o.peerDeviceId)].includes(peerId));
      return {
        peerDeviceId: peerId,
        peerName: names.get(peerId) || null,
        configured: true,
        state: l.state,
        path: l.path,
        reason: l.reason || null,
        lastHandshakeAt: l.lastHandshakeAt || null,
        observedBy: pairObs.map((o) => ({
          deviceId: String(o.deviceId),
          deviceName: names.get(String(o.deviceId)) || null,
          observedAt: o.observedAt,
          lastHandshakeAt: o.lastHandshakeAt,
          path: o.path,
          // Endpoints are shown only as path kind; the raw ip:port stays on the device page.
          rxBytes: o.rxBytes,
          txBytes: o.txBytes,
        })),
        rtt: { samples: rtt.length, avg: round(avg(rtt)), p95: round(pct(rtt, 95)), last: rtt.length ? rtt[rtt.length - 1] : null },
        lossAvg: round(avg(loss)),
        lastFailure: lastFailure ? { at: lastFailure.measuredAt, type: lastFailure.type, error: lastFailure.error || (lastFailure.value === 100 ? 'all probes lost' : 'measurement failed') } : null,
        incidents: incidents
          .filter((i) => String(i.peerDeviceId || '') === peerId || (String(i.deviceId) === peerId && String(i.peerDeviceId || '') === id))
          .slice(0, 10)
          .map((i) => ({ id: String(i._id), category: i.category, state: i.state, detectedAt: i.detectedAt, isTest: i.source === 'test' })),
      };
    });

  const allRtt = ms.filter((m) => m.type === 'rtt' && m.valid && m.value != null && m.target?.kind === 'peer').map((m) => m.value);
  const tput = ms.filter((m) => m.type === 'throughput' && m.valid && m.value != null).map((m) => m.value);
  return {
    window: windowKey,
    from,
    to: new Date(now),
    bucketMinutes: Math.round(bucketMs / 60_000),
    summary: {
      samples: allRtt.length,
      rttAvg: round(avg(allRtt)),
      rttP95: round(pct(allRtt, 95)),
      lossAvg: round(avg(series.filter((s) => s.lossAvg != null).map((s) => s.lossAvg))),
      throughputAvg: tput.length ? round(avg(tput), 0) : null,
    },
    series,
    events: ev.slice(0, 200),
    peers,
  };
}

module.exports = { deviceMetrics, WINDOWS };
