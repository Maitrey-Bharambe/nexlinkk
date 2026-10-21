'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, ErrorState } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { post } from '@/lib/api';
import { timeAgo } from '@/lib/format';

const HYP_STATE = { plausible: 'connecting', ruled_out: 'closed', untested: 'unknown' };

/**
 * "Analyze with AI": the control plane collects this device's evidence with
 * the read-only tools and asks the diagnostic service (Groq) for a health
 * analysis. Analysis only — the model gets no actions to propose — and every
 * statement must cite evidence that was actually collected.
 */
export default function AiAnalysis({ deviceId, canRun, now }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [out, setOut] = useState(null);

  async function analyze() {
    setBusy(true);
    setError(null);
    try {
      setOut(await post(`/devices/${deviceId}/analysis`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const r = out?.result;
  return (
    <section className="mt-4 rounded-blob border border-lime/40 bg-ink-2 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="label flex items-center gap-2 !text-lime">
            <Sparkles className="h-3.5 w-3.5" /> ai health analysis
          </div>
          <p className="mt-1 max-w-2xl text-xs text-mid">
            evidence from the read-only tools is sent to the AI (Groq). it can only explain — it cannot propose or run actions — and every
            statement must cite evidence that really exists, or the answer is rejected.
          </p>
        </div>
        {canRun && (
          <Button onClick={analyze} busy={busy}>
            <Sparkles className="h-4 w-4" /> {out ? 'analyze again' : 'analyze with AI'}
          </Button>
        )}
      </div>

      <ErrorState error={error} />
      {busy && <p className="mt-4 font-mono text-xs text-mid">collecting evidence and asking the model… (usually 5–15 s)</p>}

      {out && out.status !== 'completed' && (
        <div className="mt-4 rounded-panel border border-coral/40 bg-coral/10 p-4 text-sm text-coral">
          {out.status === 'rejected' ? 'the AI answer was rejected by validation: ' : 'the analysis failed: '}
          <span className="font-mono text-xs">{out.error}</span>
        </div>
      )}

      {r && (
        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-mid">
            <span className="rounded-full bg-lime px-2.5 py-0.5 text-ink">{out.provider}</span>
            <span>{timeAgo(out.analyzedAt, now) || 'just now'}</span>
            <span>· {out.evidence.length} evidence items</span>
          </div>
          <p className="text-lg font-semibold leading-snug text-white">{r.summary}</p>

          {r.observations.length > 0 && (
            <div>
              <div className="label mb-2">observations (measured)</div>
              <ul className="space-y-2">
                {r.observations.map((o, i) => (
                  <li key={i} className="text-sm text-white/85">
                    {o.statement}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {[...new Set(o.evidence_refs)].map((ref) => (
                        <span key={ref} className="break-all rounded bg-charcoal px-1.5 font-mono text-[10px] text-lime">{ref}</span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-5 md:grid-cols-2">
            {r.hypotheses.length > 0 && (
              <div>
                <div className="label mb-2">hypotheses (not facts)</div>
                <ul className="space-y-2">
                  {r.hypotheses.map((h, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-white/80">
                      <StatusBadge state={HYP_STATE[h.status] || 'unknown'} label={h.status.replace('_', ' ')} />
                      <span>{h.statement}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {r.uncertainties.length > 0 && (
              <div>
                <div className="label mb-2">uncertainties</div>
                <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
                  {r.uncertainties.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
