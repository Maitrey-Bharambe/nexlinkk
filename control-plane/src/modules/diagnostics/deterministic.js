'use strict';

/**
 * Rule-based diagnostic planner (method "deterministic_rules_v1"). It emits the
 * same structured result an LLM provider must emit, citing only collected
 * evidence refs. It never claims a root cause it did not measure: hypotheses
 * stay "untested" unless evidence directly supports or rules them out.
 */

function refsOf(evidence, pred) {
  return evidence.filter(pred).map((x) => x.ref);
}

function planDeterministic({ incident, device, evidence, state }) {
  const id = String(device._id);
  const health = state.health.get(id);
  const healthRef = `device:${id}:health`;
  const hbRefs = refsOf(evidence, (x) => x.kind === 'heartbeat' || x.kind === 'heartbeat_history').slice(0, 3);
  const hsRefs = refsOf(evidence, (x) => x.kind === 'handshake');
  const measRefs = refsOf(evidence, (x) => ['rtt', 'packet_loss', 'jitter', 'measurement'].includes(x.kind));
  const detectionRefs = (incident.evidence || []).map((x) => x.ref);

  const observations = [
    { statement: `Device health evaluates to "${health.status}": ${health.reasons.join('; ') || 'no reasons recorded'}`, evidence_refs: [healthRef] },
  ];
  if (detectionRefs.length) {
    observations.push({ statement: `Detector evidence: ${incident.evidence.map((x) => x.summary).join('; ')}`, evidence_refs: detectionRefs });
  }
  const hypotheses = [];
  const uncertainties = [];
  const proposed = [];

  switch (incident.category) {
    case 'agent_offline': {
      if (hbRefs.length) observations.push({ statement: 'Most recent heartbeats are listed in heartbeat history', evidence_refs: hbRefs });
      // A peer reporting a fresh handshake *with this device* is independent evidence the host is up.
      const peerSees = evidence.filter(
        (x) => x.kind === 'handshake' && x.data?.peer === id && x.data?.lastHandshakeAt && Date.now() - new Date(x.data.lastHandshakeAt) < 300_000,
      );
      if (peerSees.length) {
        observations.push({ statement: 'A peer reports a WireGuard handshake with this device within the last 5 minutes', evidence_refs: peerSees.map((x) => x.ref) });
        hypotheses.push({
          statement: 'Host is running and the tunnel is up, but the agent-to-control-plane channel is broken (agent stopped, proxy/firewall, DNS)',
          status: 'plausible',
          supporting_refs: peerSees.map((x) => x.ref),
        });
      } else {
        hypotheses.push({ statement: 'Agent process stopped or host powered off', status: 'untested', supporting_refs: [healthRef] });
        hypotheses.push({ statement: 'Outbound HTTPS from the device to the control plane is blocked', status: 'untested', supporting_refs: [healthRef] });
      }
      uncertainties.push('The control plane cannot distinguish a powered-off host from a blocked control channel without a second vantage point.');
      uncertainties.push('No remote action can be delivered while the agent is offline; recovery requires local access to the device.');
      break;
    }
    case 'vpn_interface_down': {
      hypotheses.push({ statement: 'WireGuard interface/tunnel service is not running on the host', status: 'plausible', supporting_refs: [healthRef, ...detectionRefs] });
      hypotheses.push({ statement: 'Last configuration apply failed and left the interface down', status: 'untested', supporting_refs: [] });
      if (device.vpn?.source === 'unavailable') uncertainties.push('Agent could not read WireGuard state (insufficient privilege or driver missing).');
      proposed.push({ action_type: 'request_peer_status_report', params: {}, rationale: 'Confirm current interface state with a fresh read before changing anything' });
      proposed.push({ action_type: 'request_vpn_config_refresh', params: {}, rationale: 'Re-apply the desired peer configuration if the interface exists but has drifted' });
      break;
    }
    case 'peer_handshake_stale': {
      const peerId = incident.peerDeviceId ? String(incident.peerDeviceId) : null;
      if (hsRefs.length) observations.push({ statement: 'WireGuard handshake observations for this device and its peers', evidence_refs: hsRefs });
      const peerHealth = peerId ? state.health.get(peerId) : null;
      if (peerHealth && peerHealth.agent.status !== 'online') {
        hypotheses.push({ statement: `Peer agent is ${peerHealth.agent.status}; peer host may be down`, status: 'plausible', supporting_refs: [healthRef] });
      } else {
        hypotheses.push({ statement: 'UDP between the peers is blocked or NAT mapping expired (both agents are reporting)', status: 'untested', supporting_refs: hsRefs });
      }
      hypotheses.push({ statement: 'Peer endpoint changed (roaming / new public IP) and the stored endpoint is stale', status: 'untested', supporting_refs: [] });
      uncertainties.push('A failed TCP/ICMP probe does not prove the peer is down: filtering can differ from WireGuard UDP.');
      uncertainties.push('Direct connectivity may be impossible between some NAT types; relay fallback is not implemented yet.');
      proposed.push({ action_type: 'request_peer_status_report', params: {}, rationale: 'Get a fresh WireGuard peer read to rule out stale telemetry' });
      if (peerId) {
        proposed.push({ action_type: 'run_connectivity_test', params: { target: 'peer', peerDeviceId: peerId, count: 5 }, rationale: 'Measure reachability to the peer tunnel address' });
      }
      break;
    }
    case 'packet_loss_high':
    case 'latency_high': {
      if (measRefs.length) observations.push({ statement: 'Recent measurements', evidence_refs: measRefs.slice(0, 10) });
      const trigger = (incident.evidence || [])[0]?.data;
      hypotheses.push({ statement: 'Congestion or a lossy access link on the device side', status: 'untested', supporting_refs: measRefs.slice(0, 3) });
      hypotheses.push({ statement: 'Transient spike; a repeat test may not reproduce it', status: 'untested', supporting_refs: [] });
      uncertainties.push(`Single-source measurement${trigger ? ` (${trigger.value}${trigger.unit})` : ''}; a repeat test is needed before acting.`);
      proposed.push({ action_type: 'run_connectivity_test', params: { target: 'control_plane', count: 10 }, rationale: 'Repeat measurement with more samples to confirm' });
      break;
    }
    default:
      uncertainties.push('No deterministic rules exist for this category');
  }

  const cited = new Set([...observations.flatMap((o) => o.evidence_refs), ...hypotheses.flatMap((h) => h.supporting_refs)]);
  return {
    incident_id: String(incident._id),
    summary: `${incident.title}. ${hypotheses.length} hypothesis(es), ${proposed.length} proposed action(s); none executed without approval.`,
    observations,
    hypotheses,
    evidence: [...cited],
    uncertainties,
    proposed_actions: proposed,
    requires_human_approval: true,
  };
}

module.exports = { planDeterministic };
