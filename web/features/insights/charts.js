'use client';

import { useMemo, useRef, useState } from 'react';

/**
 * Small SVG charts for the insights page. Rules (see the dataviz guidance):
 * one measure per chart (no dual axes), 2px lines, 4px rounded bar ends with a
 * 2px gap, recessive grid, text in text colours, hover tooltip on every chart,
 * and gaps (no line) where nothing was measured — never an invented zero.
 */

const fmtHour = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (t) => new Date(t).toLocaleDateString([], { weekday: 'short' });

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

function Tooltip({ x, y, width, children }) {
  const left = Math.min(Math.max(x, 70), width - 70);
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-control border border-line-strong bg-ink-3 px-2.5 py-1.5 font-mono text-[11px] shadow-lg"
      style={{ left, top: Math.max(y - 8, 18) }}
    >
      {children}
    </div>
  );
}

/**
 * Line (average) with a translucent band (p95) of the same hue: one measure and
 * its spread, not two series. Hours without samples break the line.
 */
export function LineBandChart({ series, lineKey, bandKey, unit, height = 180, label }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const W = 640;
  const H = height;
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  const max = niceMax(Math.max(0, ...series.map((p) => Math.max(p[lineKey] ?? 0, p[bandKey] ?? 0))));
  const x = (i) => pad.l + (i / Math.max(1, series.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);

  const { line, band } = useMemo(() => {
    const segs = [];
    let cur = [];
    series.forEach((p, i) => {
      if (p[lineKey] == null) {
        if (cur.length) segs.push(cur);
        cur = [];
      } else cur.push(i);
    });
    if (cur.length) segs.push(cur);
    const line = segs.map((s) => s.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(series[i][lineKey]).toFixed(1)}`).join('')).join('');
    const band = bandKey
      ? segs
          .filter((s) => s.length > 1)
          .map((s) => {
            const top = s.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(series[i][bandKey] ?? series[i][lineKey]).toFixed(1)}`).join('');
            const bottom = [...s].reverse().map((i) => `L${x(i).toFixed(1)},${y(series[i][lineKey]).toFixed(1)}`).join('');
            return `${top}${bottom}Z`;
          })
          .join('')
      : '';
    return { line, band };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, lineKey, bandKey, max]);

  const measured = series.filter((p) => p[lineKey] != null).length;
  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (series.length - 1));
    if (i >= 0 && i < series.length) setHover(i);
  };
  const hp = hover != null ? series[hover] : null;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none"
        role="img"
        aria-label={`${label}: ${measured} of ${series.length} hours measured`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="rgba(255,255,255,0.07)" />
            <text x={pad.l - 6} y={y(max * f) + 3} textAnchor="end" fontSize="10" fill="#808080" fontFamily="var(--font-mono)">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {[0, Math.floor((series.length - 1) / 2), series.length - 1].map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'} fontSize="10" fill="#808080" fontFamily="var(--font-mono)">
            {i === series.length - 1 ? 'now' : `${series.length - 1 - i}h ago`}
          </text>
        ))}
        {band && <path d={band} fill="#C7FF2E" opacity="0.14" />}
        {line && <path d={line} fill="none" stroke="#C7FF2E" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {series.map((p, i) =>
          p[lineKey] != null && (series[i - 1]?.[lineKey] == null) && (series[i + 1]?.[lineKey] == null) ? (
            <circle key={i} cx={x(i)} cy={y(p[lineKey])} r="4" fill="#C7FF2E" stroke="#161616" strokeWidth="2" />
          ) : null,
        )}
        {hp && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="rgba(255,255,255,0.25)" />
            {hp[lineKey] != null && <circle cx={x(hover)} cy={y(hp[lineKey])} r="4.5" fill="#C7FF2E" stroke="#161616" strokeWidth="2" />}
          </g>
        )}
      </svg>
      {hp && ref.current && (
        <Tooltip x={(x(hover) / W) * ref.current.getBoundingClientRect().width} y={((hp[lineKey] != null ? y(hp[lineKey]) : pad.t) / H) * ref.current.getBoundingClientRect().height} width={ref.current.getBoundingClientRect().width}>
          <div className="text-mid">{fmtHour(hp.t)}</div>
          {hp[lineKey] == null ? (
            <div className="text-white/70">not measured</div>
          ) : (
            <div className="text-white">
              avg {hp[lineKey]} {unit}
              {bandKey && hp[bandKey] != null && <span className="text-mid"> · p95 {hp[bandKey]} {unit}</span>}
              {hp.samples != null && <span className="text-mid"> · {hp.samples} samples</span>}
            </div>
          )}
        </Tooltip>
      )}
      {measured === 0 && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="rounded-control border border-dashed border-line-strong bg-ink-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-mid">
            no measurements in this window
          </span>
        </div>
      )}
    </div>
  );
}

/** Vertical bars for one measure (e.g. incidents per day). */
export function BarChart({ items, valueKey, labelOf, unit, height = 150, label }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const W = 640;
  const H = height;
  const pad = { l: 28, r: 8, t: 10, b: 22 };
  const max = niceMax(Math.max(0, ...items.map((d) => d[valueKey] ?? 0)));
  const slot = (W - pad.l - pad.r) / items.length;
  const bw = Math.max(4, slot - 2 - slot * 0.35);
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
        {[0, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="rgba(255,255,255,0.07)" />
            <text x={pad.l - 6} y={y(max * f) + 3} textAnchor="end" fontSize="10" fill="#808080" fontFamily="var(--font-mono)">{Math.round(max * f)}</text>
          </g>
        ))}
        {items.map((d, i) => {
          const v = d[valueKey] ?? 0;
          const cx = pad.l + slot * i + slot / 2;
          const top = y(v);
          const h = Math.max(0, H - pad.b - top);
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              {/* Hit target larger than the mark. */}
              <rect x={cx - slot / 2} y={pad.t} width={slot} height={H - pad.t - pad.b} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${cx - bw / 2},${H - pad.b} V${top + Math.min(4, h)} Q${cx - bw / 2},${top} ${cx - bw / 2 + Math.min(4, bw / 2)},${top} H${cx + bw / 2 - Math.min(4, bw / 2)} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + Math.min(4, h)} V${H - pad.b} Z`}
                  fill={hover === i ? '#FFFFFF' : 'rgba(255,255,255,0.72)'}
                />
              )}
              <text x={cx} y={H - 6} textAnchor="middle" fontSize="10" fill="#808080" fontFamily="var(--font-mono)">{labelOf(d)}</text>
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="rgba(255,255,255,0.18)" />
      </svg>
      {hover != null && ref.current && (
        <Tooltip x={((pad.l + slot * hover + slot / 2) / W) * ref.current.getBoundingClientRect().width} y={(y(items[hover][valueKey] ?? 0) / H) * ref.current.getBoundingClientRect().height} width={ref.current.getBoundingClientRect().width}>
          <span className="text-mid">{labelOf(items[hover], true)} · </span>
          <span className="text-white">{items[hover][valueKey] ?? 0} {unit}</span>
        </Tooltip>
      )}
    </div>
  );
}

/** Horizontal share bars (e.g. incidents by category), sorted by value. */
export function ShareBars({ entries, unit }) {
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (!total) return <p className="text-sm text-mid">none recorded in this window.</p>;
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <ul className="space-y-2.5">
      {[...entries].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
        <li key={k} title={`${k.replace(/_/g, ' ')}: ${v} ${unit}`}>
          <div className="mb-1 flex justify-between text-xs">
            <span className="text-white/80">{k.replace(/_/g, ' ')}</span>
            <span className="tabular font-mono text-white">{v}</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/[0.06]">
            <div className="h-1.5 rounded-full bg-white/70" style={{ width: `${(v / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export { fmtDay };
