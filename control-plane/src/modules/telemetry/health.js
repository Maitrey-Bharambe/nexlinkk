'use strict';

/**
 * Pure functions that turn stored observations into health states.
 *
 * Three independent signals are kept apart on purpose:
 *   1. agent      — is the agent process talking to the control plane? (heartbeats)
 *   2. vpn        — does the agent report the WireGuard interface as up? (telemetry)
 *   3. peer paths — has WireGuard completed a handshake with a peer recently? (telemetry)
 *
 * A fresh heartbeat proves (1) only. It says nothing about (2) or (3).
 */

const ageSec = (date, now) => (date ? Math.max(0, (now - new Date(date).getTime()) / 1000) : null);

function thresholds(config) {
  const hb = config.HEARTBEAT_INTERVAL_SECONDS;
  return {
    agentOnlineSec: hb * 3, // tolerate two missed heartbeats
    agentStaleSec: hb * 10,
    telemetryFreshSec: hb * 10,
    handshakeFreshSec: config.HANDSHAKE_FRESH_SECONDS, // WireGuard REJECT_AFTER_TIME = 180s
    lossDegradedPct: 5,
    rttDegradedMs: 250,
  };
}

function agentStatus(device, now, t) {
  if (!device.lastHeartbeatAt) return { status: 'never_seen', lastHeartbeatAt: null, ageSec: null };
  const age = ageSec(device.lastHeartbeatAt, now);
  const status = age <= t.agentOnlineSec ? 'online' : age <= t.agentStaleSec ? 'stale' : 'offline';
  return { status, lastHeartbeatAt: device.lastHeartbeatAt, ageSec: Math.round(age) };
}

function vpnStatus(device, now, t) {
  const v = device.vpn || {};
  if (!v.observedAt) return { state: 'unknown', observedAt: null, stale: false, interfaceName: v.interfaceName || null };
  const stale = ageSec(v.observedAt, now) > t.telemetryFreshSec;
  return {
    state: stale ? 'unknown' : v.state || 'unknown',
    reportedState: v.state,
    observedAt: v.observedAt,
    stale,
    interfaceName: v.interfaceName,
    listenPort: v.listenPort,
    source: v.source,
  };
}

/**
 * State of the tunnel between two peers, combining both sides' observations.
 * Configured != connected: with no observation we say "configured".
 */
function peerLinkState({ observations, peerMeasurements = [], now, t }) {
  const fresh = observations.filter((o) => o && ageSec(o.observedAt, now) <= t.telemetryFreshSec);
  if (observations.filter(Boolean).length === 0) return { state: 'configured', lastHandshakeAt: null, path: 'unknown' };
  if (fresh.length === 0) return { state: 'unknown', lastHandshakeAt: latestHandshake(observations), path: 'unknown', reason: 'observations stale' };

  const hs = latestHandshake(fresh);
  const path = fresh.find((o) => o.path && o.path !== 'unknown')?.path || 'unknown';
  if (!hs) {
    // Peer configured on the interface but WireGuard has never completed a handshake.
    return { state: 'connecting', lastHandshakeAt: null, path, reason: 'no handshake observed yet' };
  }
  // Handshake age is judged relative to when it was observed, not to "now",
  // so a slightly old report does not look like a dead tunnel.
  const freshestObs = fresh.reduce((a, b) => (new Date(a.observedAt) > new Date(b.observedAt) ? a : b));
  const hsAge = (new Date(freshestObs.observedAt) - new Date(hs)) / 1000;
  if (hsAge > t.handshakeFreshSec) {
    return { state: 'unreachable', lastHandshakeAt: hs, path, reason: `last handshake ${Math.round(hsAge)}s before report` };
  }
  const loss = latestValid(peerMeasurements, 'packet_loss');
  const rtt = latestValid(peerMeasurements, 'rtt');
  if ((loss && loss.value > t.lossDegradedPct) || (rtt && rtt.value > t.rttDegradedMs)) {
    return { state: 'degraded', lastHandshakeAt: hs, path, reason: 'handshake fresh but loss/latency above threshold' };
  }
  return { state: 'connected', lastHandshakeAt: hs, path };
}

function latestHandshake(observations) {
  const times = observations.filter((o) => o?.lastHandshakeAt).map((o) => new Date(o.lastHandshakeAt).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

function latestValid(measurements, type) {
  return (
    measurements
      .filter((m) => m.type === type && m.valid && m.value !== null)
      .sort((a, b) => new Date(b.measuredAt) - new Date(a.measuredAt))[0] || null
  );
}

/**
 * Overall device connectivity:
 *   healthy | degraded | unreachable | unknown | pending_enrollment | revoked
 */
function computeDeviceHealth(device, { now = Date.now(), config, peerLinks = [], measurements = [], expectedPeers = 0 }) {
  const t = thresholds(config);
  const agent = agentStatus(device, now, t);
  const vpn = vpnStatus(device, now, t);
  const latestRtt = latestValid(measurements, 'rtt');
  const reasons = [];
  let status;

  if (device.enrollmentState === 'revoked') status = 'revoked';
  else if (device.enrollmentState !== 'enrolled') status = 'pending_enrollment';
  else if (agent.status === 'never_seen') {
    status = 'unknown';
    reasons.push('No heartbeat has been received from this agent');
  } else if (agent.status === 'offline') {
    status = 'unreachable';
    reasons.push(`Agent silent for ${agent.ageSec}s (control channel lost; tunnel state unknown)`);
  } else if (agent.status === 'stale') {
    status = 'degraded';
    reasons.push(`Heartbeats late (${agent.ageSec}s since last)`);
  } else if (vpn.source === 'simulated') {
    status = 'unknown';
    reasons.push('Agent is reporting simulated interface data (test mode); tunnel state not observed');
  } else if (vpn.state === 'unknown') {
    status = 'unknown';
    reasons.push(
      vpn.stale
        ? 'VPN interface report is stale'
        : vpn.source === 'unavailable'
          ? 'Agent cannot read WireGuard state (needs root/Administrator, or WireGuard is not installed)'
          : 'Agent has not reported VPN interface state',
    );
  } else if (vpn.state === 'up' && device.vpn?.keyMatches === false) {
    status = 'degraded';
    reasons.push('Interface public key does not match the enrolled WireGuard key');
  } else if (vpn.state !== 'up') {
    status = 'degraded';
    reasons.push(`Agent online but VPN interface is ${vpn.state}`);
  } else if (expectedPeers === 0) {
    status = 'healthy';
    reasons.push('Agent online and interface up; no peers to verify yet');
  } else {
    const connected = peerLinks.filter((l) => l.state === 'connected').length;
    // Anything short of every peer verified by a fresh handshake is "degraded".
    status = connected === expectedPeers ? 'healthy' : 'degraded';
    reasons.push(`${connected}/${expectedPeers} peer tunnels verified by fresh handshake`);
  }

  const handshakes = peerLinks.map((l) => l.lastHandshakeAt).filter(Boolean);
  return {
    status,
    reasons,
    agent,
    vpn,
    lastHandshakeAt: handshakes.length ? new Date(Math.max(...handshakes.map((d) => new Date(d).getTime()))) : null,
    latestRtt: latestRtt
      ? { value: latestRtt.value, unit: latestRtt.unit, measuredAt: latestRtt.measuredAt, source: latestRtt.source, target: latestRtt.target }
      : null,
    evaluatedAt: new Date(now),
  };
}

module.exports = { computeDeviceHealth, peerLinkState, agentStatus, vpnStatus, thresholds, latestValid, ageSec };
