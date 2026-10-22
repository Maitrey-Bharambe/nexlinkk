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
            <Link
              key={n.id}
              href={`/networks/${n.id}`}
              className="group block border border-line bg-ink-2 transition-[transform,box-shadow,border-color] duration-100 hover:-translate-x-px hover:-translate-y-px hover:border-lime hover:shadow-[4px_4px_0_0_var(--color-lime)]"
            >
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
                <span className="t-ident text-lime">net-{String(idx + 1).padStart(2, '0')}</span>
                <StatusBadge state={n.summary.observedStatus} />
              </div>
              <div className="px-4 pb-4 pt-5">
                <div className="truncate text-xl font-semibold">{n.name}</div>
                <div className="t-data mt-1 text-sm text-lime">{n.cidr}</div>
                <dl className="mt-5 grid grid-cols-3 divide-x divide-line border-t border-line pt-3">
                  {[
                    ['devices', n.summary.devices.total],
                    ['peer pairs', n.summary.links.total],
                    ['hosts', n.usableHosts],
                  ].map(([k, v]) => (
                    <div key={k} className="px-2 first:pl-0">
                      <dt className="label !text-[10px]">{k}</dt>
                      <dd className="t-data mt-1 text-base text-white">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="label mt-3 !text-[10px]">your role · {n.myRole}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
