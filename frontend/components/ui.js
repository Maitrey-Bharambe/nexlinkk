'use client';

import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useEffect } from 'react';

export function PageHeader({ kicker, title, children }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {kicker && <div className="label mb-2">{kicker}</div>}
        <h1 className="text-4xl font-bold tracking-tight lowercase md:text-5xl">
          {title}
          <span className="text-lime">.</span>
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const CARD_TONES = {
  default: 'bg-ink-2 border border-charcoal',
  lime: 'bg-lime text-ink',
  white: 'bg-white text-ink',
  charcoal: 'bg-charcoal',
};

export function Card({ tone = 'default', className = '', children, label, action }) {
  return (
    <section className={`rounded-blob p-6 ${CARD_TONES[tone]} ${className}`}>
      {(label || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {label && <div className={`label ${tone === 'lime' || tone === 'white' ? '!text-ink/60' : ''}`}>{label}</div>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = 'lime', className = '', busy, children, ...props }) {
  const v = {
    lime: 'bg-lime text-ink hover:bg-white',
    white: 'bg-white text-ink hover:bg-lime',
    ghost: 'border border-charcoal text-white hover:border-lime hover:text-lime',
    danger: 'border border-coral/50 text-coral hover:bg-coral hover:text-ink',
  }[variant];
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${v} ${className}`}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
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
  'w-full rounded-2xl border border-charcoal bg-ink px-4 py-3 text-sm text-white placeholder:text-mid/70 outline-none focus:border-lime';

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="hatch flex flex-col items-center justify-center rounded-blob border border-dashed border-charcoal px-6 py-14 text-center">
      {Icon && <Icon className="mb-4 h-8 w-8 text-mid" />}
      <div className="text-lg font-semibold lowercase">{title}</div>
      {children && <div className="mt-2 max-w-md text-sm text-mid">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'loading' }) {
  return (
    <div className="flex items-center gap-3 py-10 text-mid">
      <Loader2 className="h-5 w-5 animate-spin text-lime" />
      <span className="font-mono text-xs uppercase tracking-widest">{label}…</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-coral/40 bg-coral/10 p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral" />
      <div className="flex-1">
        <div className="font-semibold text-coral">{error.code || 'Error'}</div>
        <div className="text-white/80">{error.message}</div>
        {Array.isArray(error.details) && (
          <ul className="mt-1 list-disc pl-5 text-white/70">
            {error.details.slice(0, 5).map((d, i) => (
              <li key={i}>{d.path ? `${d.path}: ` : ''}{d.message || JSON.stringify(d)}</li>
            ))}
          </ul>
        )}
      </div>
      {onRetry && (
        <button onClick={onRetry} className="font-mono text-xs uppercase text-coral underline">
          retry
        </button>
      )}
    </div>
  );
}

export function Stat({ label, value, sub, tone = 'default', className = '' }) {
  const dark = tone === 'lime' || tone === 'white';
  return (
    <Card tone={tone} className={`flex flex-col justify-between ${className}`}>
      <div className={`label ${dark ? '!text-ink/60' : ''}`}>{label}</div>
      <div className="mt-6 text-6xl font-bold leading-none tracking-tighter md:text-7xl">{value}</div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-blob border border-charcoal bg-ink-2 p-7" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-2xl font-bold lowercase">{title}</h2>
          <button onClick={onClose} className="rounded-full p-1.5 text-mid hover:bg-charcoal hover:text-white" aria-label="Close">
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
    <div className="flex items-baseline justify-between gap-4 border-b border-charcoal/70 py-2.5 last:border-0">
      <span className="label">{k}</span>
      <span className={`text-right text-sm ${mono ? 'font-mono' : ''}`}>{children}</span>
    </div>
  );
}

/** Small "stale data" chip shown next to timestamps. */
export function Freshness({ at, staleAfterSec = 90, now = Date.now() }) {
  if (!at) return <span className="font-mono text-[11px] uppercase text-mid">never</span>;
  const age = (now - new Date(at).getTime()) / 1000;
  const stale = age > staleAfterSec;
  return (
    <span className={`font-mono text-[11px] ${stale ? 'text-coral' : 'text-mid'}`} title={new Date(at).toLocaleString()}>
      {age < 60 ? `${Math.max(0, Math.round(age))}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`} ago
      {stale && ' · stale'}
    </span>
  );
}
