'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Check, Circle, Loader2, Send, TerminalSquare, X } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { post } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Button, ErrorState, Numeral, Segmented } from '@/components/ui';
import { useAuth } from '@/components/AuthProvider';
import ActionCard from '@/features/incidents/ActionCard';
import AiAnalysis from '@/features/devices/AiAnalysis';

const ACTIVE = ['awaiting_approval', 'queued', 'executing'];
const SIZES = [['4', '4 MB'], ['8', '8 MB'], ['16', '16 MB'], ['32', '32 MB']];
const clock = (d) => new Date(d).toLocaleTimeString(undefined, { hour12: false });
const FLOW_LINE = /transfer|executing approved command|command finished|tunnel peers updated|no direct path|relay/i;

/** Where a transfer test is in its life, derived from real records only. */
function phaseOf(a, now) {
  if (!a) return null;
  if (a.status === 'rejected_by_policy') return 'rejected';
  if (a.status === 'rejected' || a.status === 'cancelled') return 'stopped';
  if (a.status === 'awaiting_approval') return 'approval';
  const t = a.transfer || {};
  if (a.status === 'completed' || t.completedAt) return 'done';
  if (t.deliveredAt) return 'transferring';
  return now - new Date(a.updatedAt).getTime() > 5 * 60_000 ? 'stale' : 'waiting';
}

function Step({ state, title, detail }) {
  const icon = {
    done: <Check className="h-3.5 w-3.5" aria-hidden />,
    active: <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />,
    failed: <X className="h-3.5 w-3.5" aria-hidden />,
    todo: <Circle className="h-3 w-3" aria-hidden />,
  }[state];
  const tone = { done: 'border-lime bg-lime text-ink', active: 'border-lime text-lime', failed: 'border-coral bg-coral text-ink', todo: 'border-line-strong text-white/40' }[state];
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
      <span className={`mt-0.5 flex h-6 w-6 items-center justify-center border ${tone}`}>{icon}</span>
      <div className="min-w-0 pb-3">
        <div className={`font-mono text-[12px] uppercase tracking-wider ${state === 'todo' ? 'text-white/45' : 'text-white'}`}>{title}</div>
        {detail && <div className="mt-0.5 text-[12.5px] leading-snug text-white/65">{detail}</div>}
      </div>
    </li>
  );
}

function Tile({ label, children, tone = 'text-white' }) {
  return (
    <div className="border border-line bg-ink p-3">
      <div className="label !text-[10px]">{label}</div>
      <div className={`mt-2 font-pixel text-[18px] leading-none ${tone}`}>{children}</div>
    </div>
  );
}

/**
 * Data-flow lab under the topology map. Sends real bytes through the WireGuard
 * tunnel between two agents (an approved, allowlisted action), shows each
 * stage, both agents' live output, the verified result and an AI explanation.
 */
export default function FlowLab({ links, nodes, selectedLinkId, onSelectLink, onActivity }) {
  const now = useNow(1000);
  const { can } = useAuth();
  const name = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const link = links.find((l) => l.id === selectedLinkId) || links.find((l) => l.state === 'connected') || links[0];
  const [reverse, setReverse] = useState(false);
  const [size, setSize] = useState('8');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [mine, setMine] = useState(null); // id of the test started from this page

  const from = link ? (reverse ? link.target : link.source) : null;
  const to = link ? (reverse ? link.source : link.target) : null;
  const fromNode = name.get(from);
  const toNode = name.get(to);

  const { data: actions, reload } = useApi(from ? `/devices/${from}/actions` : null, { events: ['action:update'], pollMs: 3000 });
  const { data: actA } = useApi(from ? `/devices/${from}/activity?limit=80` : null, { events: ['agent:event', 'action:update'], pollMs: 4000 });
  const { data: actB } = useApi(to ? `/devices/${to}/activity?limit=80` : null, { events: ['agent:event', 'action:update'], pollMs: 4000 });

  const tests = (actions || []).filter((a) => a.actionType === 'run_transfer_test' && a.params?.peerDeviceId === to);
  const current = (mine && tests.find((a) => a.id === mine)) || tests.find((a) => ACTIVE.includes(a.status)) || tests[0] || null;
  const phase = phaseOf(current, now);
  const t = current?.transfer || {};

  // Tell the map which link is carrying a test right now (for the heavy-flow animation).
  const running = phase === 'transferring' || (phase === 'done' && t.completedAt && now - new Date(t.completedAt).getTime() < 6000);
  const waiting = phase === 'waiting';
  useEffect(() => {
    onActivity?.(link && (running || waiting) ? { linkId: link.id, mode: running ? 'transferring' : 'waiting', megabytes: current?.params?.megabytes } : null);
  }, [link?.id, running, waiting, current?.params?.megabytes, onActivity]);

  const ready = fromNode?.transfer && toNode?.transfer;
  const connected = link?.state === 'connected' || link?.state === 'degraded';
  const canRequest = can('actions:request');

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const a = await post(`/devices/${from}/actions`, { actionType: 'run_transfer_test', params: { peerDeviceId: to, megabytes: Number(size) } });
      setMine(a.id);
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  // Both agents' output, oldest first, like one terminal.
  const lines = useMemo(() => {
    const tag = (evs, who) => (evs || []).map((e) => ({ ...e, who }));
    const all = [...tag(actA?.events, fromNode?.label), ...tag(actB?.events, toNode?.label)]
      .filter((e) => now - new Date(e.at).getTime() < 30 * 60_000)
      .filter((e) => showAll || FLOW_LINE.test(e.message))
      .sort((a, b) => new Date(a.at) - new Date(b.at));
    return all.slice(-120);
  }, [actA, actB, showAll, fromNode?.label, toNode?.label, now]);
  const box = useRef(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length]);

  if (!links.length) return null;

  const stepState = (n) => {
    const order = { rejected: 1, stopped: 2, approval: 2, waiting: 3, stale: 3, transferring: 4, done: 5 };
    const at = order[phase] ?? 0;
    if (phase === 'rejected' && n === 1) return 'failed';
    if (phase === 'stopped' && n === 2) return 'failed';
    if (phase === 'stale' && n === 3) return 'failed';
    if (phase === 'done' && n === 4) return current?.verification?.outcome === 'successful' ? 'done' : 'failed';
    if (n < at) return 'done';
    if (n === at) return phase === 'done' ? 'done' : 'active';
    return 'todo';
  };

  const outcome = current?.verification?.outcome;
  const mb = (b) => (typeof b === 'number' ? (b / 1048576).toFixed(1) : '—');

  return (
    <section aria-labelledby="flowlab-title" className="border border-line-strong bg-ink-2">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="t-ident bg-lime px-1.5 py-1 text-ink">data flow</span>
          <h2 id="flowlab-title" className="t-section">real bytes through the tunnel</h2>
        </div>
        <span className="font-mono text-[11px] uppercase tracking-wider text-white/55">approved · allowlisted · verified by checksum</span>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 p-5 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {/* ── controls + stages ── */}
        <div className="space-y-5">
          <div>
            <div className="label mb-2">link</div>
            <select
              className="h-10 w-full border border-line bg-ink px-3 font-mono text-[13px] text-white outline-none focus:border-lime"
              value={link?.id || ''}
              onChange={(e) => onSelectLink?.(e.target.value)}
              aria-label="Link to test"
            >
              {links.map((l) => (
                <option key={l.id} value={l.id}>
                  {name.get(l.source)?.label} ⇄ {name.get(l.target)?.label} · {l.state === 'connected' || l.state === 'degraded' ? `${l.state} · ${l.path}` : l.state}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 border border-line bg-ink px-3 py-2.5 font-mono text-[12.5px]">
            <span className="truncate text-white">{fromNode?.label}</span>
            <button type="button" onClick={() => setReverse((r) => !r)} className="shrink-0 border border-line p-1 text-white/70 hover:border-lime hover:text-lime" aria-label="Swap direction" title="Swap direction">
              <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
            </button>
            <span className="truncate text-white">{toNode?.label}</span>
            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-white/50">sender → receiver</span>
          </div>

          <div>
            <div className="label mb-2">amount of data</div>
            <Segmented value={size} onChange={setSize} options={SIZES} label="Transfer size" />
          </div>

          {!ready && (
            <p className="border border-amber/50 bg-amber/[0.06] px-3 py-2 text-[12.5px] leading-snug text-amber">
              {[fromNode, toNode].filter((n) => n && !n.transfer).map((n) => `${n.label} (agent ${n.agentVersion || 'unknown'})`).join(' and ')} cannot run flow tests yet — update the agent to 0.3.0 by running the join line again on that computer.
            </p>
          )}
          {ready && !connected && <p className="text-[12.5px] text-white/60">this link has no verified tunnel right now — the test will tell you whether data can cross it.</p>}

          <Button className="w-full" onClick={start} busy={busy} disabled={!canRequest || !ready || ACTIVE.includes(current?.status)}>
            {!busy && <Send className="h-4 w-4" aria-hidden />} test data flow
          </Button>
          <ErrorState error={error} />

          {current && (
            <ol aria-label="Test progress" className="pt-1">
              <Step state={stepState(1)} title="requested" detail={`${current.params?.megabytes} MB · ${timeAgo(current.createdAt, now)}${current.proposedBy?.type === 'user' ? ' · by an operator' : ''}`} />
              <Step
                state={stepState(1) === 'failed' ? 'failed' : 'done'}
                title="policy check"
                detail={current.validation?.valid ? 'allowlisted · both agents online and capable · within rate limit' : (current.validation?.reasons || []).join('; ')}
              />
              <Step
                state={stepState(2)}
                title="human approval"
                detail={current.approval ? `${current.approval.decision} by ${current.approval.approverName || 'an operator'} · ${timeAgo(current.approval.decidedAt, now)}` : phase === 'approval' ? 'waiting — approve below' : null}
              />
              <Step state={stepState(3)} title="agent picks it up" detail={t.deliveredAt ? `delivered ${timeAgo(t.deliveredAt, now)}` : phase === 'stale' ? 'the agent did not check in — is it running?' : phase === 'waiting' ? 'agents check in about every 30 s' : null} />
              <Step
                state={stepState(4)}
                title={phase === 'done' ? 'transferred & verified' : 'transferring through the tunnel'}
                detail={phase === 'done' ? (current.verification?.notes || []).join(' · ') : phase === 'transferring' ? 'encrypted packets crossing the tunnel now' : null}
              />
            </ol>
          )}

          {phase === 'approval' && (
            <ActionCard action={current} canDecide={can('actions:approve:low')} onChange={reload} showDevice />
          )}
        </div>

        {/* ── result + live log + AI ── */}
        <div className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Tile label="sent">{mb(t.bytesSent)}<span className="ml-1 font-mono text-xs text-white/50">MB</span></Tile>
            <Tile label="time">{typeof t.durationMs === 'number' ? (t.durationMs / 1000).toFixed(2) : '—'}<span className="ml-1 font-mono text-xs text-white/50">s</span></Tile>
            <Tile label="throughput" tone="text-lime">
              {typeof t.mbitPerSecond === 'number' ? <Numeral value={Math.round(t.mbitPerSecond * 10) / 10} /> : '—'}
              <span className="ml-1 font-mono text-xs text-white/50">Mbit/s</span>
            </Tile>
            <Tile label="integrity" tone={t.integrityMatch === false ? 'text-coral' : t.integrityMatch ? 'text-lime' : 'text-white/45'}>
              {t.integrityMatch === null || t.integrityMatch === undefined ? '—' : t.integrityMatch ? 'match' : 'FAIL'}
            </Tile>
            <Tile label="path">{link?.path && (link.state === 'connected' || link.state === 'degraded') ? link.path : '—'}</Tile>
          </div>
          {t.sha256 && (
            <div className="t-data break-all border border-line bg-ink px-3 py-2 text-[11px] text-white/60">
              sha256 sent {t.sha256.slice(0, 24)}… · confirmed by {toNode?.label} {t.peerSha256 ? `${t.peerSha256.slice(0, 24)}…` : '—'}
              {outcome && <span className={`ml-2 uppercase ${outcome === 'successful' ? 'text-lime' : 'text-coral'}`}>· {outcome.replace(/_/g, ' ')}</span>}
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="label">flow log · both agents</div>
              <button type="button" onClick={() => setShowAll((s) => !s)} className="font-mono text-[10.5px] uppercase tracking-wider text-white/55 hover:text-lime" aria-pressed={showAll}>
                {showAll ? 'show flow lines only' : 'show all agent output'}
              </button>
            </div>
            <div ref={box} className="h-64 overflow-y-auto border border-line bg-[#090909] p-3 font-mono text-[11.5px] leading-relaxed scrollbar-thin" aria-live="polite">
              {lines.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-mid">
                  <TerminalSquare className="h-5 w-5" aria-hidden />
                  <div>no flow output in the last 30 minutes. start a test — both agents log what they send and receive.</div>
                </div>
              ) : (
                lines.map((l) => (
                  <div key={`${l.who}-${l.id}`} className="whitespace-pre-wrap break-words">
                    <span className="text-mid">{clock(l.at)} </span>
                    <span className="text-lime">{String(l.who || '').padEnd(12).slice(0, 12)} </span>
                    <span className={l.level === 'warn' ? 'text-amber' : l.level === 'error' ? 'text-coral' : 'text-white'}>{l.message}</span>
                    {Object.entries(l.fields || {}).map(([k, v]) => (
                      <span key={k} className="text-mid">
                        {' '}
                        {k}=<span className="text-white/70">{typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v)}</span>
                      </span>
                    ))}
                  </div>
                ))
              )}
            </div>
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-white/45">agents upload their log at each check-in and right after a test</p>
          </div>

          {from && (
            <div className="border border-line bg-ink p-4">
              <div className="label mb-3">ai analysis of {fromNode?.label} · includes recent flow tests</div>
              <AiAnalysis deviceId={from} canRun={can('incidents:diagnose')} now={now} />
            </div>
          )}

          {tests.length > 1 && (
            <div>
              <div className="label mb-2">recent tests on this link</div>
              <ul className="divide-y divide-line border border-line">
                {tests.slice(0, 5).map((a) => (
                  <li key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 font-mono text-[11.5px]">
                    <span className="truncate text-white/80">
                      {timeAgo(a.createdAt, now)} · {a.params?.megabytes} MB
                      {typeof a.transfer?.mbitPerSecond === 'number' ? ` · ${a.transfer.mbitPerSecond.toFixed(1)} Mbit/s` : ''}
                    </span>
                    <span className={`uppercase ${a.verification?.outcome === 'successful' ? 'text-lime' : a.verification?.outcome ? 'text-coral' : 'text-white/50'}`}>
                      {a.verification?.outcome?.replace(/_/g, ' ') || a.status.replace(/_/g, ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
