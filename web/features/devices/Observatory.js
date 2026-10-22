'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { ErrorState, Loading, Segmented } from '@/components/ui';
import StatusBadge, { StatusMarker } from '@/components/StatusBadge';
import { LineBandChart } from '@/features/insights/charts';
import { fmtTime, timeAgo } from '@/lib/format';

const WINDOWS = [
  ['1h', '1h'],
  ['6h', '6h'],
  ['24h', '24h'],
  ['7d', '7d'],
];

const KIND_STATE = { incident: 'open', resolved: 'resolved', action: 'pending', verified: 'completed', silence: 'stale', agent: 'unknown' };
const sevState = (e) => ({ bad: 'failed', warn: 'degraded', good: 'healthy' }[e.severity] || KIND_STATE[e.kind] || 'unknown');

const v = (x, unit) => (x == null ? <span className="text-mid">not measured</span> : <>{x}<span className="text-mid"> {unit}</span></>);

function fmtBytes(n) {
  if (n == null) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Configured vs observed for one peer pair, with the evidence for each claim. */
function ConnectionInspector({ peer, now }) {
  if (!peer) return <p className="p-5 text-sm text-mid">select a peer to inspect the connection.</p>;
  const verified = peer.state === 'connected' || peer.state === 'degraded';
  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/devices/${peer.peerDeviceId}`} className="text-lg font-semibold hover:text-lime">{peer.peerName || peer.peerDeviceId}</Link>
        <StatusBadge state={peer.state} />
      </div>

      <dl className="grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden rounded-control border border-line bg-line sm:grid-cols-2">
        {[
          ['configured', 'WireGuard peer pair (full mesh) — intended, not evidence'],
          ['observed state', `${peer.state.replace(/_/g, ' ')}${peer.reason ? ` — ${peer.reason}` : ''}`],
          ['path', verified && peer.path !== 'unknown' ? `${peer.path}${peer.path === 'relay' ? ' · ciphertext via NexLink relay' : ' · UDP between the two computers'}` : 'not verified (needs a fresh handshake)'],
          ['latest handshake', peer.lastHandshakeAt ? `${timeAgo(peer.lastHandshakeAt, now)} · ${fmtTime(peer.lastHandshakeAt)}` : 'never observed'],
          ['rtt in window', peer.rtt.samples ? `avg ${peer.rtt.avg} ms · p95 ${peer.rtt.p95} ms · last ${peer.rtt.last} ms (${peer.rtt.samples} samples)` : 'not measured'],
          ['packet loss', peer.lossAvg == null ? 'not measured' : `${peer.lossAvg}% average`],
        ].map(([k, val]) => (
          <div key={k} className="bg-ink-2 px-4 py-3">
            <dt className="label mb-1">{k}</dt>
            <dd className="text-sm">{val}</dd>
          </div>
        ))}
      </dl>

      <div>
        <div className="label mb-2">last known failure</div>
        {peer.lastFailure ? (
          <p className="flex items-start gap-2 text-sm">
            <StatusMarker state="failed" className="mt-1.5" />
            <span>{peer.lastFailure.error} <span className="font-mono text-[11px] text-mid">· {peer.lastFailure.type.replace(/_/g, ' ')} · {timeAgo(peer.lastFailure.at, now)}</span></span>
          </p>
        ) : (
          <p className="text-sm text-mid">none recorded in this window.</p>
        )}
      </div>

      <div>
        <div className="label mb-2">what each side reported</div>
        {peer.observedBy.length === 0 ? (
          <p className="text-sm text-mid">neither side has reported this peer yet.</p>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[460px] text-left text-xs">
              <thead>
                <tr className="text-mid">
                  {['reported by', 'handshake', 'path', 'rx', 'tx', 'report'].map((h) => <th key={h} scope="col" className="label py-2 pr-3 font-normal">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {peer.observedBy.map((o) => (
                  <tr key={o.deviceId} className="border-t border-line">
                    <td className="py-2 pr-3">{o.deviceName || o.deviceId}</td>
                    <td className="py-2 pr-3 font-mono">{o.lastHandshakeAt ? timeAgo(o.lastHandshakeAt, now) : 'never'}</td>
                    <td className="py-2 pr-3 font-mono">{o.path}</td>
                    <td className="py-2 pr-3 font-mono">{fmtBytes(o.rxBytes) ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono">{fmtBytes(o.txBytes) ?? '—'}</td>
                    <td className="py-2 font-mono text-mid">{timeAgo(o.observedAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="label mb-2">incidents involving this pair</div>
        {peer.incidents.length === 0 ? (
          <p className="text-sm text-mid">none in the last 7 days.</p>
        ) : (
          <ul className="space-y-1.5">
            {peer.incidents.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 text-sm">
                <Link href={`/diagnostics/${i.id}`} className="truncate hover:text-lime">{i.isTest ? '[test] ' : ''}{i.category.replace(/_/g, ' ')}</Link>
                <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-mid">{timeAgo(i.detectedAt, now)} <StatusBadge state={i.state} /></span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Live network observatory for one device: performance over a chosen window
 * with events on the same axis, and a connection inspector per peer.
 */
export default function Observatory({ deviceId, now }) {
  const [win, setWin] = useState('24h');
  const [peerId, setPeerId] = useState(null);
  const { data, error, loading, reload } = useApi(`/devices/${deviceId}/metrics?window=${win}`, { events: ['device:update', 'incident:update', 'action:update'], pollMs: 30_000 });

  useEffect(() => {
    if (data?.peers?.length && !data.peers.some((p) => p.peerDeviceId === peerId)) setPeerId(data.peers[0].peerDeviceId);
  }, [data, peerId]);

  if (loading && !data) return <Loading label="loading measurements" />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const s = data.summary;
  const bucket = data.bucketMinutes;
  const span = (i) => (data.series.length - 1 - i) * bucket;
  const xLabel = (i) => (i === data.series.length - 1 ? 'now' : span(i) >= 1440 ? `${Math.round(span(i) / 1440)}d ago` : span(i) >= 60 ? `${Math.round(span(i) / 60)}h ago` : `${span(i)}m ago`);
  const tipLabel = (p) => `${fmtTime(p.t)} · ${bucket} min`;
  const peer = data.peers.find((p) => p.peerDeviceId === peerId);

  return (
    <section className="mt-4 overflow-hidden rounded-panel border border-line bg-ink-2" aria-label="Network observatory">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <div className="label">observatory</div>
          <p className="mt-1 text-xs text-mid">measured through the tunnel by this device&apos;s agent. gaps mean nothing was measured, not zero.</p>
        </div>
        <Segmented label="Time window" value={win} onChange={setWin} options={WINDOWS} />
      </div>

      <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-5">
        {[
          ['rtt avg', v(s.rttAvg, 'ms')],
          ['rtt p95', v(s.rttP95, 'ms')],
          ['packet loss', v(s.lossAvg, '%')],
          ['throughput', s.throughputAvg == null ? <span className="text-mid">not measured</span> : v(s.throughputAvg, 'bps')],
          ['samples', s.samples ? s.samples : <span className="text-mid">0</span>],
        ].map(([k, val]) => (
          <div key={k} className="bg-ink-2 px-5 py-3">
            <dt className="label">{k}</dt>
            <dd className="tabular mt-1 font-mono text-sm">{val}</dd>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-[minmax(0,1fr)] border-t border-line lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="p-5">
          <div className="label mb-3">tunnel rtt · {win} · {bucket}-min buckets</div>
          <LineBandChart series={data.series} lineKey="rttAvg" bandKey="rttP95" unit="ms" label={`Tunnel round-trip time over ${win}`} xLabel={xLabel} tipLabel={tipLabel} events={data.events} height={200} />
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10.5px] uppercase tracking-wider text-mid">
            <span className="flex items-center gap-2"><span className="h-0.5 w-5 rounded bg-lime" aria-hidden /> average</span>
            <span className="flex items-center gap-2"><span className="h-2.5 w-5 rounded-[1px] bg-lime/15" aria-hidden /> up to p95</span>
            <span className="flex items-center gap-2"><span className="h-2 w-1 bg-coral" aria-hidden /> incident</span>
            <span className="flex items-center gap-2"><span className="h-2 w-1 bg-amber" aria-hidden /> warning</span>
            <span className="flex items-center gap-2"><span className="h-2 w-1 bg-lime" aria-hidden /> resolved / verified</span>
          </div>
          <div className="mt-5">
            <div className="label mb-2">packet loss · {win}</div>
            <LineBandChart series={data.series} lineKey="lossAvg" unit="%" label={`Packet loss over ${win}`} xLabel={xLabel} tipLabel={tipLabel} height={120} />
          </div>
        </div>
        <div className="border-t border-line lg:border-l lg:border-t-0">
          <div className="px-5 pt-5 label">events in this window · {data.events.length}</div>
          {data.events.length === 0 ? (
            <p className="px-5 py-4 text-sm text-mid">nothing happened in this window.</p>
          ) : (
            <ol className="max-h-[420px] overflow-y-auto px-5 py-3 scrollbar-thin">
              {data.events.map((e, i) => (
                <li key={i} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-line/60 py-2 last:border-0">
                  <StatusMarker state={sevState(e)} />
                  <span className="min-w-0 text-[13px]">
                    {e.kind === 'incident' || e.kind === 'resolved' ? (
                      <Link href={`/diagnostics/${e.ref}`} className="hover:text-lime">{e.label}</Link>
                    ) : e.incidentId ? (
                      <Link href={`/diagnostics/${e.incidentId}`} className="hover:text-lime">{e.label}</Link>
                    ) : (
                      e.label
                    )}
                  </span>
                  <time className="font-mono text-[10.5px] text-mid" dateTime={e.at} title={fmtTime(e.at)}>{timeAgo(e.at, now)}</time>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="border-t border-line">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
          <div className="label">connection inspector</div>
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-mid">configured pairs · observed state</span>
        </div>
        {data.peers.length === 0 ? (
          <p className="px-5 py-5 text-sm text-mid">no peers: this device is alone in its network.</p>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]">
            <ul className="p-3" role="listbox" aria-label="Peers">
              {data.peers.map((p) => (
                <li key={p.peerDeviceId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={p.peerDeviceId === peerId}
                    onClick={() => setPeerId(p.peerDeviceId)}
                    className={`flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-sm transition-colors ${p.peerDeviceId === peerId ? 'bg-ink-3' : 'hover:bg-white/[0.03]'}`}
                  >
                    <StatusMarker state={p.state} />
                    <span className="min-w-0 flex-1 truncate">{p.peerName || p.peerDeviceId}</span>
                    <span className="font-mono text-[10.5px] uppercase text-mid">{p.state === 'connected' || p.state === 'degraded' ? p.path : p.state}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t border-line lg:border-l lg:border-t-0">
              <ConnectionInspector peer={peer} now={now} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
