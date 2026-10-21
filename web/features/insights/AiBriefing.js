'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowUpRight, RefreshCw, Sparkles } from 'lucide-react';
import { Button, ErrorState, Running } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { post } from '@/lib/api';
import { timeAgo } from '@/lib/format';

const KIND_LABEL = { network_summary: 'network', device_health: 'device', tunnel_metrics: 'metrics', peer_link: 'tunnel', incident_stats: 'incidents', incident: 'incident' };

/** A cited evidence item: short label, full recorded text on hover/focus. */
function EvidenceChip({ refId, evidence }) {
  const e = evidence.get(refId);
  const head = e ? `${KIND_LABEL[e.kind] || e.kind} · ${e.summary.split(/[:—(]/)[0].replace(/^Network |^Tunnel /, '').slice(0, 28).trim()}` : refId.slice(0, 24);
  return (
    <span
      tabIndex={0}
      title={e ? e.summary : refId}
      className="inline-block max-w-full cursor-help truncate rounded-[4px] border border-line bg-ink px-1.5 py-0.5 font-mono text-[10px] text-white/70 outline-none hover:border-lime/40 hover:text-white focus-visible:border-lime"
    >
      {head}
    </span>
  );
}

export function AiStatusNote({ ai, entry }) {
  if (!ai.configured) {
    return (
      <p className="text-sm text-mid">
        AI analysis is off: no diagnostic service is configured. In development it starts on its own when{' '}
        <span className="font-mono text-white/80">diagnostic-service/.venv</span> exists; otherwise set{' '}
        <span className="font-mono text-white/80">DIAGNOSTIC_SERVICE_URL</span>. The analytics on this page do not need it.
      </p>
    );
  }
  if (!entry?.latest && !entry?.lastAttempt) {
    return (
      <p className="text-sm text-mid">
        no briefing yet. {ai.scheduleMinutes ? `the AI reviews each network every ${ai.scheduleMinutes} min when its state changes.` : 'generate one now.'}
      </p>
    );
  }
  return null;
}

/**
 * One network's AI briefing. AI output is labelled as such, every finding shows
 * the recorded evidence it cites, and a failed or rejected run is reported
 * instead of being hidden behind an older result.
 */
export default function AiBriefing({ entry, ai, canRun, onRefreshed, now, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const b = entry?.latest;
  const evidence = new Map((b?.evidence || []).map((e) => [e.ref, e]));
  const failed = entry?.lastAttempt;

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await post('/insights/briefings', { networkId: entry.networkId });
      onRefreshed?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const risks = (b?.result?.hypotheses || []).filter((h) => h.status !== 'ruled_out');
  const findings = b?.result?.observations || [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-line-strong bg-white/[0.04] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-white">
            <Sparkles className="h-3 w-3 text-lime" aria-hidden /> ai analysis
          </span>
          {entry?.networkName && <span className="text-sm font-medium">{entry.networkName}</span>}
          {b && (
            <span className="font-mono text-[10.5px] uppercase tracking-wider text-mid">
              {b.provider} · {timeAgo(b.generatedAt, now)} · {b.trigger === 'schedule' ? 'scheduled' : 'on request'}
            </span>
          )}
        </div>
        {canRun && ai.configured && entry && (
          <Button size="sm" variant="ghost" busy={busy} onClick={refresh} aria-label={`Regenerate the AI briefing for ${entry.networkName || 'this network'}`}>
            {!busy && <RefreshCw className="h-3.5 w-3.5" aria-hidden />} regenerate
          </Button>
        )}
      </div>

      {busy && <div className="mb-4"><Running label="collecting network evidence · asking the diagnostic service" /></div>}
      <ErrorState error={error} />
      <AiStatusNote ai={ai} entry={entry} />

      {failed && (
        <div className="mb-4 flex items-start gap-2 rounded-control border border-amber/30 bg-amber/[0.05] px-3 py-2 text-xs text-amber">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rotate-45 bg-amber" aria-hidden />
          <span>
            latest attempt {failed.status} {timeAgo(failed.generatedAt, now)}: {failed.error}
            {b ? ' — showing the last grounded briefing.' : ''}
          </span>
        </div>
      )}

      {b?.result && (
        <>
          <p className={`${compact ? 'text-base' : 'text-[19px]'} font-medium leading-snug text-white`}>{b.result.summary}</p>

          <div className={`mt-6 grid gap-6 ${compact ? '' : 'lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]'}`}>
            <div>
              <div className="label mb-2">findings · each cites recorded evidence</div>
              <ul className="space-y-3">
                {findings.slice(0, compact ? 3 : 30).map((o, i) => (
                  <li key={i} className="border-l-2 border-lime/70 pl-3 text-sm text-white/90">
                    {o.statement}
                    <div className="mt-1.5 flex min-w-0 flex-wrap gap-1">
                      {[...new Set(o.evidence_refs)].slice(0, 6).map((r) => <EvidenceChip key={r} refId={r} evidence={evidence} />)}
                    </div>
                  </li>
                ))}
              </ul>
              {compact && findings.length > 3 && <div className="mt-2 font-mono text-[11px] text-mid">+{findings.length - 3} more findings</div>}
            </div>
            {!compact && (
              <div className="space-y-6">
                <div>
                  <div className="label mb-2">risks & likely causes · not facts</div>
                  {risks.length === 0 ? (
                    <p className="text-sm text-mid">none raised.</p>
                  ) : (
                    <ul className="space-y-2">
                      {risks.map((h, i) => (
                        <li key={i} className="flex items-start justify-between gap-3 rounded-control border border-dashed border-line-strong px-3 py-2.5 text-sm">
                          <span>{h.statement}</span>
                          <StatusBadge state={h.status === 'plausible' ? 'pending' : 'unknown'} label={h.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {b.result.uncertainties.length > 0 && (
                  <div>
                    <div className="label mb-2">what the AI could not tell</div>
                    <ul className="space-y-1 text-sm text-white/70">
                      {b.result.uncertainties.map((u, i) => <li key={i} className="flex gap-2"><span className="font-mono text-amber" aria-hidden>?</span>{u}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
          {compact && (
            <Link href={`/insights?networkId=${entry.networkId}`} className="mt-4 inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-mid hover:text-lime">
              risks, uncertainties & analytics <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
        </>
      )}
    </div>
  );
}
