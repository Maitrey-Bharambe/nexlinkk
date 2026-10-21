'use client';

import { useMemo, useState } from 'react';
import { Cpu, Plus } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Empty, ErrorState, Loading, PageHeader, Segmented } from '@/components/ui';
import EnrollDialog from '@/features/devices/EnrollDialog';
import DeviceTable from '@/features/devices/DeviceTable';

const FILTERS = ['all', 'healthy', 'degraded', 'unreachable', 'unknown', 'pending_enrollment', 'revoked'];

export default function DevicesPage() {
  const { can } = useAuth();
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(false);
  const { data, error, loading, reload } = useApi('/devices', { events: ['device:update'], pollMs: 15_000 });
  const { data: networks } = useApi('/networks');

  const names = useMemo(() => Object.fromEntries((networks || []).map((n) => [n.id, n.name])), [networks]);
  const rows = (data || []).filter((d) => filter === 'all' || d.health?.status === filter);

  return (
    <div>
      <PageHeader kicker="identity · enrollment · connectivity" title="devices">
        {can('devices:enroll') && (
          <Button onClick={() => setOpen(true)} disabled={!networks?.length}>
            <Plus className="h-4 w-4" /> enroll device
          </Button>
        )}
      </PageHeader>
      <EnrollDialog open={open} onClose={() => setOpen(false)} networks={networks} onCreated={reload} />

      <div className="mb-5 overflow-x-auto scrollbar-thin">
        <Segmented
          label="Filter devices by health"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => [f, `${f.replace('_', ' ')}${data && f !== 'all' ? ` · ${data.filter((d) => d.health?.status === f).length}` : ''}`])}
        />
      </div>

      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length === 0 ? (
        <Empty icon={Cpu} title="no devices yet">
          {networks?.length ? 'issue an enrollment token to add your first machine.' : 'create a network first — devices need an address range.'}
        </Empty>
      ) : rows.length === 0 ? (
        <p className="py-8 text-sm text-mid">no devices match “{filter.replace('_', ' ')}”.</p>
      ) : (
        <DeviceTable devices={rows} networkNames={names} />
      )}
    </div>
  );
}
