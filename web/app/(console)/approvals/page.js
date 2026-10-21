'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CheckSquare } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Empty, ErrorState, Loading, PageHeader } from '@/components/ui';
import ActionCard from '@/features/incidents/ActionCard';

const TABS = [
  ['awaiting_approval', 'queue'],
  ['queued', 'running'],
  ['completed', 'done'],
  ['rejected_by_policy', 'blocked by policy'],
  ['rejected', 'rejected'],
];

export default function ApprovalsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('awaiting_approval');
  const { data, error, loading, reload } = useApi(`/approvals?status=${tab}`, { events: ['action:update', 'incident:update'], pollMs: 10_000 });

  return (
    <div>
      <PageHeader kicker="human in the loop · policy re-checked at approval" title="approvals">
        {TABS.map(([v, label]) => (
          <button key={v} onClick={() => setTab(v)} className={`rounded-full px-4 py-2 font-mono text-xs uppercase ${tab === v ? 'bg-lime text-ink' : 'border border-charcoal text-mid hover:text-white'}`}>
            {label}
          </button>
        ))}
      </PageHeader>
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <Empty icon={CheckSquare} title="nothing here">
          {tab === 'awaiting_approval' ? 'no actions are waiting. diagnostics propose them; nothing runs without a decision here.' : 'no actions in this state.'}
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((a) => (
            <div key={a.id}>
              {a.incidentId ? (
                <Link href={`/diagnostics/${a.incidentId}`} className="label mb-1.5 block hover:text-lime">incident {a.incidentId} →</Link>
              ) : (
                <Link href={`/devices/${a.deviceId}`} className="label mb-1.5 block hover:text-lime">requested from device page · {a.deviceName || a.deviceId} →</Link>
              )}
              <ActionCard action={a} showDevice canDecide={can('actions:approve:low')} onChange={reload} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
