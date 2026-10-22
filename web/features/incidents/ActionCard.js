'use client';

import { useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import { Button, ErrorState, inputCls } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { post } from '@/lib/api';
import { fmtTime, humanize } from '@/lib/format';

/** A proposed action with its policy verdict, approval controls and verification outcome. */
export default function ActionCard({ action, canDecide, onChange, showDevice }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function decide(kind) {
    setBusy(kind);
    setError(null);
    try {
      await post(`/actions/${action.id}/${kind}`, kind === 'reject' ? { reason: reason || 'rejected by operator' } : reason ? { reason } : {});
      onChange?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const v = action.validation;
  return (
    <div className={`rounded-panel border bg-ink-2 ${action.status === 'awaiting_approval' ? 'border-lime/50 border-l-4 border-l-lime' : 'border-line'}`}>
      {/* Request record: what will run, where, and under which risk. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-2.5">
        <span className="t-ident text-white/60">requested action</span>
        <div className="flex flex-wrap gap-1.5">
          {action.risk && <StatusBadge state={action.risk} label={`${action.risk} risk`} />}
          <StatusBadge state={action.status} />
        </div>
      </div>
      <div className="p-5 pt-4">
      <div className="t-data break-all text-[15px] text-lime">{action.actionType}</div>
      {showDevice && action.deviceName && (
        <div className="mt-1.5 text-xs text-mid">
          target device <span className="t-data text-white">{action.deviceName}</span>
        </div>
      )}
      <p className="mt-2 text-sm leading-relaxed text-white/80">{action.rationale}</p>

      {Object.keys(action.params || {}).length > 0 && (
        <pre className="mt-3 overflow-x-auto rounded-control border border-line bg-ink p-3 font-mono text-[11px] text-white/70 scrollbar-thin">{JSON.stringify(action.params, null, 2)}</pre>
      )}

      <div className="mt-3 flex items-start gap-2 text-xs">
        <ShieldAlert className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${v.valid ? 'text-lime' : 'text-coral'}`} />
        <div>
          <span className="font-semibold">{v.valid ? 'policy: allowed to request approval' : 'policy: rejected'}</span>
          <span className="text-mid"> · proposed by {humanize(action.proposedBy?.type)}</span>
          {!v.valid && (
            <ul className="mt-1 list-disc pl-4 text-coral/90">
              {[...new Set(v.reasons)].map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
        </div>
      </div>

      {action.approval && (
        <div className="mt-2 text-xs text-mid">
          {action.approval.decision} by {action.approval.approverName || action.approval.approverId} · {fmtTime(action.approval.decidedAt)}
          {action.approval.reason ? ` — “${action.approval.reason}”` : ''}
        </div>
      )}

      {action.verification?.outcome && (
        <div className="mt-3 rounded-control border border-line bg-ink p-3">
          <div className="flex items-center justify-between">
            <span className="label">verified outcome</span>
            <StatusBadge state={action.verification.outcome} />
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-white/70">
            {action.verification.notes.map((n, i) => <li key={i}>· {n}</li>)}
          </ul>
        </div>
      )}

      {action.status === 'awaiting_approval' && canDecide && (
        <div className="mt-4 space-y-2">
          <input className={`${inputCls} py-2`} placeholder="note for the audit log (optional for approve)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <div className="flex gap-2">
            <Button busy={busy === 'approve'} disabled={Boolean(busy)} onClick={() => decide('approve')}><Check className="h-4 w-4" aria-hidden /> approve & run</Button>
            <Button variant="ghost" busy={busy === 'reject'} disabled={Boolean(busy)} onClick={() => decide('reject')}><X className="h-4 w-4" aria-hidden /> reject</Button>
          </div>
          <ErrorState error={error} />
        </div>
      )}
      </div>
    </div>
  );
}
