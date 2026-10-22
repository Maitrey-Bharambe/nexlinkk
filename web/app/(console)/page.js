'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowUpRight, Check, Cpu, Sparkles, X } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Empty, ErrorState, Loading, Numeral, PageHeader } from '@/components/ui';
import StatusBadge, { StatusMarker } from '@/components/StatusBadge';
import { post } from '@/lib/api';
import { humanize, timeAgo } from '@/lib/format';
import AiBriefing, { AiStatusNote } from '@/features/insights/AiBriefing';

const POLL_MS = 15_000;

/** Overall verdict from counts only — missing evidence is never "healthy". */
function verdict(d) {
  const enrolled = d.registered - d.pending_enrollment - d.revoked;
  if (enrolled <= 0) return { word: 'no evidence', tone: 'text-mid', state: 'unknown', enrolled: 0 };
  if (d.unreachable > 0) return { word: 'needs attention', tone: 'text-coral', state: 'unreachable', enrolled };
  if (d.degraded > 0) return { word: 'degraded', tone: 'text-amber', state: 'degraded', enrolled };
  if (d.healthy === enrolled) return { word: 'healthy', tone: 'text-lime', state: 'healthy', enrolled };
  return { word: 'partly verified', tone: 'text-white', state: 'unknown', enrolled };
}

function sentence(d, v, activeIncidents) {
  if (v.enrolled === 0) return 'no enrolled device has reported yet, so nothing is shown as healthy.';
  const parts = [`${d.healthy} of ${v.enrolled} enrolled devices pass every check`];
  if (d.degraded) parts.push(`${d.degraded} degraded`);
  if (d.unreachable) parts.push(`${d.unreachable} unreachable`);
  if (d.unknown) parts.push(`${d.unknown} without fresh evidence`);
  return `${parts.join(' · ')}. ${activeIncidents ? `${activeIncidents} incident${activeIncidents === 1 ? '' : 's'} active.` : 'no active incidents.'}`;
}

const TAPE = { healthy: 'bg-lime text-ink', degraded: 'bg-amber text-ink', unreachable: 'bg-coral text-ink', unknown: 'bg-charcoal text-white' };

function HealthPanel({ d, v, data }) {
  const segments = [
    ['healthy', d.healthy, 'bg-lime', 'healthy'],
    ['degraded', d.degraded, 'bg-amber', 'degraded'],
    ['unreachable', d.unreachable, 'bg-coral', 'unreachable'],
    ['unknown', d.unknown, 'bg-charcoal hatch', 'no evidence'],
  ];
  const total = Math.max(1, segments.reduce((n, s) => n + s[1], 0));
  return (
    <section className="pixel-corners relative border border-line-strong bg-ink-2 lg:col-span-7">
      {/* State tape: its colour is the verdict, computed from counts only. */}
      <div className={`flex items-center justify-between gap-3 px-5 py-2 ${TAPE[v.state] || TAPE.unknown}`}>
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em]">network health</span>
        <span className="font-pixel text-[10px] uppercase">{v.word}</span>
      </div>
      <div className="p-6 md:p-7">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="font-pixel text-[56px] leading-none sm:text-[76px] md:text-[92px]">
            {/* Lime only when every check passes; otherwise the tape and bar carry the state. */}
            <Numeral value={d.healthy} className={`!font-pixel !tracking-normal ${v.state === 'healthy' ? 'text-lime' : v.enrolled ? 'text-white' : 'text-mid'}`} />
            <span className="text-[28px] text-white/30 sm:text-[36px] md:text-[44px]">/{v.enrolled}</span>
          </div>
          <p className="mb-1 max-w-xs text-sm text-white/70">
            enrolled devices with agent online, interface up and a fresh WireGuard handshake with every peer. no evidence is never counted as healthy.
          </p>
        </div>

        <div className="mt-8" aria-hidden>
          <div className="flex h-3 gap-[2px] border border-line p-[2px]">
            {segments.filter((s) => s[1] > 0).map(([k, n, cls]) => (
              <div key={k} className={`${cls} transition-[flex-grow] duration-500`} style={{ flexGrow: n / total }} />
            ))}
            {total === 1 && segments.every((s) => s[1] === 0) && <div className="hatch flex-1 bg-charcoal" />}
          </div>
        </div>
        <ul className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-x-6 gap-y-2">
          {segments.map(([k, n, , label]) => (
            <li key={k} className="flex items-center gap-2 text-xs text-white/75">
              <StatusMarker state={k} />
              <span className="tabular font-mono text-white">{n}</span> {label}
            </li>
          ))}
        </ul>

        <div className="mt-7 flex flex-wrap gap-x-8 gap-y-2 border-t border-dashed border-line pt-4 font-mono text-[11px] uppercase tracking-wider text-white/55">
          <span><span className="text-white">{data.networks}</span> networks</span>
          <span><span className="text-white">{data.peerLinks.configured}</span> configured peer pairs</span>
          <span><span className="text-white">{d.pending_enrollment}</span> awaiting enrollment</span>
        </div>
      </div>
    </section>
  );
}

/** Metrics sized by importance: one large figure, three compact ones. */
function Metrics({ d, data }) {
  const small = [
    ['networks', data.networks, `${data.peerLinks.configured} peer pairs`, 'text-white'],
    ['degraded', d.degraded, 'outside thresholds', d.degraded ? 'text-amber' : 'text-white/35'],
    ['unreachable', d.unreachable, d.unknown ? `+${d.unknown} without evidence` : 'offline agents', d.unreachable ? 'text-coral' : 'text-white/35'],
  ];
  return (
    <section className="flex flex-col border border-line bg-ink-2 lg:col-span-5">
      <div className="flex flex-1 items-end justify-between gap-4 border-b border-line p-6">
        <div>
          <div className="label">registered devices</div>
          <div className="mt-2 text-xs text-white/60">{d.pending_enrollment} pending · {d.revoked} revoked</div>
        </div>
        <Numeral value={d.registered} className="!font-pixel !tracking-normal text-[52px] leading-none md:text-[64px]" />
      </div>
      <dl className="grid grid-cols-3 divide-x divide-line">
        {small.map(([label, value, sub, tone]) => (
          <div key={label} className="p-4">
            <dt className="label">{label}</dt>
            <dd className={`mt-3 text-[26px] ${tone}`}><Numeral value={value} /></dd>
            <dd className="mt-1 text-[11px] leading-snug text-white/55">{sub}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// Incident titles are "<device>: <what>" by construction; split for display only.
function splitTitle(title) {
  const t = title.replace(/^\[TEST\] /, '');
  const i = t.indexOf(': ');
  return i > 0 ? { device: t.slice(0, i), what: t.slice(i + 2) } : { device: null, what: t };
}

function Incidents({ data, now }) {
  return (
    <section className="border border-line bg-ink-2 lg:col-span-7">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="label">recent incidents</div>
        <Link href="/diagnostics" className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-mid hover:text-lime">
          {data.activeIncidents} active <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      {data.recentIncidents.length === 0 ? (
        <p className="px-5 py-8 text-sm text-mid">no incidents recorded. the detector raises one only when it observes a condition.</p>
      ) : (
        <ol className="divide-y divide-line">
          <li aria-hidden className="hidden grid-cols-[auto_minmax(0,1fr)_120px_64px_auto] gap-x-4 bg-ink px-5 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/55 md:grid">
            <span className="w-2" />
            <span>device — event</span>
            <span>category</span>
            <span className="text-right">time</span>
            <span className="w-[86px] text-right">status</span>
          </li>
          {data.recentIncidents.map((i) => {
            const { device, what } = splitTitle(i.title);
            return (
              <li key={i.id}>
                <Link
                  href={`/diagnostics/${i.id}`}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3.5 transition-colors hover:bg-white/[0.02] md:grid-cols-[auto_minmax(0,1fr)_120px_64px_auto]"
                >
                  <StatusMarker state={i.state} />
                  <div className="min-w-0">
                    <div className="truncate text-sm">
                      {device && <span className="font-medium text-white">{device}</span>}
                      {device && <span className="text-white/30"> — </span>}
                      <span className="text-white/80">{what}</span>
                    </div>
                    <div className="truncate font-mono text-[11px] text-mid md:hidden">
                      {humanize(i.category)} · {timeAgo(i.detectedAt, now)}
                    </div>
                  </div>
                  <span className="hidden truncate font-mono text-[11px] uppercase tracking-wider text-mid md:block">
                    {humanize(i.category)}{i.source === 'test' && ' · test'}
                  </span>
                  <span className="hidden text-right font-mono text-[11px] text-mid md:block">{timeAgo(i.detectedAt, now)}</span>
                  <StatusBadge state={i.state} />
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function ApprovalRow({ a, canDecide, onDone }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  async function decide(kind) {
    setBusy(kind);
    setError(null);
    try {
      await post(`/actions/${a.id}/${kind}`, kind === 'reject' ? { reason: 'rejected by operator' } : {});
      onDone();
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }
  const href = a.incidentId ? `/diagnostics/${a.incidentId}` : `/devices/${a.deviceId}`;
  return (
    <li className="px-5 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={href} className="block truncate font-mono text-[13px] font-medium underline-offset-4 hover:underline">{a.actionType}</Link>
          <div className="mt-0.5 truncate text-xs text-ink/70">
            on <span className="font-medium text-ink">{a.deviceName || a.deviceId}</span> · {a.validation?.valid ? 'policy allows' : 'policy blocks'}
          </div>
        </div>
        {a.risk && <span className="shrink-0 border border-ink/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider">{a.risk} risk</span>}
      </div>
      {canDecide && a.validation?.valid && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => decide('approve')}
            aria-label={`Approve ${a.actionType} on ${a.deviceName || 'device'}`}
            className="inline-flex h-8 items-center gap-1.5 bg-ink px-3 text-xs font-semibold text-lime transition-[transform,box-shadow] hover:-translate-x-px hover:-translate-y-px hover:shadow-[3px_3px_0_0_#fff] disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" aria-hidden /> {busy === 'approve' ? 'approving…' : 'approve & run'}
          </button>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => decide('reject')}
            aria-label={`Reject ${a.actionType}`}
            className="inline-flex h-8 items-center gap-1.5 border border-ink px-3 text-xs font-semibold text-ink hover:bg-ink/10 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" aria-hidden /> {busy === 'reject' ? 'rejecting…' : 'reject'}
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-xs font-medium text-ink" role="alert">⚠ {error.code}: {error.message}</div>}
    </li>
  );
}

/** The approval queue: a lime slab when something waits, quiet when empty. */
function ApprovalQueue({ count, reloadOverview }) {
  const { can } = useAuth();
  const allowed = can('actions:read');
  const { data, reload } = useApi(allowed ? '/approvals?status=awaiting_approval' : null, { events: ['action:update'], pollMs: POLL_MS });
  const items = data || [];
  const done = () => {
    reload();
    reloadOverview();
  };
  const hot = count > 0;
  return (
    <section className={`flex flex-col border lg:col-span-5 ${hot ? 'brut-white border-lime bg-lime text-ink' : 'border-line bg-ink-2'}`}>
      <div className={`flex items-start justify-between gap-3 border-b px-5 py-4 ${hot ? 'border-ink/20' : 'border-line'}`}>
        <div>
          <div className={`font-mono text-[11px] font-medium uppercase tracking-[0.16em] ${hot ? 'text-ink/70' : 'text-mid'}`}>awaiting your approval</div>
          <p className={`mt-1 max-w-[30ch] text-xs ${hot ? 'text-ink/75' : 'text-mid'}`}>nothing runs without a human yes; policy is checked again at approval.</p>
        </div>
        <Numeral value={count} className={`!font-pixel !tracking-normal text-[40px] leading-none ${hot ? 'text-ink' : 'text-white/30'}`} />
      </div>
      {count === 0 ? (
        <p className="px-5 py-6 text-sm text-mid">queue empty.</p>
      ) : !allowed ? (
        <p className="px-5 py-6 text-sm">you can see the count but not the actions.</p>
      ) : (
        <ol className="flex-1 divide-y divide-ink/15">
          {items.slice(0, 3).map((a) => (
            <ApprovalRow key={a.id} a={a} canDecide={can('actions:approve:low')} onDone={done} />
          ))}
        </ol>
      )}
      <Link href="/approvals" className={`flex items-center justify-between border-t px-5 py-3 font-mono text-[11px] uppercase tracking-wider ${hot ? 'border-ink/20 text-ink hover:bg-ink/10' : 'border-line text-mid hover:text-lime'}`}>
        {count > 3 ? `${count - 3} more in the queue` : 'open approvals'} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </section>
  );
}

/** The AI's latest network briefings, on the overview so nobody has to go looking. */
function AiPanel({ now }) {
  const { can } = useAuth();
  const { data, reload } = useApi('/insights', { events: ['insight:update'], pollMs: 60_000 });
  if (!data) return null;
  const withBriefing = data.briefings
    .filter((b) => b.latest || b.lastAttempt)
    .sort((x, y) => new Date(y.latest?.generatedAt || y.lastAttempt?.generatedAt) - new Date(x.latest?.generatedAt || x.lastAttempt?.generatedAt))
    .slice(0, 2);
  return (
    <section className="frame-double border border-line bg-ink-2 lg:col-span-12">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-lime" strokeWidth={1.75} aria-hidden />
          <span className="label">ai briefing</span>
          <span className="hidden font-mono text-[10.5px] uppercase tracking-wider text-white/55 sm:inline">explains · never acts · cites evidence</span>
        </div>
        <Link href="/insights" className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-mid hover:text-lime">
          ai insights <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <div className="px-5 py-5">
        {withBriefing.length === 0 ? (
          <AiStatusNote ai={data.ai} entry={null} />
        ) : (
          <div className={`grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-6 ${withBriefing.length > 1 ? 'lg:grid-cols-2 lg:divide-x lg:divide-line [&>*:nth-child(2)]:lg:pl-8' : ''}`}>
            {withBriefing.map((entry) => (
              <AiBriefing key={entry.networkId} entry={entry} ai={data.ai} canRun={can('incidents:diagnose')} onRefreshed={reload} now={now} compact />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Activity({ items, now }) {
  return (
    <section className="rounded-panel border border-line lg:col-span-12">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div className="label">recent administrative activity</div>
        <Link href="/audit" className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-mid hover:text-lime">
          audit log <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-6 text-sm text-mid">nothing yet.</p>
      ) : (
        <ol className="relative px-5 py-2">
          <span aria-hidden className="absolute bottom-4 left-[29px] top-4 w-px bg-line" />
          {items.map((a) => (
            <li key={a.id} className="relative grid grid-cols-[20px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2 md:grid-cols-[20px_minmax(0,1.2fr)_minmax(0,1fr)_auto]">
              <span aria-hidden className={`relative z-10 mt-1.5 h-2 w-2 justify-self-center rounded-full ring-4 ring-ink ${a.decision === 'deny' ? 'bg-coral' : 'bg-white/40'}`} />
              <span className="truncate font-mono text-[12.5px] text-white">
                {a.operation}
                {a.decision === 'deny' && <span className="ml-2 text-coral">denied</span>}
              </span>
              <span className="hidden truncate text-xs text-mid md:block">
                {a.actor}{a.target?.label ? <> → <span className="text-white/70">{a.target.label}</span></> : null}
              </span>
              <time className="text-right font-mono text-[11px] text-mid" dateTime={a.at}>{timeAgo(a.at, now)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function OverviewPage() {
  const { data, error, loading, reload, fetchedAt } = useApi('/overview', {
    events: ['device:update', 'incident:update', 'network:update', 'action:update'],
    pollMs: POLL_MS,
  });
  const now = useNow();

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorState error={error} onRetry={reload} />;

  const d = data.devices;
  const v = verdict(d);
  const evaluated = data.evaluatedAt || fetchedAt;
  const ageSec = evaluated ? (now - new Date(evaluated).getTime()) / 1000 : Infinity;
  const stale = ageSec > (POLL_MS / 1000) * 3;

  return (
    <div>
      <PageHeader kicker="from agent reports" title={'network\noverview'} description={sentence(d, v, data.activeIncidents)}>
        <div className="flex items-center gap-2 rounded-control border border-line px-3 py-2" role="status">
          <span aria-hidden className={`h-1.5 w-1.5 ${stale ? 'rotate-45 bg-amber' : 'rounded-full bg-lime'}`} />
          <span className={`font-mono text-[11px] uppercase tracking-wider ${stale ? 'text-amber' : 'text-mid'}`}>
            {stale ? 'stale · ' : ''}evaluated {timeAgo(evaluated, now) || '—'}
          </span>
        </div>
      </PageHeader>
      <ErrorState error={error} onRetry={reload} />

      <div className="grid gap-4 lg:grid-cols-12">
        <HealthPanel d={d} v={v} data={data} />
        <Metrics d={d} data={data} />

        {d.registered === 0 && (
          <div className="lg:col-span-12">
            <Empty icon={Cpu} title="no devices enrolled yet">
              nothing to measure, so nothing is shown as healthy. register a pc with the go agent — numbers here come only from its reports.
              <div className="mt-4">
                <Link href="/setup" className="font-semibold text-lime underline underline-offset-4">register this pc →</Link>
              </div>
            </Empty>
          </div>
        )}

        <AiPanel now={now} />
        <Incidents data={data} now={now} />
        <ApprovalQueue count={data.pendingApprovals} reloadOverview={reload} />
        <Activity items={data.recentActions} now={now} />
      </div>
    </div>
  );
}
