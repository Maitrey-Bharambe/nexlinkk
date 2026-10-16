'use strict';

const { z } = require('zod');
const { objectId } = require('../../utils/http');

/**
 * Allowlist of operations that may ever be proposed. Anything not listed here
 * is rejected by the policy engine, regardless of who or what proposed it.
 * Every action requires human approval in this milestone.
 */
const ACTIONS = {
  run_connectivity_test: {
    description: 'Agent runs bounded TCP-connect RTT/loss probes to the control plane or a peer tunnel address',
    risk: 'low',
    available: true,
    agentCommand: 'connectivity_test',
    requiredCapability: 'connectivity_probe',
    timeoutMs: 30_000,
    perHourLimit: 12,
    params: z
      .object({
        target: z.enum(['control_plane', 'peer']),
        peerDeviceId: objectId.optional(),
        count: z.number().int().min(1).max(20).default(5),
      })
      .strict()
      .refine((p) => p.target !== 'peer' || p.peerDeviceId, { message: 'peerDeviceId required for peer target' }),
    verification: 'Probe measurements tagged with this command exist and are valid',
  },
  request_peer_status_report: {
    description: 'Agent re-reads WireGuard peer state and sends a fresh telemetry report',
    risk: 'low',
    available: true,
    agentCommand: 'report_peer_status',
    requiredCapability: 'wireguard_inspect',
    timeoutMs: 30_000,
    perHourLimit: 20,
    params: z.object({}).strict(),
    verification: 'Telemetry received after the command was issued',
  },
  request_vpn_config_refresh: {
    description: 'Agent fetches desired peer config and applies it to the WireGuard interface',
    risk: 'medium',
    available: true,
    agentCommand: 'refresh_vpn_config',
    requiredCapability: 'wireguard_apply',
    timeoutMs: 60_000,
    perHourLimit: 3,
    params: z.object({}).strict(),
    verification: 'Agent reports current configVersion applied and fresh telemetry shows interface up',
  },
  request_relay_fallback: {
    description: 'Route peer traffic through a relay when direct UDP fails',
    risk: 'medium',
    available: false,
    unavailableReason: 'Relay transport is not implemented yet (see docs/implementation-roadmap.md)',
    params: z.object({ peerDeviceId: objectId }).strict(),
  },
};

const approverPermission = (risk) => (risk === 'low' ? 'actions:approve:low' : 'actions:approve:high');

function describeActions() {
  return Object.entries(ACTIONS).map(([id, a]) => ({
    id,
    description: a.description,
    risk: a.risk,
    available: a.available,
    unavailableReason: a.unavailableReason || null,
    timeoutMs: a.timeoutMs || null,
    requiresApproval: true,
    approverPermission: approverPermission(a.risk),
    verification: a.verification || null,
  }));
}

module.exports = { ACTIONS, approverPermission, describeActions };
