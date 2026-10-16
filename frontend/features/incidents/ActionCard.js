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
    <div className="rounded-3xl border border-charcoal bg-ink p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-sm text-lime">{action.actionType}</div>
          {showDevice && action.deviceName && <div className="text-xs text-mid">on {action.deviceName}</div>}
          <div className="mt-1 text-sm text-white/80">{action.rationale}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {action.risk && <StatusBadge state={action.risk} label={`${action.risk} risk`} />}
          <StatusBadge state={action.status} />
        </div>
      </div>

      {Object.keys(action.params || {}).length > 0 && (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-ink-2 p-3 font-mono text-[11px] text-white/70 scrollbar-thin">{JSON.stringify(action.params, null, 2)}</pre>
      )}

      <div className="mt-3 flex items-start gap-2 text-xs">
        <ShieldAlert className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${v.valid ? 'text-lime' : 'text-coral'}`} />
        <div>
          <span className="font-semibold">{v.valid ? 'policy: allowed to request approval' : 'policy: rejected'}</span>
          <span className="text-mid"> · proposed by {humanize(action.proposedBy?.type)}</span>
          {!v.valid && (
            <ul className="mt-1 list-disc pl-4 text-coral/90">
              {v.reasons.map((r) => <li key={r}>{r}</li>)}
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
        <div className="mt-3 rounded-2xl border border-charcoal p-3">
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
            <Button busy={busy === 'approve'} disabled={Boolean(busy)} onClick={() => decide('approve')}><Check className="h-4 w-4" /> approve & run</Button>
            <Button variant="ghost" busy={busy === 'reject'} disabled={Boolean(busy)} onClick={() => decide('reject')}><X className="h-4 w-4" /> reject</Button>
          </div>
          <ErrorState error={error} />
        </div>
      )}
    </div>
  );
}
