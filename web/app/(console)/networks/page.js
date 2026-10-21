'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Network, Plus } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Card, Empty, ErrorState, Field, Loading, Modal, PageHeader, inputCls } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { post } from '@/lib/api';

function CreateNetwork({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [cidr, setCidr] = useState('10.42.0.0/24');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/networks', { name, cidr });
      onCreated();
      onClose();
      setName('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="new private network">
      <form onSubmit={submit} className="space-y-4">
        <Field label="name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="home-lab" required minLength={2} maxLength={64} />
        </Field>
        <Field label="ipv4 cidr" hint="private space only (10/8, 172.16/12, 192.168/16, 100.64/10), /16–/29, must not overlap another network">
          <input className={`${inputCls} font-mono`} value={cidr} onChange={(e) => setCidr(e.target.value)} required />
        </Field>
        <ErrorState error={error} />
        <p className="text-xs text-mid">this saves a validated configuration. no tunnel exists until agents apply it and report a handshake.</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>cancel</Button>
          <Button type="submit" busy={busy}>create</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function NetworksPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const { data, error, loading, reload } = useApi('/networks', { events: ['network:update', 'device:update'], pollMs: 20_000 });

  return (
    <div>
      <PageHeader kicker="address space & membership" title="networks">
        {can('networks:create') && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> new network
          </Button>
        )}
      </PageHeader>
      <CreateNetwork open={open} onClose={() => setOpen(false)} onCreated={reload} />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length === 0 ? (
        <Empty icon={Network} title="no networks yet">create one to get an address range for your devices.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data?.map((n, idx) => (
            <Link key={n.id} href={`/networks/${n.id}`}>
              <Card tone={idx === 0 ? 'white' : 'default'} className="group h-full transition-transform hover:-translate-y-1">
                <div className="flex items-start justify-between">
                  <div className={`label ${idx === 0 ? '!text-ink/60' : ''}`}>{n.myRole}</div>
                  <StatusBadge state={n.summary.observedStatus} />
                </div>
                <div className="mt-10 text-3xl font-bold lowercase tracking-tight">{n.name}</div>
                <div className={`mt-1 font-mono text-sm ${idx === 0 ? 'text-ink/70' : 'text-lime'}`}>{n.cidr}</div>
                <div className={`mt-6 flex gap-4 font-mono text-xs ${idx === 0 ? 'text-ink/60' : 'text-mid'}`}>
                  <span>{n.summary.devices.total} devices</span>
                  <span>{n.summary.links.total} peer pairs</span>
                  <span>{n.usableHosts} hosts</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
