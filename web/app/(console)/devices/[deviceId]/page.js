'use client';

import { use, useState } from 'react';
import { Ban, Unlink } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Card, ErrorState, Field, Freshness, KV, Loading, Modal, PageHeader, inputCls } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { del, post } from '@/lib/api';
import { fmtMeasurement, fmtTime, humanize, timeAgo } from '@/lib/format';
import AgentConsole from '@/features/devices/AgentConsole';
import DeviceActions from '@/features/devices/DeviceActions';

function SignalCard({ title, state, children, tone }) {
  return (
    <Card tone={tone}>
      <div className="flex items-center justify-between">
        <div className={`label ${tone === 'lime' || tone === 'white' ? '!text-ink/60' : ''}`}>{title}</div>
        <StatusBadge state={state} />
      </div>
      <div className="mt-6 space-y-1 text-sm">{children}</div>
    </Card>
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
      <PageHeader kicker={`device · ${d.id}`} title={d.name}>
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

      {h?.reasons?.length > 0 && (
        <div className="mb-4 rounded-2xl border border-charcoal bg-ink-2 px-5 py-3 text-sm">
          <span className="label mr-2">why</span>
          {h.reasons.join(' · ')}
        </div>
      )}

      {/* Three independent signals: control channel, interface, tunnels. */}
      <div className="grid gap-4 md:grid-cols-3">
        <SignalCard title="1 · agent ↔ control plane" state={h?.agent?.status || 'unknown'} tone={h?.agent?.status === 'online' ? 'lime' : 'default'}>
          <div>last heartbeat <b>{timeAgo(d.lastHeartbeatAt, now) || 'never'}</b></div>
          <div className="text-xs opacity-70">proves the agent can reach us over https. says nothing about the tunnel.</div>
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

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.3fr]">
        <Card label="identity & membership">
          <KV k="enrollment"><StatusBadge state={d.enrollmentState} /></KV>
          <KV k="virtual ip" mono>{d.membership ? `${d.membership.address} (${d.membership.status})` : 'unassigned'}</KV>
          <KV k="identity key" mono>{d.identityFingerprint ? `${d.identityFingerprint.slice(0, 22)}…` : '—'}</KV>
          <KV k="wireguard key" mono>{d.wireguardFingerprint ? `${d.wireguardFingerprint.slice(0, 22)}…` : '—'}</KV>
          <KV k="agent" mono>{d.agentVersion || '—'} · {d.platform || '—'}</KV>
          <KV k="capabilities" mono>{d.capabilities.length ? d.capabilities.join(', ') : '—'}</KV>
          <KV k="endpoints" mono>{d.endpoints?.reported?.length ? d.endpoints.reported.join(', ') : 'none reported'}</KV>
          <KV k="enrolled">{fmtTime(d.enrolledAt)}</KV>
          {d.enrollmentState === 'pending' && <KV k="token">{d.enrollment.state}{d.enrollment.expiresAt ? ` · until ${new Date(d.enrollment.expiresAt).toLocaleTimeString()}` : ''}</KV>}
          {d.revokedAt && <KV k="revoked">{fmtTime(d.revokedAt)} — {d.revocationReason}</KV>}
        </Card>

        <Card label="peer links (observed)">
          {d.peerLinks.length === 0 ? (
            <p className="text-sm text-mid">no configured peers. a link appears when another active device joins this network.</p>
          ) : (
            <ul className="divide-y divide-charcoal">
              {d.peerLinks.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <div className="font-semibold">{l.peerName || l.peerDeviceId}</div>
                    <div className="font-mono text-[11px] text-mid">
                      path {l.path} · handshake {l.lastHandshakeAt ? timeAgo(l.lastHandshakeAt, now) : 'never'} {l.reason ? `· ${l.reason}` : ''}
                    </div>
                  </div>
                  <StatusBadge state={l.state} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <AgentConsole deviceId={deviceId} />
        <DeviceActions device={d} canRequest={can('actions:request')} canDecide={can('actions:approve:low')} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
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
    </div>
  );
}
