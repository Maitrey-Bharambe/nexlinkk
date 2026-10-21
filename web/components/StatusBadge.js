import { humanize } from '@/lib/format';

/**
 * One visual language for every state in the app. Text always names the
 * state; the marker shape and colour reinforce it, so meaning never depends
 * on colour alone:
 *   ●  good      observed good          (healthy, connected, verified)   lime
 *   ◌  progress  in flight              (connecting, queued, awaiting)    lime ring
 *   ◆  warn      partially working      (degraded, stale)                 amber
 *   ■  bad       observed bad           (unreachable, failed, denied)     coral
 *   ┄  none      configured / unknown — NOT observed                      gray
 */
const TONES = {
  good: 'text-lime border-lime/35 bg-lime/[0.07]',
  progress: 'text-lime border-lime/35',
  warn: 'text-amber border-amber/40 bg-amber/[0.06]',
  bad: 'text-coral border-coral/45 bg-coral/[0.07]',
  info: 'text-white border-line-strong bg-white/[0.05]',
  none: 'text-white/60 border-line-strong',
};

const MARKERS = {
  good: 'h-1.5 w-1.5 rounded-full bg-current',
  progress: 'h-2 w-2 rounded-full border border-current',
  warn: 'h-1.5 w-1.5 rotate-45 bg-current',
  bad: 'h-1.5 w-1.5 bg-current',
  info: 'h-1.5 w-1.5 rounded-full bg-current',
  none: 'h-2 w-2 rounded-full border border-dashed border-current',
};

const STATE_TONE = {
  healthy: 'good', connected: 'good', online: 'good', up: 'good', operational: 'good', successful: 'good',
  resolved: 'good', allow: 'good', success: 'good', approved: 'good', enrolled: 'info', completed: 'info',
  degraded: 'warn', partially_operational: 'warn', stale: 'warn', partially_successful: 'warn', medium: 'warn',
  connecting: 'progress', investigating: 'progress', awaiting_approval: 'progress', mitigating: 'progress',
  queued: 'progress', executing: 'progress', pending: 'progress', pending_enrollment: 'progress',
  open: 'warn', unreachable: 'bad', offline: 'bad', down: 'bad', absent: 'bad', impaired: 'bad', failed: 'bad',
  timed_out: 'bad', deny: 'bad', failure: 'bad', rejected: 'bad', rejected_by_policy: 'bad', high: 'bad',
  revoked: 'none', unknown: 'none', configured: 'none', never_seen: 'none',
  verification_inconclusive: 'none', closed: 'none', cancelled: 'none', low: 'none',
};

export function toneOf(state) {
  return STATE_TONE[state] || 'none';
}

export function StatusMarker({ state, className = '' }) {
  const tone = toneOf(state);
  return <span aria-hidden className={`inline-block shrink-0 ${MARKERS[tone]} ${TONES[tone].split(' ')[0]} ${className}`} />;
}

export default function StatusBadge({ state, label, size = 'sm' }) {
  const tone = toneOf(state);
  const pad = size === 'lg' ? 'h-8 px-3 text-xs' : 'h-6 px-2 text-[10.5px]';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-[6px] border font-mono uppercase tracking-wider whitespace-nowrap ${pad} ${TONES[tone]}`}>
      <span aria-hidden className={`inline-block ${MARKERS[tone]}`} />
      {label || humanize(state)}
    </span>
  );
}
