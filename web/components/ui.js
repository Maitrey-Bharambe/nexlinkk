'use client';

import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Shared primitives. Square panels with crisp borders on a technical grid;
 * lime is a surface or a signal (actions, active, verified), never a glow.
 */

/**
 * Page title. Short, fixed titles use the pixel display face (`title` may
 * contain a line break, e.g. "network
overview"); dynamic titles such as
 * device names or incident titles pass `plain` and stay in a readable sans.
 */
export function PageHeader({ kicker, title, children, description, plain = false }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-6">
      <div className="min-w-0">
        {kicker && (
          <div className="label mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-2 w-2 bg-lime" />
            {kicker}
          </div>
        )}
        {plain ? (
          <h1 className="break-words text-2xl font-semibold tracking-tight md:text-[34px] md:leading-[1.1]">
            {title}
            <span className="text-lime">.</span>
          </h1>
        ) : (
          <h1 className="t-title whitespace-pre-line">
            {title}
            <span className="text-lime">.</span>
          </h1>
        )}
        {description && <p className="mt-3 max-w-2xl text-sm text-white/70">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** Heading for a group of panels inside a page. */
export function SectionHeading({ children, action, className = '' }) {
  return (
    <div className={`mb-3 flex items-center justify-between gap-3 ${className}`}>
      <h2 className="t-section">{children}</h2>
      {action}
    </div>
  );
}

const CARD_TONES = {
  default: 'bg-ink-2 border border-line',
  report: 'bg-ink-2 border border-line-strong frame-double',
  lime: 'bg-lime text-ink',
  white: 'bg-white text-ink',
  charcoal: 'bg-ink-3 border border-line',
  flat: 'border border-line',
};

/**
 * Panel. `label` is a compact mono eyebrow; `title` adds a pixel section
 * title under it (use for the main panels of a page, not every box).
 */
export function Card({ tone = 'default', className = '', children, label, title, action }) {
  const dark = tone === 'lime' || tone === 'white';
  return (
    <section className={`rounded-panel p-5 ${CARD_TONES[tone] || CARD_TONES.default} ${className}`}>
      {(label || title || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {label && <div className={`label ${dark ? '!text-ink/60' : ''}`}>{label}</div>}
            {title && <h2 className={`t-section ${label ? 'mt-1.5' : ''}`}>{title}</h2>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = 'lime', size = 'md', className = '', busy, children, ...props }) {
  const v = {
    // Primary: lime slab; on hover it lifts onto a hard white offset shadow.
    lime: 'bg-lime text-ink border border-lime hover:-translate-x-px hover:-translate-y-px hover:shadow-[3px_3px_0_0_#fff] active:translate-x-0 active:translate-y-0 active:shadow-none',
    white: 'bg-white text-ink border border-white hover:-translate-x-px hover:-translate-y-px hover:shadow-[3px_3px_0_0_var(--color-lime)]',
    ghost: 'border border-line-strong text-white hover:border-lime hover:text-lime',
    danger: 'border border-coral/50 text-coral hover:bg-coral hover:text-ink',
    quiet: 'text-mid hover:bg-ink-3 hover:text-white',
  }[variant];
  const s = size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm';
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-[color,background-color,border-color,transform,box-shadow] duration-100 disabled:cursor-not-allowed disabled:opacity-40 ${s} ${v} ${className}`}
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/** Segmented control for tabs and filters (replaces ad-hoc pill rows). */
export function Segmented({ value, onChange, options, label }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-control border border-line bg-ink-2 p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={`rounded-[2px] px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
            value === v ? 'bg-lime text-ink' : 'text-mid hover:text-white'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="label mb-1.5 block">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-mid">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-coral">{error}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-control border border-line-strong bg-ink px-3.5 py-2.5 text-sm text-white placeholder:text-mid/70 outline-none transition-colors focus:border-lime';

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="flex flex-col items-start rounded-panel border border-dashed border-line-strong px-6 py-10">
      {Icon && <Icon className="mb-4 h-6 w-6 text-mid" aria-hidden />}
      <div className="t-section">{title}</div>
      {children && <div className="mt-1.5 max-w-lg text-sm text-mid">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'loading' }) {
  return (
    <div className="flex items-center gap-3 py-10 text-mid" role="status">
      <Loader2 className="h-4 w-4 animate-spin text-lime" aria-hidden />
      <span className="font-mono text-xs uppercase tracking-widest">{label}…</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  if (!error) return null;
  return (
    <div role="alert" className="mb-4 flex items-start gap-3 rounded-panel border border-coral/40 bg-coral/[0.07] p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral" aria-hidden />
      <div className="flex-1">
        <div className="font-mono text-xs font-semibold uppercase tracking-wider text-coral">{error.code || 'Error'}</div>
        <div className="mt-0.5 text-white/80">{error.message}</div>
        {Array.isArray(error.details) && (
          <ul className="mt-1 list-disc pl-5 text-white/70">
            {error.details.slice(0, 5).map((d, i) => (
              <li key={i}>{d.path ? `${d.path}: ` : ''}{d.message || JSON.stringify(d)}</li>
            ))}
          </ul>
        )}
      </div>
      {onRetry && (
        <button onClick={onRetry} className="font-mono text-xs uppercase text-coral underline underline-offset-4">
          retry
        </button>
      )}
    </div>
  );
}

/** Adds .value-changed for one cycle when `value` changes after the first render. */
export function useChangedClass(value) {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (prev.current === value) return undefined;
    prev.current = value;
    setCls('value-changed');
    const t = setTimeout(() => setCls(''), 950);
    return () => clearTimeout(t);
  }, [value]);
  return cls;
}

/** A number that marks itself when the underlying data changes. */
export function Numeral({ value, className = '' }) {
  const changed = useChangedClass(value);
  return <span className={`numeral ${changed} ${className}`}>{value}</span>;
}

export function Stat({ label, value, sub, tone = 'default', className = '' }) {
  const dark = tone === 'lime' || tone === 'white';
  return (
    <Card tone={tone} className={`flex flex-col justify-between ${className}`}>
      <div className={`label ${dark ? '!text-ink/60' : ''}`}>{label}</div>
      <div className="mt-6 text-[40px] md:text-[48px]">
        <Numeral value={value} />
      </div>
      {sub && <div className={`mt-3 text-xs ${dark ? 'text-ink/70' : 'text-mid'}`}>{sub}</div>}
    </Card>
  );
}

export function Modal({ open, onClose, title, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={onClose}>
      <div
        className="enter max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-panel border border-line-strong bg-ink-2 p-6 scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="mb-5 flex items-center justify-between border-b border-line pb-4">
          <h2 className="t-section">{title}</h2>
          <button onClick={onClose} className="rounded-control p-1.5 text-mid hover:bg-ink-3 hover:text-white" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function KV({ k, children, mono }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-0">
      <span className="label shrink-0">{k}</span>
      <span className={`min-w-0 text-right text-sm ${mono ? 'font-mono text-[13px]' : ''}`}>{children}</span>
    </div>
  );
}

/** Small "stale data" chip shown next to timestamps. */
export function Freshness({ at, staleAfterSec = 90, now = Date.now() }) {
  if (!at) return <span className="font-mono text-[11px] uppercase text-mid">never</span>;
  const age = (now - new Date(at).getTime()) / 1000;
  const stale = age > staleAfterSec;
  return (
    <span className={`font-mono text-[11px] ${stale ? 'text-amber' : 'text-mid'}`} title={new Date(at).toLocaleString()}>
      {age < 60 ? `${Math.max(0, Math.round(age))}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`} ago
      {stale && ' · stale'}
    </span>
  );
}

/** Indeterminate bar, rendered only while a real operation is in flight. */
export function Running({ label }) {
  return (
    <div className="flex items-center gap-3" role="status">
      <div className="progress-run h-0.5 w-24 rounded bg-charcoal" />
      <span className="font-mono text-[11px] uppercase tracking-wider text-mid">{label}</span>
    </div>
  );
}
