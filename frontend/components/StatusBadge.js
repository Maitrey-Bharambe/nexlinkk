import { humanize } from '@/lib/format';

/**
 * One visual language for every state in the app. Shape + text carry meaning,
 * colour reinforces it:
 *   solid lime  = observed good       (healthy, connected, verified)
 *   lime ring   = partial / in flight (degraded, connecting, awaiting)
 *   coral       = observed bad        (unreachable, failed, denied)
 *   gray hatch  = configured / unknown — NOT observed
 */
const TONES = {
  good: 'bg-lime text-ink',
  partial: 'border border-lime/70 text-lime',
  bad: 'bg-coral/15 text-coral border border-coral/40',
  info: 'bg-white text-ink',
  none: 'bg-charcoal text-white/70 hatch',
};

const STATE_TONE = {
  healthy: 'good', connected: 'good', online: 'good', up: 'good', operational: 'good', successful: 'good',
  resolved: 'good', allow: 'good', success: 'good', enrolled: 'good', completed: 'info', approved: 'good',
  degraded: 'partial', partially_operational: 'partial', stale: 'partial', partially_successful: 'partial',
  connecting: 'partial', investigating: 'partial', awaiting_approval: 'partial', mitigating: 'partial',
  queued: 'partial', executing: 'partial', pending: 'partial', open: 'bad',
  unreachable: 'bad', offline: 'bad', down: 'bad', absent: 'bad', impaired: 'bad', failed: 'bad',
  timed_out: 'bad', deny: 'bad', failure: 'bad', rejected: 'bad', rejected_by_policy: 'bad', high: 'bad',
  revoked: 'none', unknown: 'none', configured: 'none', never_seen: 'none', pending_enrollment: 'partial',
  verification_inconclusive: 'none', closed: 'none', cancelled: 'none', medium: 'partial', low: 'none',
};

export function toneOf(state) {
  return STATE_TONE[state] || 'none';
}

export default function StatusBadge({ state, label, size = 'sm', pulse = false }) {
  const tone = toneOf(state);
  const pad = size === 'lg' ? 'px-4 py-1.5 text-sm' : 'px-2.5 py-0.5 text-[11px]';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-mono uppercase tracking-wider whitespace-nowrap ${pad} ${TONES[tone]}`}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${tone === 'good' ? 'bg-ink' : tone === 'bad' ? 'bg-coral' : tone === 'partial' ? 'bg-lime' : 'bg-mid'} ${pulse && tone === 'good' ? 'pulse-lime' : ''}`}
      />
      {label || humanize(state)}
    </span>
  );
}
