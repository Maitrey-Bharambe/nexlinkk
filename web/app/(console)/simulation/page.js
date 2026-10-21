'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { Card, PageHeader } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import SimulationCanvas from '@/features/simulation/SimulationCanvas';
import { PHASES, SCENARIOS, buildTimeline } from '@/features/simulation/engine';
import { timeAgo } from '@/lib/format';

const SPEEDS = [0.5, 1, 2, 4];
const INITIAL = { a: 'idle', b: 'idle', link: 'none', cp: 'up' };

const DEMO = {
  A: { id: 'demo-a', name: 'pc-a', address: '10.77.0.2', endpoint: '192.168.1.10:51820' },
  B: { id: 'demo-b', name: 'pc-b', address: '10.77.0.3', endpoint: '192.168.1.11:51820' },
  network: 'nexlink-lan',
  cidr: '10.77.0.0/24',
};

const LEVEL_CLS = { ok: 'text-lime', warn: 'text-yellow-300', error: 'text-coral', info: 'text-white/80', pkt: 'text-mid' };
const SRC_LABEL = { A: 'PC-A', B: 'PC-B', CP: 'SERVER' };

/** Folds the timeline up to time t: current state, packets in flight, log, stats. */
function derive(timeline, t) {
  const st = { ...INITIAL };
  const inflight = [];
  const logs = [];
  const stats = { tunnelPkts: 0, tunnelBytes: 0, controlReqs: 0, lost: 0, rtts: [] };
  let phase = null;
  let lastPacket = null;
  timeline.events.forEach((e, i) => {
    if (e.t > t) return;
    if (e.type === 'state') Object.assign(st, e.patch);
    else if (e.type === 'phase') phase = e.id;
    else if (e.type === 'log') {
      logs.push({ key: i, t: e.t, src: e.src, level: e.level, msg: e.msg });
      if (e.rtt) stats.rtts.push(e.rtt);
    } else if (e.type === 'packet') {
      lastPacket = e;
      const progress = (t - e.t) / e.dur;
      if (progress < 1) inflight.push({ ...e, key: i, progress });
      logs.push({ key: `p${i}`, t: e.t, src: e.from, level: 'pkt', msg: `${SRC_LABEL[e.from]} → ${SRC_LABEL[e.to]}  ${e.label}${e.drop ? '  ✕ dropped' : ''}` });
      if (progress >= 1 || e.drop) {
        if (e.channel === 'tunnel') {
          if (e.drop && progress >= 0.55) stats.lost += 1;
          else if (!e.drop && progress >= 1) {
            stats.tunnelPkts += 1;
            stats.tunnelBytes += e.bytes;
          }
        } else if (progress >= 1 && e.kind === 'http') stats.controlReqs += 1;
      }
    }
  });
  logs.sort((x, y) => x.t - y.t);
  return { st, inflight, logs, stats, phase, lastPacket };
}

function toNode(n) {
  return { id: n.id, name: n.label, address: n.address, endpoint: n.endpoint || 'endpoint unknown' };
}

export default function SimulationPage() {
  const now = useNow(5000);
  const { data: topo } = useApi('/topology', { events: ['device:update', 'network:update'], pollMs: 15_000 });
  const devices = useMemo(() => topo?.nodes.filter((n) => n.type === 'device' && n.address) || [], [topo]);

  const [scenario, setScenario] = useState('normal');
  const [pick, setPick] = useState({ a: 'demo', b: 'demo' });
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(false);
  const [t, setT] = useState(0);
  const tRef = useRef(0);

  // Default once to the first real peer pair when the topology arrives; later choices are the user's.
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || devices.length < 2) return;
    defaulted.current = true;
    const edge = topo.edges.find((e) => e.kind === 'peer');
    setPick(edge ? { a: edge.source, b: edge.target } : { a: devices[0].id, b: devices[1].id });
  }, [devices, topo]);

  const real = pick.a !== 'demo' && pick.b !== 'demo' && pick.a !== pick.b;
  const devA = devices.find((d) => d.id === pick.a);
  const devB = devices.find((d) => d.id === pick.b);
  const net = topo?.nodes.find((n) => n.type === 'network' && n.networkId === devA?.networkId);
  const nodes = useMemo(() => {
    if (!real || !devA || !devB) return DEMO;
    return {
      A: toNode(devA),
      B: toNode(devB),
      network: net?.label || 'network',
      cidr: net?.cidr || '',
    };
  }, [real, devA, devB, net]);

  const timeline = useMemo(
    () => buildTimeline(scenario, { a: { ...nodes.A, network: nodes.network, cidr: nodes.cidr }, b: nodes.B }),
    [scenario, nodes],
  );

  const restart = useCallback(() => {
    tRef.current = 0;
    setT(0);
    setPlaying(true);
  }, []);
  useEffect(restart, [timeline, restart]);

  // Animation clock.
  useEffect(() => {
    if (!playing) return undefined;
    let raf;
    let last = performance.now();
    const tick = (ts) => {
      // Wall-clock based, so throttled frames (background window) don't slow the replay;
      // only a long gap (tab switched away) is capped.
      const dt = Math.min(1000, ts - last) * speed;
      last = ts;
      let next = tRef.current + dt;
      if (next >= timeline.duration) {
        if (loop) next = 0;
        else {
          next = timeline.duration;
          setPlaying(false);
        }
      }
      tRef.current = next;
      setT(next);
      if (next < timeline.duration || loop) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, loop, timeline]);

  // Space toggles play/pause.
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return;
      e.preventDefault();
      if (tRef.current >= timeline.duration) restart();
      else setPlaying((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [timeline, restart]);

  const view = useMemo(() => derive(timeline, t), [timeline, t]);
  const jump = (id) => {
    const ev = timeline.events.find((e) => e.type === 'phase' && e.id === id);
    if (!ev) return;
    tRef.current = ev.t;
    setT(ev.t);
    setPlaying(true);
  };

  const logRef = useRef(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.logs.length]);

  const avgRtt = view.stats.rtts.length ? (view.stats.rtts.reduce((s, x) => s + x, 0) / view.stats.rtts.length).toFixed(2) : null;
  const lossPct = view.stats.tunnelPkts + view.stats.lost ? Math.round((view.stats.lost / (view.stats.tunnelPkts + view.stats.lost)) * 100) : 0;
  const observed = real ? topo?.edges.find((e) => e.kind === 'peer' && [e.source, e.target].includes(pick.a) && [e.source, e.target].includes(pick.b)) : null;
  const phasesInTimeline = PHASES.filter((p) => timeline.events.some((e) => e.type === 'phase' && e.id === p.id));
  const linkState = { none: 'unknown', configured: 'configured', connecting: 'connecting', connected: 'connected', degraded: 'degraded', unreachable: 'unreachable' }[view.st.link];

  return (
    <div>
      <PageHeader kicker="protocol replay · two pcs · wireguard" title="simulation">
        <div className="flex items-center gap-1 rounded-full border border-charcoal p-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`rounded-full px-3 py-1.5 font-mono text-xs ${speed === s ? 'bg-lime text-ink' : 'text-mid hover:text-white'}`}
            >
              {s}×
            </button>
          ))}
        </div>
        <button
          onClick={() => (t >= timeline.duration ? restart() : setPlaying((p) => !p))}
          className="inline-flex items-center gap-2 rounded-full bg-lime px-5 py-2.5 text-sm font-semibold text-ink hover:bg-white"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} {playing ? 'pause' : t >= timeline.duration ? 'replay' : 'play'}
        </button>
        <button onClick={restart} className="inline-flex items-center gap-2 rounded-full border border-charcoal px-4 py-2.5 text-sm text-white hover:border-lime hover:text-lime">
          <RotateCcw className="h-4 w-4" /> restart
        </button>
        <label className="flex cursor-pointer items-center gap-2 rounded-full border border-charcoal px-4 py-2.5 font-mono text-xs uppercase text-mid">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} className="accent-[#C7FF2E]" /> loop
        </label>
      </PageHeader>

      <div className="mb-4 flex flex-wrap gap-2">
        {Object.entries(SCENARIOS).map(([id, s]) => (
          <button
            key={id}
            onClick={() => setScenario(id)}
            className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${scenario === id ? 'bg-white text-ink' : 'border border-charcoal bg-ink/60 text-white/80 hover:border-lime hover:text-lime'}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="mb-4 max-w-3xl text-sm text-white/70">{SCENARIOS[scenario].description}</p>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-blob border border-charcoal bg-ink-2">
            <div className="flex flex-wrap items-center gap-2 border-b border-charcoal px-5 py-3">
              <span className="rounded-full border border-lime/60 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-lime">simulated packets</span>
              <span className="rounded-full bg-charcoal px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-white/70">
                t+{(t / 1000).toFixed(1)}s · slowed for viewing
              </span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-mid">space = play / pause</span>
            </div>
            <div className="aspect-[1000/560] w-full">
              <SimulationCanvas a={nodes.A} b={nodes.B} st={view.st} inflight={view.inflight} />
            </div>
            <div className="h-1 w-full bg-charcoal">
              <div className="h-1 bg-lime transition-[width]" style={{ width: `${Math.min(100, (t / timeline.duration) * 100)}%` }} />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {phasesInTimeline.map((p, i) => {
              const active = view.phase === p.id;
              const done = PHASES.findIndex((x) => x.id === view.phase) > PHASES.findIndex((x) => x.id === p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => jump(p.id)}
                  className={`flex items-center gap-2 rounded-full px-4 py-2 font-mono text-xs uppercase tracking-wider ${
                    active ? 'bg-lime text-ink' : done ? 'border border-lime/50 text-lime' : 'border border-charcoal text-mid hover:text-white'
                  }`}
                >
                  <span>{i + 1}</span> {p.label}
                </button>
              );
            })}
          </div>

          <div className="rounded-blob border border-charcoal bg-ink/90 p-4">
            <div className="label mb-3">event log · agents + server</div>
            <div ref={logRef} className="h-64 overflow-y-auto font-mono text-xs leading-relaxed scrollbar-thin">
              {view.logs.map((l) => (
                <div key={l.key} className={LEVEL_CLS[l.level]}>
                  <span className="text-mid">{(l.t / 1000).toFixed(2).padStart(6, ' ')}s</span>{' '}
                  <span className="inline-block w-14 text-white/50">{SRC_LABEL[l.src]}</span> {l.msg}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <Card label="devices in this replay">
            <div className="space-y-3">
              {[
                ['a', 'PC-A'],
                ['b', 'PC-B'],
              ].map(([k, label]) => (
                <label key={k} className="block">
                  <span className="label">{label}</span>
                  <select
                    value={pick[k]}
                    onChange={(e) => setPick((p) => ({ ...p, [k]: e.target.value }))}
                    className="mt-1 w-full rounded-2xl border border-charcoal bg-ink px-3 py-2 text-sm text-white outline-none focus:border-lime"
                  >
                    <option value="demo">demo device ({k === 'a' ? DEMO.A.name : DEMO.B.name})</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label} · {d.address}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <p className="mt-3 text-xs text-mid">{real ? `names and addresses from your enrolled devices in ${nodes.network}.` : 'pick two enrolled devices to replay with their real names and addresses.'}</p>
          </Card>

          <Card tone="charcoal" label="replay state">
            <div className="space-y-2 text-sm">
              <Row k="tunnel link"><StatusBadge state={linkState} label={view.st.link === 'none' ? 'none' : undefined} /></Row>
              <Row k="control plane"><StatusBadge state={view.st.cp === 'down' ? 'down' : 'up'} /></Row>
              <Row k="encrypted packets">{view.stats.tunnelPkts}</Row>
              <Row k="tunnel bytes">{view.stats.tunnelBytes.toLocaleString()} B</Row>
              <Row k="lost datagrams">{view.stats.lost} {lossPct ? `(${lossPct}%)` : ''}</Row>
              <Row k="signed requests">{view.stats.controlReqs}</Row>
              <Row k="probe rtt">{avgRtt ? `${view.stats.rtts.at(-1)} ms · avg ${avgRtt}` : '—'}</Row>
            </div>
          </Card>

          <Card label="real link · observed by agents">
            {!real ? (
              <p className="text-sm text-mid">select two enrolled devices to compare with what their agents actually report.</p>
            ) : observed ? (
              <div className="space-y-2 text-sm">
                <Row k="state"><StatusBadge state={observed.state} pulse /></Row>
                <Row k="path">{observed.path || '—'}</Row>
                <Row k="last handshake">{observed.lastHandshakeAt ? timeAgo(observed.lastHandshakeAt, now) : 'never'}</Row>
                <Row k={nodes.A.name}><StatusBadge state={devA?.agent} /></Row>
                <Row k={nodes.B.name}><StatusBadge state={devB?.agent} /></Row>
              </div>
            ) : (
              <p className="text-sm text-mid">these two devices are not peers in one network.</p>
            )}
          </Card>

          <Card label="packet inspector">
            {view.lastPacket ? (
              <div className="space-y-1.5">
                <div className="font-mono text-xs text-lime">
                  {SRC_LABEL[view.lastPacket.from]} → {SRC_LABEL[view.lastPacket.to]} · {view.lastPacket.channel === 'tunnel' ? 'UDP 51820 (encrypted)' : 'HTTP :3000 (signed)'}
                </div>
                {(view.lastPacket.fields || []).map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[120px_1fr] gap-2 font-mono text-[11px]">
                    <span className="text-mid">{k}</span>
                    <span className="break-all text-white/85">{v}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-mid">press play.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ k, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-xs uppercase tracking-wider text-mid">{k}</span>
      <span className="text-right font-mono text-sm text-white">{children}</span>
    </div>
  );
}
