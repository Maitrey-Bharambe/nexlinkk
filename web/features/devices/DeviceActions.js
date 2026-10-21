'use client';

import { useState } from 'react';
import { Activity, RefreshCw, Radar, Wrench } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { Button, Card, ErrorState, inputCls } from '@/components/ui';
import ActionCard from '@/features/incidents/ActionCard';
import { post } from '@/lib/api';

/**
 * "Run on this device": ask the agent to do something. Every request goes
 * through the policy engine and must be approved (you can approve inline);
 * the agent runs it and the verified result shows up below.
 */
export default function DeviceActions({ device, canRequest, canDecide }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const peers = (device.peerLinks || []).map((l) => ({ id: l.peerDeviceId, name: l.peerName || l.peerDeviceId }));
  const [peerId, setPeerId] = useState('');
  const { data: actions, reload } = useApi(`/devices/${device.id}/actions`, { events: ['action:update'], pollMs: 5000 });

  async function request(key, body) {
    setBusy(key);
    setError(null);
    try {
      await post(`/devices/${device.id}/actions`, body);
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const disabled = !canRequest || device.enrollmentState !== 'enrolled';
  const privileged = (device.capabilities || []).includes('wireguard_apply');

  return (
    <Card label="run on this device">
      {disabled ? (
        <p className="text-sm text-mid">
          {device.enrollmentState !== 'enrolled' ? 'the device must be enrolled first.' : 'your role can view results but not request actions.'}
        </p>
      ) : (
        <div className="space-y-2.5">
          <Button
            variant="ghost"
            className="w-full justify-start"
            busy={busy === 'cp'}
            disabled={Boolean(busy)}
            onClick={() => request('cp', { actionType: 'run_connectivity_test', params: { target: 'control_plane', count: 5 } })}
          >
            <Activity className="h-4 w-4" /> connectivity test → control plane
          </Button>
          <div className="flex gap-2">
            <select className={`${inputCls} py-2`} value={peerId} onChange={(e) => setPeerId(e.target.value)} disabled={!peers.length}>
              <option value="">{peers.length ? 'choose a peer…' : 'no peers in this network'}</option>
              {peers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <Button
              variant="ghost"
              className="shrink-0"
              busy={busy === 'peer'}
              disabled={Boolean(busy) || !peerId}
              onClick={() => request('peer', { actionType: 'run_connectivity_test', params: { target: 'peer', peerDeviceId: peerId, count: 5 } })}
            >
              <Radar className="h-4 w-4" /> test tunnel
            </Button>
          </div>
          <Button
            variant="ghost"
            className="w-full justify-start"
            busy={busy === 'status'}
            disabled={Boolean(busy)}
            onClick={() => request('status', { actionType: 'request_peer_status_report', params: {} })}
          >
            <RefreshCw className="h-4 w-4" /> refresh WireGuard status
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start"
            busy={busy === 'apply'}
            disabled={Boolean(busy)}
            onClick={() => request('apply', { actionType: 'request_vpn_config_refresh', params: {} })}
            title={privileged ? '' : 'needs privileged mode on the device — the policy engine will refuse it'}
          >
            <Wrench className="h-4 w-4" /> re-apply VPN config {privileged ? '' : '(privileged mode off)'}
          </Button>
          <ErrorState error={error} />
          <p className="pt-1 text-[11px] text-mid">
            each request is checked by the policy engine and needs an approval — approve it below. the agent runs it on its next heartbeat and the result is verified from fresh measurements.
          </p>
        </div>
      )}

      <div className="mt-5 space-y-3">
        <div className="label">recent requests on this device</div>
        {!actions?.length ? (
          <p className="text-sm text-mid">none yet.</p>
        ) : (
          actions.slice(0, 5).map((a) => <ActionCard key={a.id} action={a} canDecide={canDecide} onChange={reload} />)
        )}
      </div>
    </Card>
  );
}
