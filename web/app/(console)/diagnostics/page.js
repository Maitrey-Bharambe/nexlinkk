'use client';

import Link from 'next/link';
import { useState } from 'react';
import { FlaskConical, Stethoscope } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Card, Empty, ErrorState, Field, Loading, Modal, PageHeader, Segmented, inputCls } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { post } from '@/lib/api';
import { humanize, timeAgo } from '@/lib/format';

const CATEGORIES = ['agent_offline', 'vpn_interface_down', 'peer_handshake_stale', 'packet_loss_high', 'latency_high'];

function TestIncidentDialog({ open, onClose, onCreated }) {
  const { data: devices } = useApi(open ? '/devices' : null);
  const [form, setForm] = useState({ deviceId: '', category: 'vpn_interface_down', note: '', peerDeviceId: '' });
  const enrolled = devices?.filter((d) => d.enrollmentState === 'enrolled') || [];
  const selected = enrolled.find((d) => d.id === form.deviceId);
  // Peer drills need the other end of the link: same network, not the device itself.
  const peers = selected ? enrolled.filter((d) => d.networkId === selected.networkId && d.id !== selected.id) : [];
  const needsPeer = form.category === 'peer_handshake_stale';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { peerDeviceId, ...rest } = form;
      await post('/incidents/test', needsPeer && peerDeviceId ? { ...rest, peerDeviceId } : rest);
      onCreated();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="test incident">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-mid">creates an incident labelled <b className="text-white">[TEST]</b> to exercise diagnostics and approvals. it is never auto-resolved and never presented as a real observation.</p>
        <Field label="device">
          <select className={inputCls} required value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value, peerDeviceId: '' })}>
            <option value="">choose…</option>
            {enrolled.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="category">
          <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
          </select>
        </Field>
        {needsPeer && (
          <Field label="peer device" hint="the other end of the tunnel; lets diagnostics propose a connectivity test through it">
            <select className={inputCls} value={form.peerDeviceId} onChange={(e) => setForm({ ...form, peerDeviceId: e.target.value })} disabled={!selected}>
              <option value="">{selected ? 'choose…' : 'pick a device first'}</option>
              {peers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="note">
          <input className={inputCls} required minLength={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="drill: approval flow" />
        </Field>
        <ErrorState error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>cancel</Button>
          <Button type="submit" busy={busy}>create test event</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function DiagnosticsPage() {
  const { can } = useAuth();
  const now = useNow();
  const [scope, setScope] = useState('active');
  const [testOpen, setTestOpen] = useState(false);
  const { data, error, loading, reload } = useApi(`/incidents${scope === 'active' ? '?state=active' : ''}`, { events: ['incident:update', 'action:update'], pollMs: 20_000 });
  const { data: registry } = useApi('/diagnostics/registry');

  return (
    <div>
      <PageHeader kicker="detect · gather evidence · propose · verify" title="diagnostics">
        <Segmented label="Incident scope" value={scope} onChange={setScope} options={[['active', 'active'], ['all', 'all']]} />
        {can('incidents:create_test') && (
          <Button variant="ghost" onClick={() => setTestOpen(true)}><FlaskConical className="h-4 w-4" /> test event</Button>
        )}
      </PageHeader>
      <TestIncidentDialog open={testOpen} onClose={() => setTestOpen(false)} onCreated={reload} />

      {registry && (
        <div className="mb-6 grid gap-4 md:grid-cols-3">
          <Card tone="lime" label="diagnostic engine">
            <div className="t-data text-lg text-white">deterministic_rules_v1</div>
            <p className="mt-2 text-sm text-ink/70">
              {registry.llmProviderConfigured
                ? 'ai diagnostics available via the diagnostic service ("ask ai" on an incident). its output is schema-checked, must cite real evidence, and every action still needs policy + human approval.'
                : 'no llm provider connected. nothing here is ai-generated.'}
            </p>
          </Card>
          <Card label={`read-only tools · ${registry.tools.length}`}>
            <div className="flex flex-wrap gap-1.5">
              {registry.tools.map((t) => <span key={t.name} title={t.description} className="rounded-[2px] border border-line bg-ink-3 px-2 py-1 font-mono text-[11px]">{t.name}</span>)}
            </div>
          </Card>
          <Card label="action allowlist">
            <ul className="space-y-1 font-mono text-xs">
              {registry.actions.map((a) => (
                <li key={a.id} className={a.available ? '' : 'text-mid line-through'} title={a.unavailableReason || a.description}>
                  {a.id} <span className="text-mid">· {a.risk}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Loading />
      ) : data?.length === 0 ? (
        <Empty icon={Stethoscope} title={scope === 'active' ? 'all quiet' : 'no incidents ever'}>
          incidents open only when the detector observes a condition (missed heartbeats, interface down, stale handshake, high loss/latency).
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-blob border border-line scrollbar-thin">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-ink-2">
                {['incident', 'device', 'category', 'severity', 'detected', 'state'].map((h) => <th key={h} className="label px-4 py-3 font-normal">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data?.map((i) => (
                <tr key={i.id} className="border-b border-line/60 last:border-0 hover:bg-ink-2">
                  <td className="px-4 py-3">
                    <Link href={`/diagnostics/${i.id}`} className="font-semibold hover:text-lime">{i.title}</Link>
                    <div className="font-mono text-[11px] text-mid">{i.id}{i.isTest && <span className="ml-2 rounded bg-white px-1 text-ink">TEST</span>}</div>
                  </td>
                  <td className="px-4 py-3">{i.deviceName || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs">{humanize(i.category)}</td>
                  <td className="px-4 py-3"><StatusBadge state={i.severity} /></td>
                  <td className="px-4 py-3 font-mono text-xs text-mid">{timeAgo(i.detectedAt, now)}</td>
                  <td className="px-4 py-3"><StatusBadge state={i.state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
