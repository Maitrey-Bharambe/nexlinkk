'use client';

import { useEffect, useState } from 'react';
import { Search, ScrollText } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { Empty, ErrorState, Loading, PageHeader, inputCls } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { fmtTime, timeAgo } from '@/lib/format';

export default function AuditPage() {
  const now = useNow();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [decision, setDecision] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ limit: '100' });
  if (debounced) params.set('q', debounced);
  if (decision) params.set('decision', decision);
  const { data, error, loading, reload } = useApi(`/audit-events?${params}`, { events: ['audit:new'] });

  return (
    <div>
      <PageHeader kicker="append-only · written by the backend" title="audit log">
        {['', 'allow', 'deny'].map((d) => (
          <button key={d || 'all'} onClick={() => setDecision(d)} className={`rounded-full px-4 py-2 font-mono text-xs uppercase ${decision === d ? 'bg-white text-ink' : 'border border-charcoal text-mid'}`}>
            {d || 'all'}
          </button>
        ))}
      </PageHeader>
      <div className="relative mb-5 max-w-xl">
        <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-mid" />
        <input className={`${inputCls} pl-11`} placeholder="search operation, actor, target, reason…" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
      </div>
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty icon={ScrollText} title="no matching events" />
      ) : (
        <div className="overflow-x-auto rounded-blob border border-charcoal scrollbar-thin">
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead>
              <tr className="border-b border-charcoal bg-ink-2">
                {['when', 'actor', 'operation', 'target', 'decision', 'outcome', 'reason / context'].map((h) => <th key={h} className="label px-4 py-3 font-normal">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-b border-charcoal/60 align-top last:border-0 hover:bg-ink-2">
                  <td className="px-4 py-3 font-mono text-xs" title={fmtTime(e.at)}>{timeAgo(e.at, now)}</td>
                  <td className="px-4 py-3">
                    <div className="text-sm">{e.actor.label || e.actor.id || '—'}</div>
                    <div className="font-mono text-[10px] uppercase text-mid">{e.actor.type}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-lime">{e.operation}</td>
                  <td className="px-4 py-3 text-xs">
                    {e.target?.type ? <><span className="text-mid">{e.target.type}</span> {e.target.label || e.target.id}</> : '—'}
                  </td>
                  <td className="px-4 py-3"><StatusBadge state={e.decision} /></td>
                  <td className="px-4 py-3"><StatusBadge state={e.outcome === 'pending' ? 'queued' : e.outcome} label={e.outcome} /></td>
                  <td className="max-w-xs px-4 py-3 text-xs text-white/70">
                    {e.reason && <div>{e.reason}</div>}
                    {(e.incidentId || e.actionId) && (
                      <div className="font-mono text-[10px] text-mid">
                        {e.incidentId && `incident ${e.incidentId.slice(-6)} `}
                        {e.actionId && `action ${e.actionId.slice(-6)}`}
                      </div>
                    )}
                    <div className="font-mono text-[10px] text-mid">{e.requestId ? `req ${e.requestId.slice(0, 8)}` : ''}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
