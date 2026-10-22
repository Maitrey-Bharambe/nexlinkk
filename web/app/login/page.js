'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Brain, Eye, EyeOff, Lock, Mail, Share2, User, Zap } from 'lucide-react';
import { post, setCsrfToken } from '@/lib/api';
import { ErrorState } from '@/components/ui';
import { HEALTH_LABEL, useHealth } from '@/hooks/useHealth';
const VERSION = `v${process.env.NEXT_PUBLIC_APP_VERSION}`;

const PILLARS = [
  [Lock, 'end-to-end encrypted'],
  [Share2, 'peer-to-peer connectivity'],
  [Brain, 'ai-powered diagnostics'],
  [Zap, 'approved recovery'],
];

/** Pixel step meter; `on` says how many steps are lit. */
function Meter({ on = 4, total = 5, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`h-2 w-2 ${i < on ? 'bg-lime' : 'bg-white/25'}`} />
      ))}
    </span>
  );
}

function IconField({ id, label, icon: Icon, hint, children, trailing }) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block font-mono text-[12px] uppercase tracking-[0.12em] text-white/80">
        {label}
      </label>
      <div className="flex border border-line bg-ink/80 transition-colors focus-within:border-lime">
        <span className="flex w-11 shrink-0 items-center justify-center text-white/50" aria-hidden>
          <Icon className="h-4 w-4" />
        </span>
        {children}
        {trailing}
      </div>
      {hint && <p className="mt-1.5 font-mono text-[11px] text-white/50">{hint}</p>}
    </div>
  );
}

const fieldCls = 'h-12 min-w-0 flex-1 bg-transparent pr-3 font-mono text-[14px] text-white outline-none placeholder:text-white/35';

export default function LoginPage() {
  const router = useRouter();
  const health = useHealth();
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({ displayName: '', email: '', password: '', confirm: '' });
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const signup = mode === 'signup';
  // The landing page's "get started" opens straight on the sign-up tab.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('mode') === 'signup') setMode('signup');
  }, []);

  function switchMode(m) {
    setMode(m);
    setError(null);
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (signup && form.password !== form.confirm) {
      setError({ code: 'PASSWORD_MISMATCH', message: 'Passwords do not match' });
      return;
    }
    setBusy(true);
    try {
      const d = signup
        ? await post('/auth/signup', { displayName: form.displayName, email: form.email, password: form.password })
        : await post('/auth/login', { email: form.email, password: form.password });
      setCsrfToken(d.csrfToken);
      // New accounts go straight to registering the PC they are on.
      // Return to the page that sent us here; same-origin paths only (no open redirect).
      const next = new URLSearchParams(window.location.search).get('next') || '';
      const safeNext = /^\/(?!\/)[\w\-/?=&%.]*$/.test(next) ? next : null;
      router.replace(safeNext || (signup ? '/setup' : '/'));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const [dot, healthText] = HEALTH_LABEL[health];
  const eye = (
    <button
      type="button"
      onClick={() => setShowPw((v) => !v)}
      className="flex w-12 shrink-0 items-center justify-center border-l border-line text-white/60 hover:text-lime"
      aria-label={showPw ? 'Hide password' : 'Show password'}
      aria-pressed={showPw}
    >
      {showPw ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
    </button>
  );

  return (
    <div className="backdrop-photo flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-[1520px] flex-1 flex-col px-4 md:px-12">
        {/* ── top row: brand + tagline ─────────────────────────── */}
        <header className="flex items-stretch justify-between gap-4">
          <Link href="/welcome" className="flex items-center gap-3 border-x border-b border-line bg-ink/80 px-5 py-4 backdrop-blur-md md:px-7 md:py-6" aria-label="NexLink home">
            <Image src="/logo-mark.png" alt="" width={48} height={48} priority className="h-10 w-10 md:h-12 md:w-12" />
            <span>
              <span className="block font-pixel text-[16px] uppercase leading-none md:text-[22px]">nexlink</span>
              <span className="mt-2 hidden font-mono text-[11px] uppercase leading-snug tracking-wider text-white/70 sm:block">
                secure networks.
                <br />
                intelligent operations.
              </span>
            </span>
          </Link>
          <div className="hidden items-center gap-6 border-x border-b border-line bg-ink/60 px-7 py-5 backdrop-blur-md md:flex">
            <p className="font-mono text-[12px] uppercase leading-relaxed tracking-wider text-white/75">
              private networking
              <br />
              for a more
              <br />
              connected world.
            </p>
            <span className="flex items-end gap-1" aria-hidden>
              {[2, 3, 4].map((h, i) => (
                <span key={i} className="flex flex-col gap-1">
                  {Array.from({ length: h }, (_, j) => (
                    <span key={j} className="h-1.5 w-1.5 bg-lime" />
                  ))}
                </span>
              ))}
            </span>
          </div>
        </header>

        {/* ── main: pitch + auth card ───────────────────────────── */}
        <main className="grid flex-1 grid-cols-[minmax(0,1fr)] items-center gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)] lg:py-12">
          <section aria-label="About NexLink" className="hidden lg:block">
            <h1 className="font-pixel text-[40px] uppercase leading-[1.25] xl:text-[54px]">
              <span className="block">your</span>
              <span className="block">network,</span>
              <span className="block text-lime">no cap.</span>
            </h1>
            <p className="mt-8 max-w-md font-mono text-[15px] leading-relaxed text-white/80">
              Encrypted tunnels. Real-time insights. AI-powered diagnostics. Secure access between your devices — anywhere.
            </p>
            <ul className="mt-9 space-y-4">
              {PILLARS.map(([Icon, t]) => (
                <li key={t} className="flex items-center gap-4 font-mono text-[13px] uppercase tracking-wider text-white/85">
                  <Icon className="h-6 w-6 text-lime" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="auth-title" className="relative border border-line bg-ink/85 p-6 backdrop-blur-md sm:p-10">
            {/* lime corner brackets */}
            <span aria-hidden className="absolute -left-px -top-px h-6 w-6 border-l-4 border-t-4 border-lime" />
            <span aria-hidden className="absolute -bottom-px -right-px h-6 w-6 border-b-4 border-r-4 border-lime" />
            <span aria-hidden className="absolute -bottom-px -left-px h-6 w-6 border-b-4 border-l-4 border-lime" />

            <div className="mb-5 flex items-center justify-end gap-2 font-mono text-[11px] text-white/55">
              {VERSION} <Meter on={3} total={4} />
            </div>

            <div className="font-mono text-[13px] uppercase tracking-[0.12em] text-white/85">welcome to</div>
            <h2 id="auth-title" className="mt-3 font-pixel text-[30px] uppercase leading-none sm:text-[40px]">
              nexlink<span className="text-lime">.</span>
            </h2>
            <p className="mt-5 font-mono text-[13.5px] leading-relaxed text-white/70">
              {signup
                ? 'Create an account, then register this computer to your own private network.'
                : 'Sign in to manage your private networks, devices, and intelligent operations.'}
            </p>

            <div className="mt-7 grid grid-cols-2 border border-line" role="tablist" aria-label="Sign in or sign up">
              {[
                ['signin', 'sign in'],
                ['signup', 'sign up'],
              ].map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => switchMode(m)}
                  className={`h-12 font-mono text-[14px] uppercase tracking-wider transition-colors ${mode === m ? 'bg-lime font-medium text-ink' : 'text-white/85 hover:text-lime'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="mt-7 space-y-5">
              {signup && (
                <IconField id="displayName" label="your name" icon={User}>
                  <input id="displayName" className={fieldCls} autoComplete="name" required maxLength={80} value={form.displayName} onChange={set('displayName')} placeholder="Ada Lovelace" />
                </IconField>
              )}
              <IconField id="email" label="email" icon={Mail}>
                <input id="email" className={fieldCls} type="email" autoComplete={signup ? 'email' : 'username'} required value={form.email} onChange={set('email')} placeholder="you@domain.com" />
              </IconField>
              <IconField id="password" label="password" icon={Lock} hint={signup ? 'at least 12 characters' : undefined} trailing={eye}>
                <input
                  id="password"
                  className={fieldCls}
                  type={showPw ? 'text' : 'password'}
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  required
                  minLength={signup ? 12 : 1}
                  value={form.password}
                  onChange={set('password')}
                  placeholder="••••••••••••"
                />
              </IconField>
              {signup && (
                <IconField id="confirm" label="confirm password" icon={Lock}>
                  <input id="confirm" className={fieldCls} type={showPw ? 'text' : 'password'} autoComplete="new-password" required minLength={12} value={form.confirm} onChange={set('confirm')} placeholder="••••••••••••" />
                </IconField>
              )}

              <ErrorState error={error} />

              <button
                type="submit"
                disabled={busy}
                className="flex h-12 w-full items-center justify-center gap-2 border border-lime bg-lime font-mono text-[15px] font-medium uppercase tracking-wider text-ink transition-[transform,box-shadow,opacity] hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_0_#fff] disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-none"
              >
                {busy ? (signup ? 'creating account…' : 'signing in…') : signup ? 'create account' : 'sign in'}
                {!busy && <ArrowRight className="h-4 w-4" aria-hidden />}
              </button>
            </form>

            <p className="mt-8 text-center font-mono text-[13px] text-white/75">
              {signup ? 'Already have an account? ' : 'New here? '}
              <button type="button" onClick={() => switchMode(signup ? 'signin' : 'signup')} className="inline-flex items-center gap-1 text-lime underline underline-offset-4 hover:no-underline">
                {signup ? 'Sign in' : 'Create an account'} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </p>
            <p className="mt-3 text-center font-mono text-[11px] text-white/45">Sessions use an http-only cookie. Operators only.</p>
          </section>
        </main>

        {/* ── status bar ──────────────────────────────────────── */}
        <footer className="mb-4 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4 md:mb-6">
          <span className="flex items-center gap-3 border border-line bg-ink/80 px-4 py-2.5 font-mono text-[12px] uppercase tracking-wider text-white/85" role="status" title="GET /healthz on this server">
            <span className={`h-2.5 w-2.5 ${dot}`} aria-hidden />
            {healthText}
            <Meter on={health === 'online' ? 3 : health === 'offline' ? 0 : 1} total={5} className="ml-3" />
          </span>
          <span className="hidden gap-8 font-mono text-[12px] uppercase tracking-wider text-white/70 md:flex">
            <span>[ control plane ]</span>
            <span>[ data plane ]</span>
            <span>[ encrypted tunnels ]</span>
          </span>
          <span className="flex items-center gap-3 font-mono text-[12px] text-white/60">
            {VERSION} <Meter on={3} total={5} />
          </span>
        </footer>
      </div>
    </div>
  );
}
