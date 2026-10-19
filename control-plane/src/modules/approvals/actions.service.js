'use strict';

const { ProposedAction, Approval, Incident } = require('../../database/models/incidents');
const { AgentCommand, Device } = require('../../database/models/device');
const { Network } = require('../../database/models/network');
const { evaluateAction } = require('../policies/policyEngine');
const { verifyAction } = require('./verification');
const { runDetector } = require('../incidents/detector');
const { roleOnNetwork } = require('../networks/scope');
const { conflict, forbidden, notFound, AppError } = require('../../utils/errors');
const audit = require('../audit/audit.service');

/** Every proposal — from rules or from a model — goes through the policy engine first. */
async function proposeActions({ incident, run, proposals, proposedBy, config, req }) {
  const created = [];
  for (const p of proposals) {
    const verdict = await evaluateAction({
      actionType: p.action_type,
      params: p.params,
      deviceId: incident.deviceId,
      incident,
      phase: 'propose',
      config,
    });
    const action = await ProposedAction.create({
      incidentId: incident._id,
      diagnosticRunId: run?._id || null,
      deviceId: incident.deviceId,
      networkId: incident.networkId,
      actionType: String(p.action_type).slice(0, 64),
      params: verdict.params || {},
      rationale: p.rationale,
      proposedBy,
      risk: verdict.risk || null,
      requiresApproval: true,
      validation: { valid: verdict.valid, reasons: verdict.reasons, checkedAt: new Date() },
      status: verdict.valid ? 'awaiting_approval' : 'rejected_by_policy',
    });
    await audit.record(
      {
        actor: audit.SYSTEM_ACTOR,
        operation: 'action.propose',
        target: { type: 'device', id: String(incident.deviceId) },
        networkId: incident.networkId,
        incidentId: incident._id,
        actionId: action._id,
        decision: verdict.valid ? 'allow' : 'deny',
        outcome: verdict.valid ? 'pending' : 'failure',
        reason: verdict.valid ? null : verdict.reasons.join('; '),
        metadata: { actionType: action.actionType, proposedBy: proposedBy.type },
      },
      req,
    );
    created.push(action);
  }
  if (created.some((a) => a.status === 'awaiting_approval') && incident.active) {
    await Incident.updateOne({ _id: incident._id, active: true }, { state: 'awaiting_approval' });
  }
  return created;
}

/**
 * An operator asks for an action directly from a device page (no incident).
 * Same policy check as AI/rule proposals; it still needs an approval to run.
 */
async function requestDeviceAction({ device, user, actionType, params, config, req }) {
  const verdict = await evaluateAction({ actionType, params, deviceId: device._id, phase: 'propose', config });
  const action = await ProposedAction.create({
    incidentId: null,
    deviceId: device._id,
    networkId: verdict.networkId || device.networkId,
    actionType: String(actionType).slice(0, 64),
    params: verdict.params || params || {},
    rationale: `Requested from the device page by ${user.email}`,
    proposedBy: { type: 'user', ref: String(user._id) },
    risk: verdict.risk || null,
    requiresApproval: true,
    validation: { valid: verdict.valid, reasons: verdict.reasons, checkedAt: new Date() },
    status: verdict.valid ? 'awaiting_approval' : 'rejected_by_policy',
  });
  await audit.record(
    {
      operation: 'action.request',
      target: { type: 'device', id: String(device._id), label: device.name },
      networkId: action.networkId,
      actionId: action._id,
      decision: verdict.valid ? 'allow' : 'deny',
      outcome: verdict.valid ? 'pending' : 'failure',
      reason: verdict.valid ? null : verdict.reasons.join('; '),
      metadata: { actionType: action.actionType, params: action.params },
    },
    req,
  );
  req?.app?.locals?.realtime?.emitNetwork(action.networkId, 'action:update', { actionId: String(action._id) });
  return action;
}

async function loadActionInScope(user, actionId) {
  const action = await ProposedAction.findById(actionId);
  if (!action) throw notFound('Action');
  const network = await Network.findById(action.networkId);
  if (!network || !roleOnNetwork(user, network)) throw notFound('Action');
  return { action, network };
}

async function approveAction({ actionId, user, reason, config, req }) {
  const { action } = await loadActionInScope(user, actionId);
  if (action.status !== 'awaiting_approval') throw conflict('ACTION_NOT_PENDING', `Action is ${action.status}`);
  const incident = action.incidentId ? await Incident.findById(action.incidentId) : null;

  // Re-evaluate at approval time: permissions, device state and rate limits may have changed.
  const verdict = await evaluateAction({
    actionType: action.actionType,
    params: action.params,
    deviceId: action.deviceId,
    incident,
    user,
    phase: 'approve',
    config,
  });
  if (!verdict.valid) {
    await audit.record(
      {
        operation: 'action.approve',
        target: { type: 'action', id: String(action._id), label: action.actionType },
        networkId: action.networkId,
        incidentId: action.incidentId,
        actionId: action._id,
        decision: 'deny',
        outcome: 'failure',
        reason: verdict.reasons.join('; '),
      },
      req,
    );
    const permissionIssue = verdict.reasons.some((r) => r.startsWith('PERMISSION_DENIED') || r.startsWith('SCOPE_DENIED'));
    if (permissionIssue) throw forbidden('PERMISSION_DENIED', verdict.reasons.join('; '));
    throw new AppError(409, 'POLICY_REJECTED', 'Policy engine rejected execution', { reasons: verdict.reasons });
  }

  // Unique index on Approval.actionId makes double-approval a hard conflict.
  try {
    await Approval.create({ actionId: action._id, approverId: user._id, decision: 'approved', reason: reason || null, decidedAt: new Date() });
  } catch (err) {
    if (err?.code === 11000) throw conflict('ALREADY_DECIDED', 'Action already has a decision');
    throw err;
  }

  const command = await AgentCommand.create({
    deviceId: action.deviceId,
    actionId: action._id,
    type: verdict.agentCommand,
    params: verdict.params,
    deadlineAt: new Date(Date.now() + verdict.timeoutMs),
  });
  const updated = await ProposedAction.findOneAndUpdate(
    { _id: action._id, status: 'awaiting_approval' },
    { status: 'queued', commandId: command._id },
    { new: true },
  );
  if (!updated) {
    await AgentCommand.updateOne({ _id: command._id }, { status: 'cancelled' });
    throw conflict('ACTION_NOT_PENDING', 'Action changed state concurrently');
  }
  if (incident?.active) await Incident.updateOne({ _id: incident._id, active: true }, { state: 'mitigating' });

  await audit.record(
    {
      operation: 'action.approve',
      target: { type: 'action', id: String(action._id), label: action.actionType },
      networkId: action.networkId,
      incidentId: action.incidentId,
      actionId: action._id,
      outcome: 'pending',
      reason: reason || null,
      metadata: { commandId: String(command._id), params: verdict.params },
    },
    req,
  );
  req?.app?.locals?.realtime?.emitNetwork(action.networkId, 'action:update', { actionId: String(action._id) });
  return updated;
}

async function rejectAction({ actionId, user, reason, req }) {
  const { action, network } = await loadActionInScope(user, actionId);
  const role = roleOnNetwork(user, network);
  if (!role || role === 'viewer') throw forbidden('SCOPE_DENIED', 'Read-only access to this network');
  if (action.status !== 'awaiting_approval') throw conflict('ACTION_NOT_PENDING', `Action is ${action.status}`);
  try {
    await Approval.create({ actionId: action._id, approverId: user._id, decision: 'rejected', reason, decidedAt: new Date() });
  } catch (err) {
    if (err?.code === 11000) throw conflict('ALREADY_DECIDED', 'Action already has a decision');
    throw err;
  }
  action.status = 'rejected';
  await action.save();
  if (action.incidentId) {
    const stillPending = await ProposedAction.exists({ incidentId: action.incidentId, status: 'awaiting_approval' });
    if (!stillPending) await Incident.updateOne({ _id: action.incidentId, active: true, state: 'awaiting_approval' }, { state: 'investigating' });
  }
  await audit.record(
    {
      operation: 'action.reject',
      target: { type: 'action', id: String(action._id), label: action.actionType },
      networkId: action.networkId,
      incidentId: action.incidentId,
      actionId: action._id,
      reason,
    },
    req,
  );
  return action;
}

/** Called after the agent posts a command result (or a timeout is recorded). */
async function finalizeCommand({ command, config, realtime, req }) {
  const action = await ProposedAction.findById(command.actionId);
  if (!action) return null;
  const verification = await verifyAction(action, command);
  action.status = 'completed';
  action.verification = verification;
  await action.save();
  await audit.record(
    {
      actor: audit.SYSTEM_ACTOR,
      operation: 'action.verify',
      target: { type: 'action', id: String(action._id), label: action.actionType },
      networkId: action.networkId,
      incidentId: action.incidentId,
      actionId: action._id,
      outcome: verification.outcome === 'successful' ? 'success' : 'failure',
      reason: verification.notes.join('; '),
      metadata: { outcome: verification.outcome, commandStatus: command.status },
    },
    req,
  );

  // The incident is re-evaluated from observations; executing an action never
  // marks it resolved by itself.
  const device = await Device.findById(action.deviceId).lean();
  if (device) await runDetector({ config, realtime, networkIds: [device.networkId], deviceId: device._id });
  const incident = action.incidentId ? await Incident.findById(action.incidentId) : null;
  if (incident?.active && incident.state === 'mitigating') {
    const inFlight = await ProposedAction.exists({ incidentId: incident._id, status: { $in: ['queued', 'executing'] } });
    if (!inFlight) await Incident.updateOne({ _id: incident._id, active: true }, { state: 'investigating' });
  }
  realtime?.emitNetwork(action.networkId, 'action:update', { actionId: String(action._id) });
  return action;
}

async function sweepTimedOutCommands({ config, realtime }) {
  const expired = await AgentCommand.find({ status: { $in: ['queued', 'delivered'] }, deadlineAt: { $lt: new Date() } }).limit(100);
  for (const c of expired) {
    const res = await AgentCommand.updateOne({ _id: c._id, status: c.status }, { status: 'timed_out', completedAt: new Date() });
    if (res.modifiedCount) {
      c.status = 'timed_out';
      await finalizeCommand({ command: c, config, realtime });
    }
  }
  return expired.length;
}

module.exports = { requestDeviceAction, proposeActions, approveAction, rejectAction, finalizeCommand, sweepTimedOutCommands, loadActionInScope };
