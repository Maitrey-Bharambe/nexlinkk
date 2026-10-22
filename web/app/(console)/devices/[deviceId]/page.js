'use client';

import { use, useState } from 'react';
import { Ban, Unlink } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Card, ErrorState, Field, Freshness, KV, Loading, Modal, PageHeader, inputCls } from '@/components/ui';
import StatusBadge, { toneOf } from '@/components/StatusBadge';
import { del, post } from '@/lib/api';
import { fmtMeasurement, fmtTime, humanize, timeAgo } from '@/lib/format';
import AgentConsole from '@/features/devices/AgentConsole';
import DeviceActions from '@/features/devices/DeviceActions';
import AiAnalysis from '@/features/devices/AiAnalysis';
import RemoteSession from '@/features/devices/RemoteSession';
import Observatory from '@/features/devices/Observatory';

const SECTIONS = [
  ['identity', 'A', 'identity'],
  ['connection', 'B', 'connection'],
  ['performance', 'C', 'performance'],
  ['events', 'D', 'events'],
  ['actions', 'E', 'actions'],
];

/** Jump index for the inspection workspace. */
function SectionIndex() {
  return (
    <nav aria-label="Device sections" className="sticky top-12 z-20 -mx-4 mb-6 flex gap-px overflow-x-auto border-y border-line bg-ink px-4 scrollbar-thin md:-mx-10 md:px-10">
      {SECTIONS.map(([id, letter, label]) => (
        <a key={id} href={`#${id}`} className="flex shrink-0 items-center gap-2 px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-white/65 hover:bg-white/[0.04] hover:text-white">
          <span className="font-pixel text-[9px] text-lime">{letter}</span>
          {label}
        </a>
      ))}
    </nav>
  );
}

function Section({ id, letter, title, children }) {
  return (
    <section id={id} className="mb-10 scroll-mt-28" aria-labelledby={`${id}-title`}>
      <div className="mb-4 flex items-center gap-3">
        <span aria-hidden className="grid h-7 w-7 place-items-center bg-lime font-pixel text-[11px] text-ink">{letter}</span>
        <h2 id={`${id}-title`} className="font-mono text-xs font-medium uppercase tracking-[0.18em]">{title}</h2>
        <span aria-hidden className="h-px flex-1 bg-line" />
      </div>
      {children}
    </section>
  );
}

const RAIL = { good: 'bg-lime', progress: 'bg-lime/40', warn: 'bg-amber', bad: 'bg-coral', info: 'bg-white/50', none: 'bg-charcoal' };

/** One link of the signal chain. Each signal is independent evidence. */
function SignalCard({ title, state, children }) {
  return (
    <div className="relative bg-ink-2 p-5">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] ${RAIL[toneOf(state)]}`} />
      <div className="flex items-center justify-between gap-3">
        <div className="label">{title}</div>
        <StatusBadge state={state} />
      </div>
      <div className="mt-5 space-y-1 text-sm">{children}</div>
    </div>
  );
}

function RevokeDialog({ open, onClose, deviceId, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(`/devices/${deviceId}/revoke`, { reason });
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="revoke device">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-white/80">
          the device's identity key stops working immediately, queued commands are cancelled, and peers drop it on their next config refresh. this can't be undone — re-enroll to bring it back.
        </p>
        <Field label="reason (audited)">
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} placeholder="laptop lost" />
        </Field>
        <ErrorState error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>cancel</Button>
          <Button type="submit" variant="danger" busy={busy}>revoke</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function DeviceDetail({ params }) {
  const { deviceId } = use(params);
  const { can } = useAuth();
  const now = useNow();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [actionError, setActionError] = useState(null);
  const { data: d, error, loading, reload } = useApi(`/devices/${deviceId}`, { events: ['device:update'], pollMs: 15_000 });
  const { data: history } = useApi(`/devices/${deviceId}/history`, { events: ['device:update', 'incident:update'] });
  const { data: measurements } = useApi(`/devices/${deviceId}/measurements?limit=25`, { events: ['device:update'] });

  if (loading && !d) return <Loading />;
  if (!d) return <ErrorState error={error} onRetry={reload} />;

  const h = d.health;
  async function removeMembership() {
    setActionError(null);
    try {
      await del(`/devices/${deviceId}/membership`);
      reload();
    } catch (err) {
      setActionError(err);
    }
  }

  return (
    <div>
      <PageHeader kicker={`device · ${d.id}`} plain title={d.name}>
        <StatusBadge state={h?.status || 'unknown'} size="lg" pulse />
        {can('devices:membership') && d.membership?.status === 'active' && (
          <Button variant="ghost" onClick={removeMembership}><Unlink className="h-4 w-4" /> remove from network</Button>
        )}
        {can('devices:revoke') && d.enrollmentState !== 'revoked' && (
          <Button variant="danger" onClick={() => setRevokeOpen(true)}><Ban className="h-4 w-4" /> revoke</Button>
        )}
      </PageHeader>
      <RevokeDialog open={revokeOpen} onClose={() => setRevokeOpen(false)} deviceId={deviceId} onDone={reload} />
      <ErrorState error={actionError} />

      <SectionIndex />

      <Section id="identity" letter="A" title="device identity">
        {h?.reasons?.length > 0 && (
          <div className="mb-4 border border-line bg-ink-2 px-5 py-3 text-sm">
            <span className="label mr-2">why</span>
            {h.reasons.join(' · ')}
          </div>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card label="identity & membership">
            <KV k="enrollment"><StatusBadge state={d.enrollmentState} /></KV>
            <KV k="virtual ip" mono>{d.membership ? `${d.membership.address} (${d.membership.status})` : 'unassigned'}</KV>
            <KV k="identity key" mono>{d.identityFingerprint ? `${d.identityFingerprint.slice(0, 22)}…` : '—'}</KV>
            <KV k="wireguard key" mono>{d.wireguardFingerprint ? `${d.wireguardFingerprint.slice(0, 22)}…` : '—'}</KV>
            <KV k="agent" mono>{d.agentVersion || '—'} · {d.platform || '—'}</KV>
            <KV k="capabilities" mono>{d.capabilities.length ? d.capabilities.join(', ') : '—'}</KV>
            <KV k="shares" mono>{d.services?.length ? d.services.map((s) => `${s.name}:${s.port}`).join(', ') : 'nothing'}</KV>
            <KV k="endpoints" mono>{d.endpoints?.reported?.length ? d.endpoints.reported.join(', ') : 'none reported'}</KV>
            <KV k="enrolled">{fmtTime(d.enrolledAt)}</KV>
            {d.enrollmentState === 'pending' && <KV k="token">{d.enrollment.state}{d.enrollment.expiresAt ? ` · until ${new Date(d.enrollment.expiresAt).toLocaleTimeString()}` : ''}</KV>}
            {d.revokedAt && <KV k="revoked">{fmtTime(d.revokedAt)} — {d.revocationReason}</KV>}
          </Card>
          <RemoteSession device={d} now={now} />
        </div>
      </Section>

      <Section id="connection" letter="B" title="connection state">
        {/* Three independent signals: control channel, interface, tunnels. */}
        <div className="grid gap-px overflow-hidden border border-line-strong bg-line md:grid-cols-3">
          <SignalCard title="1 · agent ↔ control plane" state={h?.agent?.status || 'unknown'}>
            <div>last heartbeat <b className="font-mono font-medium">{timeAgo(d.lastHeartbeatAt, now) || 'never'}</b></div>
            <div className="text-xs text-mid">proves the agent can reach us over https. says nothing about the tunnel.</div>
          </SignalCard>
          <SignalCard title="2 · wireguard interface" state={h?.vpn?.state || 'unknown'}>
            <div>{d.vpn?.interfaceName || 'no interface reported'} {d.vpn?.listenPort ? `· udp/${d.vpn.listenPort}` : ''}</div>
            <div className="text-xs text-mid">
              source: {d.vpn?.source || 'none'} · <Freshness at={d.vpn?.observedAt} now={now} staleAfterSec={300} />
              {d.vpn?.keyMatches === false && <span className="text-coral"> · key mismatch!</span>}
            </div>
          </SignalCard>
          <SignalCard title="3 · peer tunnels" state={d.peerLinks.length ? (d.peerLinks.every((l) => l.state === 'connected') ? 'connected' : d.peerLinks.some((l) => l.state === 'connected') ? 'degraded' : d.peerLinks[0].state) : 'unknown'}>
            <div>{d.peerLinks.filter((l) => l.state === 'connected').length}/{d.peerLinks.length} peers with a fresh handshake</div>
            <div className="text-xs text-mid">last handshake: {h?.lastHandshakeAt ? timeAgo(h.lastHandshakeAt, now) : 'never observed'}</div>
          </SignalCard>
        </div>
      </Section>

      <Section id="performance" letter="C" title="performance">
        <Observatory deviceId={deviceId} now={now} />
        <div className="mt-4">
        <Card label="measurements (latest 25)">
          {!measurements?.length ? (
            <p className="text-sm text-mid">not measured yet.</p>
          ) : (
            <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin">
              {measurements.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 font-mono text-xs">
                  <span className="text-mid">{humanize(m.type)} → {m.target.kind}</span>
                  <span className={m.valid ? 'text-white' : 'text-mid'}>{m.valid ? fmtMeasurement(m) : `unavailable${m.error ? ` (${m.error})` : ''}`}</span>
                  <span className="text-mid">{m.source} · {timeAgo(m.measuredAt, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        </div>
      </Section>

      <Section id="events" letter="D" title="recent events">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <AgentConsole deviceId={deviceId} />
        <Card label="connection history">
          {!history ? (
            <Loading />
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
              {[
                ...history.events.map((e) => ({ at: e.at, text: e.operation, sub: `${e.actor?.label || e.actor?.type} · ${e.decision}/${e.outcome}${e.reason ? ` · ${e.reason}` : ''}`, bad: e.decision === 'deny' })),
                ...history.incidents.map((i) => ({ at: i.detectedAt, text: `incident: ${humanize(i.category)}`, sub: i.state, bad: i.state !== 'resolved' })),
                ...history.memberships.map((m) => ({ at: m.joinedAt, text: `joined with ${m.address}`, sub: m.status })),
              ]
                .sort((a, b) => new Date(b.at) - new Date(a.at))
                .slice(0, 40)
                .map((x, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${x.bad ? 'bg-coral' : 'bg-lime'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs">{x.text}</div>
                      <div className="truncate text-[11px] text-mid">{x.sub}</div>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-mid">{timeAgo(x.at, now)}</span>
                  </li>
                ))}
              {history.heartbeats.length > 0 && (
                <li className="pt-2 font-mono text-[11px] text-mid">{history.heartbeats.length} heartbeats retained (latest {timeAgo(history.heartbeats[0].receivedAt, now)})</li>
              )}
            </ul>
          )}
        </Card>
        </div>
      </Section>

      <Section id="actions" letter="E" title="actions">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <DeviceActions device={d} canRequest={can('actions:request')} canDecide={can('actions:approve:low')} />
          <div>
            <AiAnalysis deviceId={deviceId} canRun={can('incidents:diagnose')} now={now} />
          </div>
        </div>
      </Section>
    </div>
  );
}
