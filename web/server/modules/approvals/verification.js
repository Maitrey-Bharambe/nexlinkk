'use strict';

const { Device } = require('../../database/models/device');
const { Network } = require('../../database/models/network');
const { Measurement } = require('../../database/models/telemetry');

/**
 * Post-execution verification. The agent saying "done" is not enough: each
 * action type checks fresh observations for the outcome it was meant to cause.
 */
async function verifyAction(action, command) {
  const notes = [];
  const evidence = [];
  const result = (outcome) => ({ outcome, notes, evidence, checkedAt: new Date() });

  if (command.status === 'timed_out') {
    notes.push('Agent did not return a result before the deadline');
    return result('timed_out');
  }
  if (command.status === 'cancelled') {
    notes.push('Command was cancelled before completion');
    return result('failed');
  }
  if (command.status === 'failed') {
    notes.push(`Agent reported failure: ${command.result?.error || 'no error message'}`);
    return result('failed');
  }

  switch (action.actionType) {
    case 'run_connectivity_test': {
      const ms = await Measurement.find({ commandId: command._id }).lean();
      for (const m of ms) {
        evidence.push({
          ref: `measurement:${m._id}`,
          kind: m.type,
          summary: m.valid ? `${m.type}=${m.value}${m.unit}` : `${m.type} unavailable: ${m.error || ''}`,
          observedAt: m.measuredAt,
        });
      }
      const valid = ms.filter((m) => m.valid);
      if (!ms.length) {
        notes.push('No measurements were returned by the test');
        return result('failed');
      }
      notes.push(`${valid.length}/${ms.length} measurements valid`);
      return result(valid.length === ms.length ? 'successful' : valid.length ? 'partially_successful' : 'failed');
    }
    case 'run_transfer_test': {
      const out = command.result?.output || {};
      const ms = await Measurement.find({ commandId: command._id, type: 'throughput' }).lean();
      for (const m of ms) {
        evidence.push({ ref: `measurement:${m._id}`, kind: 'throughput', summary: m.valid ? `throughput=${Math.round(m.value)}bps through the tunnel` : `throughput unavailable: ${m.error || ''}`, observedAt: m.measuredAt });
      }
      const mb = (b) => (typeof b === 'number' ? `${(b / 1048576).toFixed(1)} MB` : '?');
      if (typeof out.bytesSent !== 'number') {
        notes.push('Agent returned no transfer result');
        return result('failed');
      }
      notes.push(`${mb(out.bytesSent)} sent, ${mb(out.bytesConfirmed)} confirmed by the peer in ${((out.durationMs || 0) / 1000).toFixed(2)} s (${Number(out.mbitPerSecond || 0).toFixed(1)} Mbit/s)`);
      if (!out.integrityMatch) {
        notes.push('Peer checksum does not match what was sent — data was lost or altered');
        return result('failed');
      }
      notes.push(`Integrity verified: SHA-256 ${String(out.sha256 || '').slice(0, 12)}… matches on both ends`);
      return result(ms.some((m) => m.valid) ? 'successful' : 'partially_successful');
    }
    case 'request_peer_status_report': {
      const d = await Device.findById(action.deviceId).lean();
      if (d?.lastTelemetryAt && d.lastTelemetryAt > command.createdAt) {
        evidence.push({ ref: `device:${d._id}:vpn`, kind: 'vpn_interface', summary: `Fresh telemetry: interface ${d.vpn?.state}`, observedAt: d.lastTelemetryAt });
        notes.push('Fresh telemetry received after the command was issued');
        return result('successful');
      }
      notes.push('Agent reported success but no newer telemetry has arrived');
      return result('verification_inconclusive');
    }
    case 'request_vpn_config_refresh': {
      const d = await Device.findById(action.deviceId).lean();
      const net = await Network.findById(action.networkId).lean();
      const applied = command.result?.output?.appliedConfigVersion;
      const versionOk = net && applied === net.configVersion;
      const fresh = d?.vpn?.observedAt && d.vpn.observedAt > command.createdAt;
      if (fresh) {
        evidence.push({ ref: `device:${d._id}:vpn`, kind: 'vpn_interface', summary: `Interface ${d.vpn.state} (applied v${d.vpn.appliedConfigVersion})`, observedAt: d.vpn.observedAt });
      }
      if (!versionOk) {
        notes.push(`Agent applied config v${applied ?? '?'} but current is v${net?.configVersion ?? '?'}`);
        return result(fresh && d.vpn.state === 'up' ? 'partially_successful' : 'failed');
      }
      if (!fresh) {
        notes.push('Config applied, but no post-change telemetry to confirm interface state');
        return result('verification_inconclusive');
      }
      notes.push(d.vpn.state === 'up' ? 'Config applied and interface observed up' : `Config applied but interface observed ${d.vpn.state}`);
      return result(d.vpn.state === 'up' ? 'successful' : 'partially_successful');
    }
    default:
      notes.push('No verification procedure for this action type');
      return result('verification_inconclusive');
  }
}

module.exports = { verifyAction };
