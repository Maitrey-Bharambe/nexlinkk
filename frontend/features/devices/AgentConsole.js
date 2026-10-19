'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play, TerminalSquare } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { Card } from '@/components/ui';
import { timeAgo } from '@/lib/format';

const LEVEL = {
  info: 'text-lime',
  warn: 'text-[#ffb020]',
  error: 'text-coral',
  debug: 'text-mid',
};

const clock = (d) => new Date(d).toLocaleTimeString(undefined, { hour12: false });

function fieldText(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

/**
 * Live view of the agent's own output (streamed by agent ≥ 0.2.0 after each
 * heartbeat). Read-only; nothing typed here reaches the device.
 */
export default function AgentConsole({ deviceId }) {
  const now = useNow(2000);
  const [paused, setPaused] = useState(false);
  const { data } = useApi(paused ? null : `/devices/${deviceId}/activity?limit=150`, {
    events: ['agent:event', 'device:update', 'action:update'],
    pollMs: 5000,
  });
  const [frozen, setFrozen] = useState(null);
  useEffect(() => {
    if (!paused && data) setFrozen(data);
  }, [data, paused]);
  const view = frozen || data;
  const lines = [...(view?.events || [])].reverse(); // oldest first, like a terminal

  const box = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const last = view?.events?.[0]?.at;
  const live = last && now - new Date(last).getTime() < 90_000;

  return (
    <Card
      label="agent console"
      action={
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-mid">
            <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-lime pulse-lime' : 'bg-mid'}`} />
            {live ? `streaming · ${timeAgo(last, now)}` : last ? `last output ${timeAgo(last, now)}` : 'no output yet'}
          </span>
          <button onClick={() => setPaused((p) => !p)} className="rounded-full border border-charcoal p-1.5 text-mid hover:text-white" title={paused ? 'resume' : 'pause'}>
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
        </div>
      }
    >
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-80 overflow-y-auto rounded-2xl border border-charcoal bg-[#090909] p-3 font-mono text-[11.5px] leading-relaxed scrollbar-thin"
      >
        {lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-mid">
            <TerminalSquare className="h-6 w-6" />
            <div>no output from this agent yet.</div>
            <div className="max-w-sm text-[11px]">
              start it with <span className="text-white">nexlink-agent run</span>, <span className="text-white">lab</span> or the background service
              (<span className="text-white">install</span>). agents from v0.2.0 stream their log here.
            </div>
          </div>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="whitespace-pre-wrap break-words">
              <span className="text-mid">{clock(l.at)} </span>
              <span className={`${LEVEL[l.level] || 'text-white'} uppercase`}>{l.level.padEnd(5)} </span>
              <span className="text-white">{l.message}</span>
              {Object.entries(l.fields || {}).map(([k, v]) => (
                <span key={k} className="text-mid">
                  {' '}
                  {k}=<span className="text-white/70">{fieldText(v)}</span>
                </span>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] uppercase tracking-wider text-mid">
        <span>agent {view?.agentVersion || '—'} · read-only view</span>
        <span>{lines.length} lines · last 3 days kept</span>
      </div>
    </Card>
  );
}
