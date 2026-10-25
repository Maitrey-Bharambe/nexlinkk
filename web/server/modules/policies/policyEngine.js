'use strict';

const { Device, AgentCommand } = require('../../database/models/device');
const { Membership, Network } = require('../../database/models/network');
const { ACTIONS, approverPermission } = require('./actionRegistry');
const { hasPermission } = require('./permissions');
const { roleOnNetwork } = require('../networks/scope');
const { agentStatus, thresholds } = require('../telemetry/health');

/**
 * Deterministic policy engine. It does not read prompts, model output text or
 * "confidence" — only the action type, parameters and current system state.
 *
 * phase = 'propose' : may this action be put in front of a human?
 * phase = 'approve' : may this user approve it, and may it run right now?
 */
async function evaluateAction({ actionType, params, deviceId, incident, user, phase, config, now = Date.now() }) {
  const reasons = [];
  const deny = (r) => reasons.push(r);

  const def = Object.prototype.hasOwnProperty.call(ACTIONS, actionType) ? ACTIONS[actionType] : null;
  if (!def) return { valid: false, reasons: [`UNKNOWN_ACTION: "${String(actionType).slice(0, 64)}" is not in the action registry`] };
  if (!def.available) return { valid: false, risk: def.risk, reasons: [`ACTION_UNAVAILABLE: ${def.unavailableReason}`] };

  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) {
    return {
      valid: false,
      risk: def.risk,
      reasons: parsed.error.issues.map((i) => `INVALID_PARAMS: ${i.path.join('.') || '(root)'} ${i.message}`),
    };
  }
  const p = parsed.data;

  const device = await Device.findById(deviceId).lean();
  if (!device) return { valid: false, risk: def.risk, reasons: ['DEVICE_NOT_FOUND'] };
  if (device.enrollmentState !== 'enrolled') deny(`DEVICE_STATE: device is ${device.enrollmentState}`);

  if (incident) {
    if (String(incident.deviceId) !== String(device._id)) deny('INCIDENT_DEVICE_MISMATCH: action targets a device outside the incident');
    if (!incident.active) deny(`INCIDENT_CLOSED: incident is ${incident.state}`);
  }

  const membership = await Membership.findOne({ deviceId: device._id, status: 'active' }).lean();
  if (!membership) deny('NO_ACTIVE_MEMBERSHIP: device is not an active network member');
  const network = membership ? await Network.findById(membership.networkId).lean() : null;

  if (p.peerDeviceId) {
    if (String(p.peerDeviceId) === String(device._id)) deny('INVALID_PEER: peer cannot be the device itself');
    else if (membership) {
      const peer = await Membership.findOne({ deviceId: p.peerDeviceId, networkId: membership.networkId, status: 'active' }).lean();
      if (!peer) deny('INVALID_PEER: peer is not an active member of the same network');
    }
  }

  const agent = agentStatus(device, now, thresholds(config));
  if (agent.status !== 'online') deny(`PRECONDITION_AGENT_OFFLINE: agent is ${agent.status}; command could not be delivered`);
  if (def.requiredCapability && !(device.capabilities || []).includes(def.requiredCapability)) {
    deny(`PRECONDITION_CAPABILITY: agent does not advertise "${def.requiredCapability}"${def.requiredCapability === 'wireguard_apply' ? ' (privileged mode disabled)' : ''}`);
  }

  if (def.peerCapability && p.peerDeviceId) {
    const peerDevice = await Device.findById(p.peerDeviceId).lean();
    if (!peerDevice) deny('INVALID_PEER: peer device not found');
    else {
      const peerAgent = agentStatus(peerDevice, now, thresholds(config));
      if (peerAgent.status !== 'online') deny(`PRECONDITION_PEER_OFFLINE: ${peerDevice.name} agent is ${peerAgent.status}`);
      if (!(peerDevice.capabilities || []).includes(def.peerCapability)) {
        deny(`PRECONDITION_PEER_CAPABILITY: ${peerDevice.name} does not advertise "${def.peerCapability}" (agent ${peerDevice.agentVersion || 'unknown'}; needs 0.3.0+ in userspace mode)`);
      }
    }
  }

  const recent = await AgentCommand.countDocuments({
    deviceId: device._id,
    type: def.agentCommand,
    createdAt: { $gte: new Date(now - 3600_000) },
  });
  if (recent >= def.perHourLimit) deny(`RATE_LIMITED: ${recent}/${def.perHourLimit} ${actionType} executions in the last hour`);

  const needed = approverPermission(def.risk);
  if (phase === 'approve') {
    if (!user || !hasPermission(user, needed)) deny(`PERMISSION_DENIED: approving a ${def.risk}-risk action requires ${needed}`);
    else if (network) {
      const role = roleOnNetwork(user, network);
      if (!role || role === 'viewer') deny('SCOPE_DENIED: user has no write scope on this network');
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    params: p,
    risk: def.risk,
    requiresApproval: true,
    approverPermission: needed,
    timeoutMs: def.timeoutMs,
    agentCommand: def.agentCommand,
    networkId: network?._id || null,
  };
}

module.exports = { evaluateAction };
