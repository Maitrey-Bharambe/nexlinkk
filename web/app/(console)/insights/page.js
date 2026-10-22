'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Card, Empty, ErrorState, Loading, Numeral, PageHeader } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import AiBriefing, { AiStatusNote } from '@/features/insights/AiBriefing';
import { BarChart, LineBandChart, ShareBars, fmtDay } from '@/features/insights/charts';
import { timeAgo } from '@/lib/format';

const val = (v, unit) => (v == null ? <span className="text-mid">—</span> : <>{v}<span className="text-mid"> {unit}</span></>);

function Kpi({ label, value, unit, sub, tone }) {
  return (
    <div className="bg-ink-2 p-5">
      <div className="label">{label}</div>
      <div className={`mt-4 text-[26px] md:text-[30px] ${tone || ''}`}>
        {value == null ? <span className="numeral text-white/30">—</span> : <Numeral value={value} />}
        {value != null && unit && <span className="t-data ml-1.5 text-sm text-white/60">{unit}</span>}
      </div>
      {sub && <div className="mt-2 text-xs text-mid">{sub}</div>}
    </div>
  );
}

function Insights() {
  const params = useSearchParams();
  const router = useRouter();
  const networkId = params.get('networkId');
  const now = useNow();
  const { can } = useAuth();
  const { data, error, loading, reload, fetchedAt } = useApi(`/insights${networkId ? `?networkId=${networkId}` : ''}`, {
    events: ['insight:update', 'device:update', 'incident:update'],
    pollMs: 30_000,
  });

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const a = data.analytics;
  const briefings = data.briefings;
  const withEvidence = briefings.filter((b) => b.latest || b.lastAttempt);
  const shown = networkId ? briefings : withEvidence.length ? withEvidence : briefings.slice(0, 1);

  return (
    <div>
      <PageHeader
        kicker={`analytics from agent records · ai explains, never acts · refreshed ${timeAgo(fetchedAt, now) || '—'}`}
        title={'ai\ninsights'}
        description="the AI reads the same evidence shown below and writes a briefing per network. every finding cites a recorded fact; anything it cites that does not exist is rejected before it reaches this page."
      >
        {data.networks.length > 1 && (
          <label className="flex h-9 items-center gap-2 rounded-control border border-line px-3 font-mono text-[11px] uppercase tracking-wider text-mid">
            network
            <select
              className="bg-transparent normal-case tracking-normal text-white outline-none"
              value={networkId || ''}
              onChange={(e) => router.replace(e.target.value ? `/insights?networkId=${e.target.value}` : '/insights')}
            >
              <option value="" className="bg-ink">all ({data.networks.length})</option>
              {data.networks.map((n) => <option key={n.id} value={n.id} className="bg-ink">{n.name} · {n.cidr}</option>)}
            </select>
          </label>
        )}
      </PageHeader>
      <ErrorState error={error} onRetry={reload} />

      {a.devices.enrolled === 0 ? (
        <Empty icon={Sparkles} title="nothing to analyse yet">insights appear once a device is enrolled and reporting. <Link href="/setup" className="text-lime underline underline-offset-4">register a pc →</Link></Empty>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {/* AI briefings */}
          <section className="frame-double border border-line-strong bg-ink-2 p-5 md:p-6">
            {shown.length === 0 ? (
              <AiStatusNote ai={data.ai} entry={null} />
            ) : (
              <div className="divide-y divide-line">
                {shown.map((entry) => (
                  <div key={entry.networkId} className="py-5 first:pt-0 last:pb-0">
                    <AiBriefing entry={entry} ai={data.ai} canRun={can('incidents:diagnose')} onRefreshed={reload} now={now} />
                  </div>
                ))}
              </div>
            )}
            {!networkId && briefings.length > shown.length && (
              <p className="mt-5 border-t border-line pt-4 font-mono text-[11px] uppercase tracking-wider text-mid">
                {briefings.length - shown.length} more network{briefings.length - shown.length === 1 ? '' : 's'} without a briefing yet — pick one above.
              </p>
            )}
          </section>

          {/* KPIs */}
          <section className="grid grid-cols-2 gap-px overflow-hidden border border-line-strong bg-line lg:grid-cols-4" aria-label="Key figures">
            <Kpi label="health score" value={a.devices.healthScore} unit="%" sub={`${a.devices.byStatus.healthy || 0} of ${a.devices.enrolled} enrolled pass every check`} tone={a.devices.healthScore === 100 ? 'text-lime' : ''} />
            <Kpi label="verified tunnels" value={a.tunnels.connected} unit={`/ ${a.tunnels.total}`} sub={`${a.tunnels.direct} direct · ${a.tunnels.relay} via relay`} />
            <Kpi label="tunnel rtt p95 · 24h" value={a.latency.rttP95} unit="ms" sub={a.latency.samples ? `${a.latency.samples} samples · median ${a.latency.rttP50} ms` : 'no tunnel probes recorded'} />
            <Kpi
              label="mean time to resolve · 7d"
              value={a.incidents.mttrMinutes}
              unit="min"
              sub={`${a.incidents.total} incidents · ${a.incidents.active} active`}
            />
          </section>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card label="last 24 h" title="tunnel latency">
              <LineBandChart series={a.latency.series} lineKey="rttAvg" bandKey="rttP95" unit="ms" label="Tunnel round-trip time per hour" />
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10.5px] uppercase tracking-wider text-mid">
                <span className="flex items-center gap-2"><span className="h-0.5 w-5 rounded bg-lime" aria-hidden /> hourly average</span>
                <span className="flex items-center gap-2"><span className="h-2.5 w-5 rounded-[1px] bg-lime/15" aria-hidden /> up to p95</span>
                <span>gaps = hours without measurements</span>
              </div>
            </Card>
            <Card label="last 24 h" title="packet loss">
              <LineBandChart series={a.latency.series} lineKey="lossAvg" unit="%" height={180} label="Tunnel packet loss per hour" />
              <p className="mt-3 text-xs text-mid">
                average {a.latency.lossAvg == null ? 'not measured' : `${a.latency.lossAvg}%`} across tunnel probes.
              </p>
            </Card>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card label="last 7 days" title="incidents opened">
              <BarChart items={a.incidents.perDay} valueKey="opened" unit="opened" labelOf={(d, long) => (long ? new Date(d.day).toLocaleDateString() : fmtDay(d.day))} label="Incidents opened per day" />
              <p className="mt-3 text-xs text-mid">test events are excluded. {a.incidents.perDay.reduce((n, d) => n + d.resolved, 0)} verified resolutions in the same window.</p>
            </Card>
            <Card label="last 7 days" title="by category">
              <ShareBars entries={Object.entries(a.incidents.byCategory)} unit="incidents" />
            </Card>
          </div>

          <section className="overflow-hidden border border-line">
            <div className="border-b border-line bg-ink-2 px-5 py-4"><div className="label">last 24 h</div><h2 className="t-section mt-1.5">per-device tunnel quality</h2></div>
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line">
                    {['device', 'status', 'rtt avg', 'rtt p95', 'loss', 'jitter', 'samples', 'last probe'].map((h) => (
                      <th key={h} scope="col" className={`label px-5 py-3 font-normal ${['device', 'status'].includes(h) ? '' : 'text-right'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {a.deviceRows.map((d) => (
                    <tr key={d.id} className="border-b border-line/60 last:border-0 hover:bg-white/[0.02]">
                      <td className="px-5 py-3"><Link href={`/devices/${d.id}`} className="font-medium hover:text-lime">{d.name}</Link></td>
                      <td className="px-5 py-3"><StatusBadge state={d.status} /></td>
                      <td className="tabular px-5 py-3 text-right font-mono text-xs">{val(d.rttAvg, 'ms')}</td>
                      <td className="tabular px-5 py-3 text-right font-mono text-xs">{val(d.rttP95, 'ms')}</td>
                      <td className="tabular px-5 py-3 text-right font-mono text-xs">{val(d.lossAvg, '%')}</td>
                      <td className="tabular px-5 py-3 text-right font-mono text-xs">{val(d.jitterAvg, 'ms')}</td>
                      <td className="tabular px-5 py-3 text-right font-mono text-xs">{d.samples || <span className="text-mid">0</span>}</td>
                      <td className="px-5 py-3 text-right font-mono text-[11px] text-mid">{d.lastMeasuredAt ? timeAgo(d.lastMeasuredAt, now) : 'never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default function InsightsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Insights />
    </Suspense>
  );
}
