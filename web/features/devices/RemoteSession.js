'use client';

import { useEffect, useState } from 'react';
import { MonitorUp, Radio } from 'lucide-react';
import { Card, KV } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { CopyButton } from './JoinInstructions';
import { guessOs } from '@/lib/join';
import { timeAgo } from '@/lib/format';

const LABEL = { rdp: 'remote desktop', ssh: 'ssh', vnc: 'vnc', http: 'web app', https: 'web app (https)', tcp: 'tcp' };

/**
 * How to open a remote session to this device from your own enrolled PC.
 * Sessions run inside the WireGuard tunnel (direct or relayed); the portal
 * only shows the command — it never carries the session itself.
 */
export default function RemoteSession({ device: d, now }) {
  const [os, setOs] = useState('windows');
  useEffect(() => setOs(guessOs()), []);
  const ip = d.membership?.address;
  const services = d.services || [];
  const online = d.peerLinks?.some((l) => l.state === 'connected' || l.state === 'degraded');
  const exe = os === 'windows' ? `& "$env:LOCALAPPDATA\\NexLink\\nexlink-agent.exe"` : '~/.local/share/nexlink/nexlink-agent';
  const relay = d.relay || { connected: false };

  return (
    <Card label="remote session" action={<MonitorUp className="h-4 w-4 text-lime" />}>
      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        <KV k="relay">
          <span className="inline-flex items-center gap-2">
            <Radio className={`h-3.5 w-3.5 ${relay.connected ? 'text-lime' : 'text-mid'}`} />
            {relay.connected ? `connected · since ${timeAgo(relay.since, now)}` : 'not connected'}
          </span>
        </KV>
        <KV k="tunnel">{online ? <StatusBadge state="connected" /> : <StatusBadge state="unknown" label="no peer handshake" />}</KV>
      </div>

      {!ip || d.enrollmentState !== 'enrolled' ? (
        <p className="text-sm text-mid">available once the device is enrolled and has a virtual ip.</p>
      ) : services.length === 0 ? (
        <div className="space-y-2 text-sm text-white/80">
          <p>{d.name} shares nothing for remote sessions — that is the safe default and only its owner can change it.</p>
          <p className="text-xs text-mid">
            to allow it, run its join line again with “allow remote sessions: remote desktop” selected, or start the agent with{' '}
            <span className="font-mono text-lime">--share rdp</span> (also ssh, vnc, http:3000…).
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-mid">
            run this on <b className="text-white">your own pc</b> while its NexLink agent is running in this network. the session travels
            inside the encrypted tunnel — directly, or through the relay when the networks in between block it.
          </p>
          {services.map((s) => {
            const cmd = `${exe} session ${ip} ${s.name}${s.name === 'ssh' ? ' --user <name>' : ''}`;
            return (
              <div key={`${s.name}:${s.port}`} className="rounded-panel border border-line p-3">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-semibold">{LABEL[s.name] || s.name}</span>
                  <span className="font-mono text-xs text-mid">{ip}:{s.port}</span>
                </div>
                <pre className="mb-2 overflow-x-auto whitespace-pre-wrap break-all rounded-control bg-ink p-3 font-mono text-[11px] text-lime">{cmd}</pre>
                <CopyButton text={cmd} label="copy" variant="ghost" className="w-full !py-1.5" />
              </div>
            );
          })}
          <p className="text-[11px] text-mid">
            with the WireGuard app instead of the userspace agent, the tunnel ip is routed by windows directly:{' '}
            <span className="font-mono">mstsc /v:{ip}</span>
          </p>
        </div>
      )}
    </Card>
  );
}
