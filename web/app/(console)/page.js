'use client';

import Link from 'next/link';
import { ArrowUpRight, Cpu, ShieldCheck } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { Card, Empty, ErrorState, Loading, PageHeader, Stat } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { humanize, timeAgo } from '@/lib/format';

export default function OverviewPage() {
  const { data, error, loading, reload, fetchedAt } = useApi('/overview', {
    events: ['device:update', 'incident:update', 'network:update', 'action:update'],
    pollMs: 15_000,
  });
  const now = useNow();

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const d = data.devices;
  const noDevices = d.registered === 0;

  return (
    <div>
      <PageHeader kicker={`evaluated ${timeAgo(fetchedAt, now) || 'now'} · from agent reports`} title="overview" />
      <ErrorState error={error} onRetry={reload} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat tone="lime" label="healthy" value={d.healthy} sub="agent online · interface up · peers handshaking" className="col-span-2 lg:col-span-1 lg:row-span-2" />
        <Stat label="registered devices" value={d.registered} sub={`${d.pending_enrollment} pending enrollment · ${d.revoked} revoked`} />
        <Stat tone="white" label="networks" value={data.networks} sub={`${data.peerLinks.configured} configured peer pairs`} />
        <Stat label="degraded" value={d.degraded} sub="partially working — see reasons" />
        <Stat label="unreachable / unknown" value={`${d.unreachable}/${d.unknown}`} sub="offline agents / no evidence yet" />
      </div>

      {noDevices && (
        <div className="mt-6">
          <Empty icon={Cpu} title="no devices enrolled yet">
            nothing to measure, so nothing is shown as healthy. register a pc with the go agent — stats here come only from its reports.
            <div className="mt-4">
              <Link href="/setup" className="font-semibold text-lime underline">register this pc →</Link>
            </div>
          </Empty>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card
          label="recent incidents"
          action={
            <Link href="/diagnostics" className="flex items-center gap-1 text-xs text-mid hover:text-lime">
              {data.activeIncidents} active <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          }
        >
          {data.recentIncidents.length === 0 ? (
            <p className="py-6 text-sm text-mid">no incidents recorded. the detector only raises one when it observes a condition.</p>
          ) : (
            <ul className="divide-y divide-charcoal">
              {data.recentIncidents.map((i) => (
                <li key={i.id}>
                  <Link href={`/diagnostics/${i.id}`} className="flex items-center justify-between gap-3 py-3 hover:text-lime">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{i.title}</div>
                      <div className="font-mono text-[11px] uppercase text-mid">
                        {humanize(i.category)} · {timeAgo(i.detectedAt, now)} {i.source === 'test' && '· test event'}
                      </div>
                    </div>
                    <StatusBadge state={i.state} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="grid gap-4">
          <Card tone="charcoal" label="awaiting your approval">
            <div className="flex items-end justify-between">
              <div className="text-6xl font-bold tracking-tighter">{data.pendingApprovals}</div>
              <Link href="/approvals" className="rounded-full bg-lime px-4 py-2 text-sm font-semibold text-ink hover:bg-white">
                review
              </Link>
            </div>
            <p className="mt-3 text-xs text-white/60">every action needs a human yes. the policy engine checks it again at approval time.</p>
          </Card>
          <Card label="recent admin actions">
            {data.recentActions.length === 0 ? (
              <p className="text-sm text-mid">nothing yet.</p>
            ) : (
              <ul className="space-y-2.5">
                {data.recentActions.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <ShieldCheck className={`h-3.5 w-3.5 shrink-0 ${a.decision === 'deny' ? 'text-coral' : 'text-lime'}`} />
                      <span className="truncate">
                        <span className="font-mono text-xs text-lime">{a.operation}</span>{' '}
                        <span className="text-mid">by {a.actor}</span>
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-mid">{timeAgo(a.at, now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
