export function timeAgo(date, now = Date.now()) {
  if (!date) return null;
  const s = Math.round((now - new Date(date).getTime()) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(date) {
  if (!date) return '—';
  return new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/** Missing measurements are shown as such — never coerced to 0. */
export function fmtMeasurement(m) {
  if (!m || m.value === null || m.value === undefined) return 'Not measured';
  const v = m.unit === 'ms' ? m.value.toFixed(1) : m.value;
  return `${v} ${m.unit === 'percent' ? '%' : m.unit}`;
}

export const shortId = (id) => (id ? `${id.slice(0, 6)}…${id.slice(-4)}` : '—');

export const humanize = (s) => (s ? String(s).replace(/_/g, ' ') : '—');
