'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Activity, ArrowRight, Check, ChevronDown, Network } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { useAuth } from '@/components/AuthProvider';
import { Button, Card, ErrorState, Field, Loading, PageHeader, inputCls } from '@/components/ui';
import StatusBadge, { StatusMarker } from '@/components/StatusBadge';
import { post } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { ApproveCode, UniversalCommand } from '@/features/devices/AddDevice';
import EnrollDialog from '@/features/devices/EnrollDialog';
import ActionCard from '@/features/incidents/ActionCard';

const STAGES = [
  ['network', 'create a network'],
  ['devices', 'add devices'],
  ['verify', 'verify connectivity'],
];

/**
 * The words people confuse, in order. Each is separate evidence; none is
 * inferred from the one before it.
 */
const LADDER = [
  ['registered', 'the console knows the name. nothing has run on the computer yet.'],
  ['enrolled', 'the agent proved it holds its own keys and got a virtual ip.'],
  ['peer configured', 'both computers know each other’s public key and address.'],
  ['tunnel established', 'WireGuard completed a handshake: encrypted packets flow.'],
  ['reachable', 'a test through the tunnel got answers from the other side.'],
];

function Stepper({ stage, networkId, go }) {
  const idx = STAGES.findIndex(([k]) => k === stage);
  return (
    <ol className="mb-8 grid grid-cols-3 gap-px border border-line-strong bg-line" aria-label="Setup progress">
      {STAGES.map(([k, label], i) => {
        const done = i < idx;
        const on = i === idx;
        const reachable = i === 0 || networkId;
        return (
          <li key={k} className={on ? 'bg-lime text-ink' : 'bg-ink-2'}>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => go(k)}
              aria-current={on ? 'step' : undefined}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors disabled:cursor-not-allowed ${on ? '' : 'text-white/60 hover:text-white'}`}
            >
              <span className={`grid h-7 w-9 shrink-0 place-items-center border font-pixel text-[9px] ${on ? 'border-ink' : done ? 'border-lime text-lime' : 'border-line-strong'}`}>
                {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : String(i + 1).padStart(2, '0')}
              </span>
              <span className="hidden font-mono text-[11px] uppercase tracking-[0.14em] sm:inline">{label}</span>
              {done && <span className="sr-only">(done)</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ── stage 1 ───────────────────────────────────────────────────────────
function NetworkStage({ onReady }) {
  const { user } = useAuth();
  const { data: networks, loading } = useApi('/networks');
  const [mode, setMode] = useState(null);
  const [name, setName] = useState('');
  const [cidr, setCidr] = useState('');
  const [suggested, setSuggested] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (networks && mode === null) setMode(networks.length ? 'existing' : 'new');
  }, [networks, mode]);
  useEffect(() => {
    if (mode !== 'new' || suggested) return;
    setName((n) => n || `${(user?.displayName || 'my').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-net`);
    fetch('/api/v1/networks/suggest-cidr', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => j?.data?.cidr && setSuggested(j.data.cidr))
      .catch(() => {});
  }, [mode, suggested, user]);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const n = await post('/networks', { name, cidr: advanced && cidr ? cidr : suggested });
      onReady(n.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !networks) return <Loading />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card label="stage 1 · a private network">
        {networks?.length > 0 && (
          <div className="mb-5 inline-flex rounded-control border border-line bg-ink p-0.5" role="tablist">
            {[
              ['existing', `use one of mine (${networks.length})`],
              ['new', 'create a new one'],
            ].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)} className={`rounded-[2px] px-3 py-1.5 text-xs font-semibold ${mode === k ? 'bg-lime text-ink' : 'text-mid hover:text-white'}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {mode === 'existing' ? (
          <ul className="divide-y divide-line rounded-panel border border-line">
            {networks.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => onReady(n.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/[0.02]">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{n.name}</span>
                    <span className="font-mono text-[11px] text-mid">{n.cidr}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-mid" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <form onSubmit={create} className="space-y-4">
            <Field label="network name" hint="e.g. home-lab, office, family">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={64} pattern="[\w .\-]+" />
            </Field>
            <div className="rounded-control border border-line bg-ink px-3.5 py-3 text-sm">
              <span className="text-mid">address range </span>
              <span className="font-mono text-white">{advanced && cidr ? cidr : suggested || 'picking a free range…'}</span>
              <span className="text-mid"> · picked automatically so it never overlaps your other networks</span>
            </div>
            <button type="button" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced} className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-mid hover:text-white">
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advanced ? 'rotate-180' : ''}`} aria-hidden /> advanced settings
            </button>
            {advanced && (
              <Field label="custom range (CIDR)" hint="private ranges only (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), /16 to /29; must not overlap another network">
                <input className={`${inputCls} font-mono`} placeholder={suggested || '10.120.0.0/24'} value={cidr} onChange={(e) => setCidr(e.target.value.trim())} />
              </Field>
            )}
            <ErrorState error={error} />
            <Button type="submit" busy={busy} disabled={!suggested && !(advanced && cidr)}>
              <Network className="h-4 w-4" aria-hidden /> create network
            </Button>
          </form>
        )}
      </Card>
      <Card tone="flat" label="what this does">
        <p className="text-sm text-white/75">
          a network is a private address range and a list of computers allowed to talk inside it. creating one reserves the range — it does
          not connect anything yet, and it is not shown as working until computers actually reach each other.
        </p>
      </Card>
    </div>
  );
}

// ── stage 2 ───────────────────────────────────────────────────────────
function DevicesStage({ net, initialCode, onNext, reload }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const enrolled = net.devices.filter((d) => d.enrollmentState === 'enrolled');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <Card label="1 · on the computer you are adding">
          <UniversalCommand />
        </Card>
        <Card label="2 · here: enter the code it shows">
          <ApproveCode initialCode={initialCode} defaultNetworkId={net.id} onApproved={reload} />
          <p className="mt-4 border-t border-line pt-3 text-xs text-mid">
            not at that computer and want to send something instead?{' '}
            <button type="button" className="text-white underline underline-offset-4 hover:text-lime" onClick={() => setInviteOpen(true)}>send an invite link</button>
          </p>
        </Card>
      </div>
      <EnrollDialog open={inviteOpen} onClose={() => setInviteOpen(false)} networks={[net]} defaultNetworkId={net.id} onCreated={reload} />

      <section className="rounded-panel border border-line">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="label">in {net.name} · {net.cidr}</div>
          <span className="font-mono text-[11px] text-mid">{enrolled.length} enrolled</span>
        </div>
        {net.devices.length === 0 ? (
          <p className="px-5 py-5 text-sm text-mid">no devices yet. they appear here the moment you approve their code.</p>
        ) : (
          <ul className="divide-y divide-line">
            {net.devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <Link href={`/devices/${d.id}`} className="font-medium hover:text-lime">{d.name}</Link>
                  <div className="font-mono text-[11px] text-mid">{d.membership?.address || 'no address yet'} · agent {d.health?.agent?.status?.replace('_', ' ') || 'unknown'}</div>
                </div>
                <StatusBadge state={d.enrollmentState} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-mid">{enrolled.length < 2 ? 'a tunnel needs two enrolled devices in the same network.' : 'ready to check the tunnels.'}</p>
        <Button onClick={onNext} disabled={enrolled.length === 0}>verify connectivity <ArrowRight className="h-4 w-4" aria-hidden /></Button>
      </div>
    </div>
  );
}

// ── stage 3 ───────────────────────────────────────────────────────────
function CheckRow({ state, title, detail }) {
  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-3 py-2.5">
      <StatusMarker state={state} className="mt-1.5" />
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        <div className="text-xs text-mid">{detail}</div>
      </div>
      <StatusBadge state={state} label={{ healthy: 'pass', connected: 'pass', successful: 'pass', unreachable: 'fail', failed: 'fail', degraded: 'partial', connecting: 'waiting', unknown: 'not yet', configured: 'not yet', pending: 'running' }[state] || state} />
    </li>
  );
}

function DeviceChecks({ d, links, peers, now, canRequest, canDecide }) {
  const { data: actions, reload } = useApi(`/devices/${d.id}/actions`, { events: ['action:update'], pollMs: 5000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const h = d.health || {};
  const mine = links.filter((l) => l.source === d.id || l.target === d.id);
  const fresh = mine.filter((l) => l.state === 'connected' || l.state === 'degraded');
  const test = actions?.find((a) => a.actionType === 'run_connectivity_test');
  const peerOk = fresh[0] && (fresh[0].source === d.id ? fresh[0].target : fresh[0].source);

  async function runTest() {
    setBusy(true);
    setError(null);
    try {
      await post(`/devices/${d.id}/actions`, peerOk ? { actionType: 'run_connectivity_test', params: { target: 'peer', peerDeviceId: peerOk, count: 5 } } : { actionType: 'run_connectivity_test', params: { target: 'control_plane', count: 5 } });
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const agentState = h.agent?.status === 'online' ? 'healthy' : h.agent?.status === 'offline' ? 'unreachable' : h.agent?.status === 'stale' ? 'degraded' : 'unknown';
  const vpnState = h.vpn?.state === 'up' ? 'healthy' : h.vpn?.state === 'down' || h.vpn?.state === 'absent' ? 'unreachable' : 'unknown';
  const peerState = peers === 0 ? 'unknown' : mine.length >= peers ? 'healthy' : 'connecting';
  const hsState = mine.length === 0 ? 'unknown' : fresh.length === mine.length ? 'connected' : mine.some((l) => l.state === 'unreachable') ? 'unreachable' : fresh.length ? 'degraded' : 'connecting';
  const testState = !test ? 'unknown' : test.verification?.outcome || (['awaiting_approval', 'queued', 'executing'].includes(test.status) ? 'pending' : test.status === 'rejected' ? 'failed' : 'unknown');

  return (
    <section className="rounded-panel border border-line bg-ink-2">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="min-w-0">
          <Link href={`/devices/${d.id}`} className="font-semibold hover:text-lime">{d.name}</Link>
          <span className="ml-2 font-mono text-[11px] text-mid">{d.membership?.address}</span>
        </div>
        <StatusBadge state={h.status || 'unknown'} />
      </div>
      <ul className="divide-y divide-line px-5">
        <CheckRow state={agentState} title="agent authenticated" detail={h.agent?.lastHeartbeatAt ? `signed heartbeat ${timeAgo(h.agent.lastHeartbeatAt, now)}` : 'no signed heartbeat yet — is the agent window open?'} />
        <CheckRow state={vpnState} title="VPN interface" detail={h.vpn?.state === 'up' ? `${h.vpn.interfaceName || 'tunnel'} up${h.vpn.source ? ` · read via ${h.vpn.source}` : ''}` : `state ${h.vpn?.state || 'unknown'} — reported by the agent`} />
        <CheckRow state={peerState} title="peer configuration" detail={peers === 0 ? 'no other device in this network yet' : `${mine.length} of ${peers} peers configured`} />
        <CheckRow
          state={hsState}
          title="handshake freshness"
          detail={mine.length === 0 ? 'no peer to shake hands with' : `${fresh.length} of ${mine.length} peers with a WireGuard handshake in the last 3 min${fresh.some((l) => l.path === 'relay') ? ' (some via relay)' : ''}`}
        />
        <CheckRow
          state={testState}
          title={`connectivity test ${peerOk ? 'through the tunnel' : 'to the control plane'}`}
          detail={!test ? 'not run yet — needs your approval like every action' : test.verification?.notes?.[0] || `request ${test.status.replace(/_/g, ' ')}`}
        />
      </ul>
      <div className="space-y-3 border-t border-line px-5 py-4">
        {canRequest && d.enrollmentState === 'enrolled' && (
          <Button size="sm" variant="ghost" busy={busy} onClick={runTest}>
            <Activity className="h-3.5 w-3.5" aria-hidden /> {test ? 'run the test again' : 'run connectivity test'}
          </Button>
        )}
        <ErrorState error={error} />
        {test && test.status === 'awaiting_approval' && <ActionCard action={test} canDecide={canDecide} onChange={reload} />}
      </div>
    </section>
  );
}

function VerifyStage({ net, now }) {
  const { can } = useAuth();
  const enrolled = net.devices.filter((d) => d.enrollmentState === 'enrolled');
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {enrolled.length === 0 ? (
          <Card><p className="text-sm text-mid">no enrolled device yet — go back to stage 2.</p></Card>
        ) : (
          enrolled.map((d) => (
            <DeviceChecks key={d.id} d={d} links={net.links} peers={enrolled.length - 1} now={now} canRequest={can('actions:request')} canDecide={can('actions:approve:low')} />
          ))
        )}
        <div className="flex flex-wrap gap-2">
          <Link href={`/topology?networkId=${net.id}`}><Button variant="white">open topology <ArrowRight className="h-4 w-4" aria-hidden /></Button></Link>
          <Link href={`/networks/${net.id}`}><Button variant="ghost">network details</Button></Link>
        </div>
      </div>
      <Card tone="flat" label="five different things — none implies the next">
        <ol className="space-y-3">
          {LADDER.map(([k, v], i) => (
            <li key={k} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
              <span className="font-mono text-[11px] text-lime">{i + 1}</span>
              <div>
                <div className="text-sm font-medium">{k}</div>
                <div className="text-xs text-mid">{v}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function Setup() {
  const params = useSearchParams();
  const router = useRouter();
  const now = useNow();
  const networkId = params.get('network');
  const code = params.get('code') || '';
  const stage = params.get('stage') || (networkId ? 'devices' : 'network');
  const { data: net, error, reload } = useApi(networkId ? `/networks/${networkId}` : null, { events: ['device:update', 'network:update'], pollMs: 5000 });

  const go = (s, id = networkId) => router.replace(`/setup?${new URLSearchParams({ ...(id ? { network: id } : {}), stage: s, ...(code && s === 'devices' ? { code } : {}) })}`);

  return (
    <div>
      <PageHeader kicker="one network, a few devices, a verified tunnel" title={'set up\nin 3 steps'} description="three short steps. everything technical stays optional until you want it." />
      <Stepper stage={stage} networkId={networkId} go={go} />
      <ErrorState error={error} onRetry={reload} />
      {stage === 'network' || !networkId ? (
        <NetworkStage onReady={(id) => go('devices', id)} />
      ) : !net ? (
        <Loading />
      ) : stage === 'devices' ? (
        <DevicesStage net={net} initialCode={code} onNext={() => go('verify')} reload={reload} />
      ) : (
        <VerifyStage net={net} now={now} />
      )}
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Setup />
    </Suspense>
  );
}

