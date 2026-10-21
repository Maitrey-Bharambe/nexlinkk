'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Share2 } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { Empty, ErrorState, Loading, Numeral, PageHeader } from '@/components/ui';
import TopologyGraph from '@/features/topology/TopologyGraph';
import { timeAgo } from '@/lib/format';

// [state, look, meaning, sample line (svg stroke props)]
const LEGEND = [
  ['connected · direct', 'lime, travelling pulse', 'fresh WireGuard handshake over direct UDP', { stroke: '#C7FF2E', strokeWidth: 2 }],
  ['connected · relay', 'lime, long dashes', 'fresh handshake; ciphertext through the NexLink relay', { stroke: '#C7FF2E', strokeWidth: 2, strokeDasharray: '10 6' }],
  ['degraded', 'amber', 'handshake ok, loss or latency above threshold', { stroke: '#F2B94B', strokeWidth: 2 }],
  ['connecting', 'thin dashed lime', 'peer configured, no handshake yet', { stroke: '#C7FF2E', strokeOpacity: 0.6, strokeWidth: 1.25, strokeDasharray: '4 6' }],
  ['unreachable', 'dashed coral', 'handshake went stale', { stroke: '#FF5A36', strokeWidth: 1.5, strokeDasharray: '5 5' }],
  ['configured / unknown', 'dotted gray', 'intended only — no evidence either way', { stroke: '#808080', strokeWidth: 1.5, strokeDasharray: '1 5' }],
];

function Toggle({ on, onChange, children }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={`flex h-9 items-center gap-2 rounded-control border px-3 font-mono text-[11px] uppercase tracking-wider transition-colors ${
        on ? 'border-lime/50 text-white' : 'border-line text-mid hover:text-white'
      }`}
    >
      <span aria-hidden className={`h-3 w-3 rounded-[3px] border ${on ? 'border-lime bg-lime' : 'border-line-strong'}`} />
      {children}
    </button>
  );
}

function Topology() {
  const params = useSearchParams();
  const router = useRouter();
  const networkId = params.get('networkId');
  // Network list for the filter comes from the unfiltered topology (same API).
  const { data: all } = useApi('/topology', { pollMs: 60_000 });
  const networks = all?.nodes.filter((n) => n.type === 'network') || [];
  const now = useNow();
  const [showControl, setShowControl] = useState(true);
  const [showMembership, setShowMembership] = useState(false);
  const { data, error, loading, reload, fetchedAt } = useApi(`/topology${networkId ? `?networkId=${networkId}` : ''}`, {
    events: ['device:update', 'network:update'],
    pollMs: 15_000,
  });

  const devices = data?.nodes.filter((n) => n.type === 'device') || [];
  const peerEdges = data?.edges.filter((e) => e.kind === 'peer') || [];
  const connected = peerEdges.filter((e) => e.state === 'connected');
  const relayed = connected.filter((e) => e.path === 'relay').length;
  const counts = ['degraded', 'connecting', 'unreachable'].map((s) => [s, peerEdges.filter((e) => e.state === s).length]);

  return (
    <div>
      <PageHeader
        kicker={`observed vs configured · refreshed ${timeAgo(fetchedAt, now) || '—'}`}
        title="topology"
        description="every line is a configured peer pair. it turns lime only when an agent reports a fresh WireGuard handshake."
      >
        {networks.length > 1 && (
          <label className="flex h-9 items-center gap-2 rounded-control border border-line px-3 font-mono text-[11px] uppercase tracking-wider text-mid">
            network
            <select
              className="bg-transparent normal-case tracking-normal text-white outline-none"
              value={networkId || ''}
              onChange={(e) => router.replace(e.target.value ? `/topology?networkId=${e.target.value}` : '/topology')}
            >
              <option value="" className="bg-ink">all ({networks.length})</option>
              {networks.map((n) => (
                <option key={n.id} value={n.networkId} className="bg-ink">{n.label} · {n.cidr}</option>
              ))}
            </select>
          </label>
        )}
        <Toggle on={showControl} onChange={setShowControl}>control channel</Toggle>
        <Toggle on={showMembership} onChange={setShowMembership}>membership</Toggle>
      </PageHeader>
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : devices.length === 0 ? (
        <Empty icon={Share2} title="nothing to draw yet">enrolled devices appear here. links are drawn as configured until an agent reports a handshake.</Empty>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="relative h-[min(680px,72vh)] min-h-[420px] overflow-hidden rounded-panel border border-line bg-ink" role="img" aria-label={`Topology: ${devices.length} devices, ${connected.length} of ${peerEdges.length} tunnels verified`}>
            <TopologyGraph key={networkId || "all"} graph={data} showControl={showControl} showMembership={showMembership} />
          </div>
          <div className="space-y-4">
            <section className="ticks rounded-panel border border-line bg-ink-2 p-5">
              <div className="label">verified tunnels</div>
              <div className="mt-4 flex items-baseline gap-1 text-6xl font-semibold">
                <Numeral value={connected.length} className={connected.length ? 'text-lime' : 'text-white/40'} />
                <span className="numeral text-2xl text-white/30">/{peerEdges.length}</span>
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-y-1.5 border-t border-line pt-4 font-mono text-[11px] uppercase tracking-wider">
                <dt className="text-mid">direct</dt><dd className="text-right tabular">{connected.length - relayed}</dd>
                <dt className="text-mid">relay</dt><dd className="text-right tabular">{relayed}</dd>
                {counts.map(([s, n]) => (
                  <div key={s} className="contents">
                    <dt className="text-mid">{s}</dt>
                    <dd className={`text-right tabular ${n && s === 'unreachable' ? 'text-coral' : n && s === 'degraded' ? 'text-amber' : ''}`}>{n}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="rounded-panel border border-line p-5">
              <div className="label mb-4">legend</div>
              <ul className="space-y-3.5">
                {LEGEND.map(([state, look, meaning, stroke]) => (
                  <li key={state} className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-3">
                    <svg width="44" height="10" className="mt-1.5" aria-hidden>
                      <line x1="0" y1="5" x2="44" y2="5" {...stroke} />
                    </svg>
                    <div>
                      <div className="text-[13px] font-medium">{state}</div>
                      <div className="text-[11px] text-mid">{look} — {meaning}</div>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-5 border-t border-line pt-3 text-[11px] text-mid">
                dotted arrows to nexlink are the signed https control channel, not the vpn data path. a relayed tunnel is still
                end-to-end WireGuard; the relay only forwards ciphertext.
              </p>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TopologyPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Topology />
    </Suspense>
  );
}
