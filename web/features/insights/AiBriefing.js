'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowUpRight, RefreshCw, Sparkles } from 'lucide-react';
import { Button, ErrorState, Running } from '@/components/ui';
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
      className="inline-block max-w-full cursor-help truncate rounded-[2px] border border-line bg-ink px-1.5 py-0.5 font-mono text-[10px] text-white/70 outline-none hover:border-lime/40 hover:text-white focus-visible:border-lime"
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

  const hypotheses = b?.result?.hypotheses || [];
  const findings = b?.result?.observations || [];
  const uncertainties = b?.result?.uncertainties || [];

  return (
    <article aria-label={`AI report${entry?.networkName ? ` for ${entry.networkName}` : ''}`}>
      {/* Report header: what produced this, when, for which network. */}
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-1.5 bg-lime px-2 py-1 text-ink">
            <Sparkles className="h-3 w-3" aria-hidden />
            <span className="t-ident">ai report</span>
          </span>
          {entry?.networkName && <span className="text-[15px] font-semibold">{entry.networkName}</span>}
          {b && (
            <span className="t-data text-[11px] uppercase tracking-wider text-white/60">
              {b.provider} · {timeAgo(b.generatedAt, now)} · {b.trigger === 'schedule' ? 'scheduled' : 'on request'}
            </span>
          )}
        </div>
        {canRun && ai.configured && entry && (
          <Button size="sm" variant="ghost" busy={busy} onClick={refresh} aria-label={`Regenerate the AI briefing for ${entry.networkName || 'this network'}`}>
            {!busy && <RefreshCw className="h-3.5 w-3.5" aria-hidden />} regenerate
          </Button>
        )}
      </header>

      {busy && <div className="mb-4"><Running label="collecting network evidence · asking the AI provider" /></div>}
      <ErrorState error={error} />
      <AiStatusNote ai={ai} entry={entry} />

      {failed && (
        <div className="mb-4 flex items-start gap-2 border border-amber/40 bg-amber/[0.05] px-3 py-2 text-xs text-amber" role="status">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rotate-45 bg-amber" aria-hidden />
          <span>
            latest attempt {failed.status} {timeAgo(failed.generatedAt, now)}: {failed.error}
            {b ? ' — showing the last grounded report.' : ''}
          </span>
        </div>
      )}

      {b?.result && (
        <>
          <ReportSection n="00" title="summary">
            <p className={`${compact ? 'text-[15px]' : 'text-[17px]'} leading-relaxed text-white`}>{b.result.summary}</p>
          </ReportSection>

          <div className={`grid grid-cols-[minmax(0,1fr)] gap-x-8 ${compact ? '' : 'lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]'}`}>
            <ReportSection n="01" title="findings" note="each cites recorded evidence">
              <ol className="divide-y divide-line border-y border-line">
                {findings.slice(0, compact ? 3 : 30).map((o, i) => (
                  <li key={i} className="grid grid-cols-[44px_minmax(0,1fr)] gap-3 py-3">
                    <span className="t-data border-l-2 border-lime pl-2 text-[11px] text-lime">F-{String(i + 1).padStart(2, '0')}</span>
                    <div className="min-w-0">
                      <p className="text-sm leading-relaxed text-white/90">{o.statement}</p>
                      <div className="mt-1.5 flex min-w-0 flex-wrap gap-1">
                        {[...new Set(o.evidence_refs)].slice(0, 6).map((r) => <EvidenceChip key={r} refId={r} evidence={evidence} />)}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              {compact && findings.length > 3 && <div className="t-data mt-2 text-[11px] text-white/60">+{findings.length - 3} more findings</div>}
            </ReportSection>

            {!compact && (
              <div>
                <ReportSection n="02" title="risks & likely causes" note="hypotheses · not facts">
                  {hypotheses.length === 0 ? (
                    <p className="text-sm text-mid">none raised.</p>
                  ) : (
                    <ol className="space-y-2">
                      {hypotheses.map((h, i) => (
                        <li key={i} className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border border-dashed px-3 py-2.5 ${h.status === 'ruled_out' ? 'border-line text-white/50' : 'border-line-strong'}`}>
                          <span className={`text-sm leading-relaxed ${h.status === 'ruled_out' ? 'line-through decoration-white/30' : ''}`}>{h.statement}</span>
                          <HypothesisTag status={h.status} />
                        </li>
                      ))}
                    </ol>
                  )}
                </ReportSection>
                {uncertainties.length > 0 && (
                  <ReportSection n="03" title="uncertainties" note="what the AI could not tell">
                    <ul className="space-y-1.5">
                      {uncertainties.map((u, i) => (
                        <li key={i} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 text-sm text-white/75">
                          <span className="t-data text-amber" aria-hidden>?</span>
                          {u}
                        </li>
                      ))}
                    </ul>
                  </ReportSection>
                )}
              </div>
            )}
          </div>

          <footer className="t-data mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-line pt-3 text-[10.5px] uppercase tracking-wider text-white/55">
            <span>grounded · {b.evidence?.length || 0} evidence records · explains, never acts</span>
            {compact && (
              <Link href={`/insights?networkId=${entry.networkId}`} className="inline-flex items-center gap-1 text-white/70 hover:text-lime">
                full report & analytics <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            )}
          </footer>
        </>
      )}
    </article>
  );
}

/** Numbered report section: pixel number + mono title. */
function ReportSection({ n, title, note, children }) {
  return (
    <section className="mb-6">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="t-ident text-lime">{n}</span>
        <h3 className="label !text-white">{title}</h3>
        {note && <span className="t-data text-[10.5px] uppercase tracking-wider text-white/55">{note}</span>}
      </div>
      {children}
    </section>
  );
}

// Only the statuses the diagnostic schema can produce: plausible, untested, ruled_out.
const HYPOTHESIS = {
  plausible: ['plausible', 'border-amber/60 text-amber'],
  untested: ['untested', 'border-line-strong text-white/70'],
  ruled_out: ['ruled out', 'border-line text-white/50'],
};
function HypothesisTag({ status }) {
  const [text, cls] = HYPOTHESIS[status] || [status, 'border-line text-white/60'];
  return <span className={`t-data shrink-0 border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>{text}</span>;
}
