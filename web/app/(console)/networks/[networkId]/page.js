'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cpu, Plus, Share2, Trash2 } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Card, Empty, ErrorState, KV, Loading, Modal, PageHeader, SectionHeading } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import EnrollDialog from '@/features/devices/EnrollDialog';
import DeviceTable from '@/features/devices/DeviceTable';
import { del } from '@/lib/api';
import { fmtTime } from '@/lib/format';

export default function NetworkDetail({ params }) {
  const { networkId } = use(params);
  const router = useRouter();
  const { can } = useAuth();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: n, error, loading, reload } = useApi(`/networks/${networkId}`, { events: ['device:update', 'network:update'], pollMs: 15_000 });

  if (loading && !n) return <Loading />;
  if (!n) return <ErrorState error={error} onRetry={reload} />;

  const writable = n.myRole !== 'viewer';

  async function remove() {
    setBusy(true);
    setDeleteError(null);
    try {
      await del(`/networks/${networkId}`);
      router.replace('/networks');
    } catch (err) {
      setDeleteError(err);
    } finally {
      setBusy(false);
    }
  }

  const s = n.summary;
  return (
    <div>
      <PageHeader kicker={`network · ${n.cidr}`} plain title={n.name}>
        <Link href={`/topology?networkId=${n.id}`}>
          <Button variant="ghost"><Share2 className="h-4 w-4" /> topology</Button>
        </Link>
        {writable && can('devices:enroll') && (
          <Button onClick={() => setEnrollOpen(true)}><Plus className="h-4 w-4" /> enroll device</Button>
        )}
        {writable && can('networks:delete') && (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" /></Button>
        )}
      </PageHeader>
      <EnrollDialog open={enrollOpen} onClose={() => setEnrollOpen(false)} defaultNetworkId={n.id} onCreated={reload} />
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="delete network?">
        <p className="mb-4 text-sm text-white/80">
          deletion is refused while devices are active or pending. revoke or remove them first. the address range is released after deletion.
        </p>
        <ErrorState error={deleteError} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>keep it</Button>
          <Button variant="danger" busy={busy} onClick={remove}>request deletion</Button>
        </div>
      </Modal>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card tone="lime" label="observed status">
          <div className="t-title !text-[22px]">{s.observedStatus.replace(/_/g, ' ')}</div>
          <p className="mt-3 text-sm text-ink/70">
            {s.observedStatus === 'configured'
              ? 'config saved — no peer handshake observed yet.'
              : `${s.links.connected || 0}/${s.links.total} peer pairs verified by fresh handshake.`}
          </p>
        </Card>
        <Card label="address range">
          <KV k="cidr" mono>{n.cidr}</KV>
          <KV k="range" mono>{n.firstAddress} – {n.lastAddress}</KV>
          <KV k="assignable hosts" mono>{n.usableHosts}</KV>
          <KV k="reserved" mono>{n.reservedAddresses.join(', ')}</KV>
        </Card>
        <Card label="config">
          <KV k="config version" mono>v{n.configVersion}</KV>
          <KV k="your role">{n.myRole}</KV>
          <KV k="created">{fmtTime(n.createdAt)}</KV>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {['healthy', 'degraded', 'unreachable', 'unknown', 'pending_enrollment'].map((k) =>
              s.devices[k] ? <StatusBadge key={k} state={k} label={`${s.devices[k]} ${k.replace('_', ' ')}`} /> : null,
            )}
          </div>
        </Card>
      </div>

      <SectionHeading className="mt-10">devices in this network</SectionHeading>
      {n.devices.length === 0 ? (
        <Empty icon={Cpu} title="no devices in this network">issue an enrollment token, then run the agent on the machine you want to join.</Empty>
      ) : (
        <DeviceTable devices={n.devices} networkNames={{ [n.id]: n.name }} />
      )}
    </div>
  );
}
