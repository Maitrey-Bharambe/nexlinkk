'use client';

import Link from 'next/link';
import { useApi, useNow } from '@/hooks/useApi';
import StatusBadge, { StatusMarker, toneOf } from '@/components/StatusBadge';
import { timeAgo } from '@/lib/format';

const LINE = {
  good: 'border-lime',
  progress: 'border-lime/50 border-dashed',
  warn: 'border-amber',
  bad: 'border-coral border-dashed',
  info: 'border-white/60',
  none: 'border-white/30 border-dotted',
};
const BOX = { good: 'border-lime', progress: 'border-lime/50', warn: 'border-amber', bad: 'border-coral', info: 'border-white/60', none: 'border-line-strong' };

function NodeBox({ kind, title, sub, state, href, invert = false }) {
  const tone = toneOf(state);
  const body = (
    <div className={`flex items-center justify-between gap-3 border px-3 py-2 ${invert ? 'border-white bg-white text-ink' : `bg-ink ${BOX[tone]}`}`}>
      <div className="min-w-0">
        <div className={`flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] ${invert ? 'text-ink/60' : 'text-white/55'}`}>
          {!invert && <StatusMarker state={state} />}
          {kind}
        </div>
        <div className={`break-all ${invert ? 'font-pixel text-[10px] uppercase leading-relaxed' : 'text-[13px] font-semibold'}`}>{title}</div>
      </div>
      {sub && <div className={`shrink-0 text-right font-mono text-[11px] ${invert ? 'text-ink/70' : 'text-white/65'}`}>{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

/** A vertical link with its label; verified links carry square packets. */
function Wire({ state, label }) {
  const tone = toneOf(state);
  return (
    <div className="flex h-11 items-stretch gap-3 pl-5">
      <div className={`relative w-0 border-l-2 ${LINE[tone]}`}>
        {state === 'connected' &&
          [0, 1].map((k) => (
            <span key={k} aria-hidden className="packet-fall absolute -left-[5px] h-2 w-2 border border-ink bg-lime" style={{ animationDelay: `${k * 0.7}s` }} />
          ))}
      </div>
      <span className="self-center font-mono text-[10px] uppercase tracking-[0.12em] text-white/60">{label}</span>
    </div>
  );
}

/**
 * The connection this incident is about, from the device's current record:
 * NexLink above (the HTTPS control channel), the peer below (the WireGuard
 * tunnel, direct or through the relay). Nothing is drawn as connected
 * without handshake evidence.
 */
export default function PathView({ deviceId, peerDeviceId }) {
  const now = useNow();
  const { data: d } = useApi(deviceId ? `/devices/${deviceId}` : null, { events: ['device:update'], pollMs: 15_000 });
  if (!d) return <div className="h-48 border border-line bg-ink-2" aria-label="loading path" />;

  const h = d.health || {};
  const link = (d.peerLinks || []).find((l) => l.peerDeviceId === peerDeviceId) || (peerDeviceId ? null : d.peerLinks?.[0]);
  const agent = h.agent?.status || 'unknown';
  const verified = link && (link.state === 'connected' || link.state === 'degraded');
  const viaRelay = verified && link.path === 'relay';

  return (
    <div>
      <NodeBox kind="control plane" title="nexlink" sub={d.lastHeartbeatAt ? `heartbeat ${timeAgo(d.lastHeartbeatAt, now)}` : 'no heartbeat'} invert />
      <Wire state={agent === 'online' ? 'connected' : agent === 'stale' ? 'degraded' : agent === 'offline' ? 'unreachable' : 'unknown'} label={`https · agent ${agent.replace('_', ' ')}`} />
      <NodeBox kind="device" title={d.name} sub={`${d.membership?.address || 'no address'} · vpn ${h.vpn?.state || 'unknown'}`} state={h.status || 'unknown'} href={`/devices/${d.id}`} />
      {link ? (
        <>
          <Wire state={link.state} label={`wireguard · ${verified ? link.path : link.state}`} />
          {viaRelay && (
            <>
              <NodeBox kind="relay" title="nexlink relay" sub="forwards ciphertext" state={link.state} />
              <Wire state={link.state} label="wireguard · relay" />
            </>
          )}
          <NodeBox
            kind="peer"
            title={link.peerName || link.peerDeviceId}
            sub={link.lastHandshakeAt ? `handshake ${timeAgo(link.lastHandshakeAt, now)}` : 'no handshake'}
            state={link.state}
            href={`/devices/${link.peerDeviceId}`}
          />
          <div className="mt-3 flex items-center gap-2 text-xs text-white/65">
            tunnel <StatusBadge state={link.state} />
            {link.reason && <span className="truncate">{link.reason}</span>}
          </div>
        </>
      ) : (
        <p className="mt-3 border border-dashed border-line px-3 py-2.5 text-xs text-mid">
          no peer tunnel involved — this device has no configured peer{peerDeviceId ? ' matching this incident' : ''}.
        </p>
      )}
      <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-white/55">latest reports · packets move only on verified links</p>
    </div>
  );
}
