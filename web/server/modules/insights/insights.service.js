'use strict';

const crypto = require('node:crypto');
const { Network } = require('../../database/models/network');
const { Measurement } = require('../../database/models/telemetry');
const { Incident } = require('../../database/models/incidents');
const { AiBriefing } = require('../../database/models/insights');
const { loadNetworkState } = require('../telemetry/state.service');
const { callDiagnosticService } = require('../diagnostics/diagnostics.service');
const { validateDiagnosticResult } = require('../diagnostics/diagnostic.schema');
const audit = require('../audit/audit.service');

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/**
 * Network analytics computed from stored observations only. Every number is
 * derived from records; anything not measured is null, never 0.
 */
async function computeAnalytics(networkIds, config, now = Date.now()) {
  const state = await loadNetworkState(networkIds, config, now);
  const devices = state.devices;
  const names = new Map(devices.map((d) => [String(d._id), d.name]));
  const enrolled = devices.filter((d) => d.enrollmentState === 'enrolled');

  const byStatus = {};
  for (const d of enrolled) {
    const s = state.health.get(String(d._id))?.status || 'unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const links = state.links;
  const tunnels = {
    total: links.length,
    connected: links.filter((l) => l.state === 'connected').length,
    degraded: links.filter((l) => l.state === 'degraded').length,
    unreachable: links.filter((l) => l.state === 'unreachable').length,
    direct: links.filter((l) => ['connected', 'degraded'].includes(l.state) && l.path === 'direct').length,
    relay: links.filter((l) => ['connected', 'degraded'].includes(l.state) && l.path === 'relay').length,
  };

  // 24 h of tunnel measurements (valid peer probes), bucketed per hour.
  const since = new Date(now - DAY);
  const ms = await Measurement.find(
    { deviceId: { $in: devices.map((d) => d._id) }, measuredAt: { $gte: since }, valid: true, type: { $in: ['rtt', 'packet_loss', 'jitter'] } },
    { deviceId: 1, type: 1, value: 1, measuredAt: 1, 'target.kind': 1 },
  )
    .limit(50_000)
    .lean();
  const start = Math.floor((now - DAY) / HOUR) * HOUR;
  const buckets = Array.from({ length: 25 }, (_, i) => ({ t: new Date(start + i * HOUR), rtt: [], loss: [] }));
  const perDevice = new Map();
  for (const m of ms) {
    if (m.value == null) continue;
    const i = Math.floor((new Date(m.measuredAt).getTime() - start) / HOUR);
    const b = buckets[i];
    const id = String(m.deviceId);
    if (!perDevice.has(id)) perDevice.set(id, { rtt: [], loss: [], jitter: [], last: null });
    const pd = perDevice.get(id);
    pd.last = !pd.last || m.measuredAt > pd.last ? m.measuredAt : pd.last;
    if (m.type === 'rtt' && m.target?.kind === 'peer') {
      b?.rtt.push(m.value);
      pd.rtt.push(m.value);
    } else if (m.type === 'packet_loss' && m.target?.kind === 'peer') {
      b?.loss.push(m.value);
      pd.loss.push(m.value);
    } else if (m.type === 'jitter' && m.target?.kind === 'peer') {
      pd.jitter.push(m.value);
    }
  }
  const series = buckets.map((b) => ({ t: b.t, rttAvg: round(avg(b.rtt)), rttP95: round(pct(b.rtt, 95)), lossAvg: round(avg(b.loss)), samples: b.rtt.length }));
  const allRtt = ms.filter((m) => m.type === 'rtt' && m.target?.kind === 'peer' && m.value != null).map((m) => m.value);
  const allLoss = ms.filter((m) => m.type === 'packet_loss' && m.target?.kind === 'peer' && m.value != null).map((m) => m.value);

  const deviceRows = enrolled.map((d) => {
    const id = String(d._id);
    const h = state.health.get(id);
    const pd = perDevice.get(id);
    return {
      id,
      name: d.name,
      networkId: String(d.networkId),
      status: h?.status || 'unknown',
      agent: h?.agent?.status || 'unknown',
      vpn: h?.vpn?.state || 'unknown',
      reasons: h?.reasons || [],
      rttAvg: pd ? round(avg(pd.rtt)) : null,
      rttP95: pd ? round(pct(pd.rtt, 95)) : null,
      lossAvg: pd ? round(avg(pd.loss)) : null,
      jitterAvg: pd ? round(avg(pd.jitter)) : null,
      samples: pd ? pd.rtt.length : 0,
      lastMeasuredAt: pd?.last || null,
    };
  });

  // Incidents over 7 days.
  const incidents = await Incident.find({ networkId: { $in: networkIds }, detectedAt: { $gte: new Date(now - 7 * DAY) } }).lean();
  const dayStart = Math.floor((now - 6 * DAY) / DAY) * DAY;
  const perDay = Array.from({ length: 7 }, (_, i) => ({ day: new Date(dayStart + i * DAY), opened: 0, resolved: 0 }));
  const byCategory = {};
  const repairMin = [];
  for (const i of incidents) {
    if (i.source === 'test') continue;
    const k = Math.floor((new Date(i.detectedAt).getTime() - dayStart) / DAY);
    if (perDay[k]) perDay[k].opened++;
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    const doneAt = i.resolution?.verifiedAt;
    if (doneAt) {
      const r = Math.floor((new Date(doneAt).getTime() - dayStart) / DAY);
      if (perDay[r]) perDay[r].resolved++;
      repairMin.push((new Date(doneAt) - new Date(i.detectedAt)) / 60_000);
    }
  }
  const active = await Incident.find({ networkId: { $in: networkIds }, active: true }).sort({ detectedAt: -1 }).limit(20).lean();

  return {
    evaluatedAt: new Date(now),
    devices: {
      enrolled: enrolled.length,
      byStatus,
      healthScore: enrolled.length ? round((100 * (byStatus.healthy || 0)) / enrolled.length, 0) : null,
    },
    tunnels,
    latency: {
      window: '24h',
      samples: allRtt.length,
      rttAvg: round(avg(allRtt)),
      rttP50: round(pct(allRtt, 50)),
      rttP95: round(pct(allRtt, 95)),
      lossAvg: round(avg(allLoss)),
      series,
    },
    incidents: {
      window: '7d',
      total: incidents.filter((i) => i.source !== 'test').length,
      active: active.length,
      byCategory,
      perDay,
      mttrMinutes: round(avg(repairMin), 0),
      activeList: active.map((i) => ({ id: String(i._id), title: i.title, category: i.category, state: i.state, detectedAt: i.detectedAt, isTest: i.source === 'test' })),
    },
    deviceRows,
    links: links.map((l) => ({ ...l, sourceName: names.get(l.source) || l.source, targetName: names.get(l.target) || l.target })),
    _state: state,
  };
}

/**
 * Evidence for one network's briefing, built from the analytics. Refs are
 * stable so the AI can cite them and the validator can check every citation.
 * The hash covers the state only (no clock-relative text), so an unchanged
 * network is not re-sent to the model.
 */
function briefingEvidence(network, a) {
  const id = String(network._id);
  const ev = [];
  const push = (ref, kind, summary, observedAt) => ev.push({ ref, kind, summary, observedAt: observedAt || null, data: null });

  const s = a.devices.byStatus;
  push(
    `network:${id}:summary`,
    'network_summary',
    `Network ${network.name} (${network.cidr}): ${a.devices.enrolled} enrolled devices; healthy ${s.healthy || 0}, degraded ${s.degraded || 0}, unreachable ${s.unreachable || 0}, unknown ${s.unknown || 0}. Tunnels: ${a.tunnels.connected}/${a.tunnels.total} with a fresh handshake (${a.tunnels.direct} direct, ${a.tunnels.relay} via relay), ${a.tunnels.unreachable} unreachable.`,
    a.evaluatedAt,
  );
  for (const d of a.deviceRows) {
    push(
      `device:${d.id}:health`,
      'device_health',
      `${d.name}: overall ${d.status}; agent ${d.agent}; VPN ${d.vpn}${d.reasons.length ? `; reasons: ${d.reasons.slice(0, 3).join('; ')}` : ''}`,
      a.evaluatedAt,
    );
    if (d.samples) {
      push(
        `metrics:${d.id}:24h`,
        'tunnel_metrics',
        `${d.name}: ${d.samples} tunnel RTT samples in 24h, average ${d.rttAvg} ms, p95 ${d.rttP95} ms${d.lossAvg != null ? `, packet loss average ${d.lossAvg}%` : ''}${d.jitterAvg != null ? `, jitter ${d.jitterAvg} ms` : ''}`,
        d.lastMeasuredAt,
      );
    } else {
      push(`metrics:${d.id}:24h`, 'tunnel_metrics', `${d.name}: no tunnel measurements in the last 24h`, null);
    }
  }
  for (const l of a.links) {
    push(
      `link:${l.source}:${l.target}`,
      'peer_link',
      `Tunnel ${l.sourceName} <-> ${l.targetName}: ${l.state}${l.path && l.path !== 'unknown' ? ` via ${l.path}` : ''}${l.lastHandshakeAt ? `; last handshake ${new Date(l.lastHandshakeAt).toISOString()}` : '; no handshake observed'}${l.reason ? `; ${l.reason}` : ''}`,
      l.lastHandshakeAt,
    );
  }
  const cats = Object.entries(a.incidents.byCategory).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  push(
    `incidents:${id}:7d`,
    'incident_stats',
    `Incidents in the last 7 days (excluding test events): ${a.incidents.total} (${cats}); ${a.incidents.active} active now; mean time to verified resolution ${a.incidents.mttrMinutes != null ? `${a.incidents.mttrMinutes} min` : 'not measurable (none resolved)'}.`,
    a.evaluatedAt,
  );
  for (const i of a.incidents.activeList.slice(0, 10)) {
    push(`incident:${i.id}`, 'incident', `${i.isTest ? '[TEST] ' : ''}${i.title} — ${i.state}, detected ${new Date(i.detectedAt).toISOString()}`, i.detectedAt);
  }
  const evidence = ev.slice(0, 80);

  const fingerprint = {
    devices: a.deviceRows.map((d) => [d.id, d.status, d.agent, d.vpn, d.rttAvg == null ? null : Math.round(d.rttAvg / 10), d.lossAvg == null ? null : Math.round(d.lossAvg)]),
    links: a.links.map((l) => [l.id, l.state, l.path]),
    incidents: a.incidents.activeList.map((i) => [i.id, i.state]),
  };
  const inputHash = crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 32);
  return { evidence, inputHash };
}

/** Generates and stores one network's AI briefing. Never throws for AI failures. */
async function generateBriefing({ network, config, trigger, user = null, req = null, analytics }) {
  const now = new Date();
  const a = analytics || (await computeAnalytics([network._id], config, now.getTime()));
  const { evidence, inputHash } = briefingEvidence(network, a);
  const briefingId = `briefing-${network._id}-${now.getTime()}`;
  const base = {
    networkId: network._id,
    generatedAt: now,
    trigger,
    requestedBy: user?._id || null,
    inputHash,
    evidence: evidence.map(({ ref, kind, summary, observedAt }) => ({ ref, kind, summary, observedAt })),
    expiresAt: new Date(now.getTime() + 7 * DAY),
  };

  let doc;
  try {
    const out = await callDiagnosticService({
      config,
      incident: {
        _id: briefingId,
        category: 'network_review',
        severity: 'low',
        title: `Network-wide review of ${network.name}: summarise current health, tunnel quality, latency and incident trends, and name the main risks. Analysis only, no actions.`,
        detectedAt: now,
      },
      device: { _id: network._id, name: `network ${network.name}` },
      evidence,
      allowedActions: [],
    });
    const v = validateDiagnosticResult(out.result, { incidentId: briefingId, evidenceRefs: evidence.map((x) => x.ref) });
    if (!v.ok) doc = { ...base, status: 'rejected', provider: out.provider, error: v.errors.slice(0, 5).join('; ') };
    else if (v.value.proposed_actions.length) doc = { ...base, status: 'rejected', provider: out.provider, error: 'briefing proposed actions although none are allowed' };
    else doc = { ...base, status: 'completed', provider: out.provider, result: v.value };
  } catch (err) {
    doc = { ...base, status: 'failed', error: err.name === 'AbortError' ? 'diagnostic service timed out' : err.message.slice(0, 300) };
  }
  const saved = await AiBriefing.create(doc);
  await audit.record(
    {
      actor: user ? undefined : audit.SYSTEM_ACTOR,
      operation: 'insights.briefing',
      target: { type: 'network', id: String(network._id), label: network.name },
      networkId: network._id,
      outcome: doc.status === 'completed' ? 'success' : 'failure',
      reason: doc.error || null,
      metadata: { trigger, provider: doc.provider || null, evidence: evidence.length },
    },
    req,
  );
  return saved;
}

function serializeBriefing(b, network) {
  if (!b) return null;
  return {
    id: String(b._id),
    networkId: String(b.networkId),
    networkName: network?.name || null,
    generatedAt: b.generatedAt,
    trigger: b.trigger,
    status: b.status,
    provider: b.provider,
    result: b.result,
    evidence: b.evidence,
    error: b.error,
  };
}

async function latestBriefings(networkIds) {
  const out = [];
  for (const id of networkIds) {
    const [ok, last] = await Promise.all([
      AiBriefing.findOne({ networkId: id, status: 'completed' }).sort({ generatedAt: -1 }).lean(),
      AiBriefing.findOne({ networkId: id }).sort({ generatedAt: -1 }).lean(),
    ]);
    out.push({ networkId: String(id), latest: ok, lastAttempt: last });
  }
  return out;
}

/**
 * Scheduler: for each active network with enrolled devices, regenerate the
 * briefing when its state fingerprint changed (or the last one is > 6 h old).
 */
function startBriefings({ config, logger, realtime }) {
  if (!config.BRIEFING_INTERVAL_MINUTES || !config.DIAGNOSTIC_SERVICE_URL) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const networks = await Network.find({ status: 'active' }).lean();
      for (const n of networks) {
        const a = await computeAnalytics([n._id], config);
        if (!a.devices.enrolled) continue;
        const { inputHash } = briefingEvidence(n, a);
        const last = await AiBriefing.findOne({ networkId: n._id }).sort({ generatedAt: -1 }).lean();
        const fresh = last && Date.now() - new Date(last.generatedAt).getTime() < 6 * HOUR;
        if (last && last.inputHash === inputHash && fresh) continue;
        // After a failure, wait a full interval before retrying the same input.
        if (last && last.status !== 'completed' && last.inputHash === inputHash && Date.now() - new Date(last.generatedAt).getTime() < config.BRIEFING_INTERVAL_MINUTES * 60_000) continue;
        const b = await generateBriefing({ network: n, config, trigger: 'schedule', analytics: a });
        logger.info({ network: n.name, status: b.status, provider: b.provider }, 'ai briefing generated');
        realtime?.emitNetwork(n._id, 'insight:update', { networkId: String(n._id) });
      }
    } catch (err) {
      logger.warn({ err }, 'ai briefing schedule failed');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 20_000);
  const timer = setInterval(tick, config.BRIEFING_INTERVAL_MINUTES * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { computeAnalytics, briefingEvidence, generateBriefing, serializeBriefing, latestBriefings, startBriefings };
