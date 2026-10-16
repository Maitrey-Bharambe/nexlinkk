'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Share2 } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { Empty, ErrorState, Loading, PageHeader } from '@/components/ui';
import TopologyGraph from '@/features/topology/TopologyGraph';
import { timeAgo } from '@/lib/format';

const LEGEND = [
  ['connected', 'solid lime', 'fresh wireguard handshake observed', 'border-t-[3px] border-lime'],
  ['degraded', 'solid white', 'handshake ok, loss/latency high', 'border-t-2 border-white'],
  ['connecting', 'dashed lime', 'peer configured, no handshake yet', 'border-t-2 border-dashed border-lime'],
  ['unreachable', 'dashed coral', 'handshake went stale', 'border-t-2 border-dashed border-coral'],
  ['configured / unknown', 'dotted gray', 'intended only — no evidence', 'border-t-2 border-dotted border-mid'],
];

function Topology() {
  const params = useSearchParams();
  const networkId = params.get('networkId');
  const now = useNow();
  const [showControl, setShowControl] = useState(true);
  const [showMembership, setShowMembership] = useState(false);
  const { data, error, loading, reload, fetchedAt } = useApi(`/topology${networkId ? `?networkId=${networkId}` : ''}`, {
    events: ['device:update', 'network:update'],
    pollMs: 15_000,
  });

  const devices = data?.nodes.filter((n) => n.type === 'device') || [];
  const peerEdges = data?.edges.filter((e) => e.kind === 'peer') || [];

  return (
    <div>
      <PageHeader kicker={`observed vs configured · refreshed ${timeAgo(fetchedAt, now) || '—'}`} title="topology">
        <label className="flex cursor-pointer items-center gap-2 rounded-full border border-charcoal px-4 py-2 font-mono text-xs uppercase text-mid">
          <input type="checkbox" checked={showControl} onChange={(e) => setShowControl(e.target.checked)} className="accent-[#C7FF2E]" />
          control channel
        </label>
        <label className="flex cursor-pointer items-center gap-2 rounded-full border border-charcoal px-4 py-2 font-mono text-xs uppercase text-mid">
          <input type="checkbox" checked={showMembership} onChange={(e) => setShowMembership(e.target.checked)} className="accent-[#C7FF2E]" />
          membership
        </label>
      </PageHeader>
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : devices.length === 0 ? (
        <Empty icon={Share2} title="nothing to draw yet">enrolled devices appear here. links are drawn as configured until an agent reports a handshake.</Empty>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
          <div className="h-[640px] overflow-hidden rounded-blob border border-charcoal bg-ink-2">
            <TopologyGraph graph={data} showControl={showControl} showMembership={showMembership} />
          </div>
          <div className="space-y-4">
            <div className="rounded-blob bg-lime p-5 text-ink">
              <div className="label !text-ink/60">verified tunnels</div>
              <div className="mt-3 text-5xl font-bold tracking-tighter">
                {peerEdges.filter((e) => e.state === 'connected').length}
                <span className="text-2xl text-ink/50">/{peerEdges.length}</span>
              </div>
            </div>
            <div className="rounded-blob border border-charcoal bg-ink-2 p-5">
              <div className="label mb-4">legend</div>
              <ul className="space-y-3">
                {LEGEND.map(([state, look, meaning, cls]) => (
                  <li key={state}>
                    <div className="flex items-center gap-3">
                      <span className={`w-10 ${cls}`} />
                      <span className="text-sm font-semibold">{state}</span>
                    </div>
                    <div className="ml-[52px] text-[11px] text-mid">{look} — {meaning}</div>
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-charcoal pt-3 text-[11px] text-mid">
                dotted arrows to the control plane are the https heartbeat channel, not the vpn data path. relay paths are not implemented yet.
              </p>
            </div>
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
