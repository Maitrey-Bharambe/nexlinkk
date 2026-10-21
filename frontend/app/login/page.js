'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { post, setCsrfToken } from '@/lib/api';
import { Button, ErrorState, Field, inputCls } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({ displayName: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const signup = mode === 'signup';

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
      router.replace(signup ? '/setup' : '/');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen gap-4 p-4 lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden rounded-blob bg-lime p-10 text-ink lg:flex">
        <div className="label !text-ink/60">electric lime · #C7FF2E</div>
        <div>
          <div className="text-[110px] font-bold leading-[0.85] tracking-tighter">
            your
            <br />
            network,
            <br />
            <span className="italic">no cap.</span>
          </div>
          <p className="mt-8 max-w-md text-lg font-medium text-ink/75">
            wireguard tunnels, honest telemetry, and diagnostics that show their receipts. nothing marked connected until a handshake says so.
          </p>
        </div>
        <div className="flex gap-3 font-mono text-xs uppercase">
          <span className="rounded-full bg-ink px-3 py-1 text-lime">control plane</span>
          <span className="rounded-full border border-ink/30 px-3 py-1">data plane ≠ http</span>
        </div>
      </div>

      <div className="flex items-center justify-center rounded-blob border border-charcoal bg-ink-2/75 p-8 backdrop-blur-md">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="mb-6">
            <Image src="/logo-full.png" alt="NexLink — secure networks, intelligent operations" width={900} height={717} priority className="mb-6 h-auto w-52" />
            <div className="mb-6 inline-flex rounded-full border border-charcoal p-1" role="tablist">
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
                  className={`rounded-full px-5 py-1.5 text-sm font-semibold transition-colors ${mode === m ? 'bg-lime text-ink' : 'text-mid hover:text-white'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <h1 className="text-4xl font-bold lowercase">
              {signup ? 'create account' : 'sign in'}
              <span className="text-lime">.</span>
            </h1>
            <p className="mt-2 text-sm text-mid">
              {signup ? 'then register this pc to your own private network.' : 'operators only. sessions use an http-only cookie.'}
            </p>
          </div>

          {signup && (
            <Field label="your name">
              <input className={inputCls} autoComplete="name" required maxLength={80} value={form.displayName} onChange={set('displayName')} />
            </Field>
          )}
          <Field label="email">
            <input className={inputCls} type="email" autoComplete={signup ? 'email' : 'username'} required value={form.email} onChange={set('email')} />
          </Field>
          <Field label="password" hint={signup ? 'at least 12 characters' : undefined}>
            <input
              className={inputCls}
              type="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              required
              minLength={signup ? 12 : 1}
              value={form.password}
              onChange={set('password')}
            />
          </Field>
          {signup && (
            <Field label="confirm password">
              <input className={inputCls} type="password" autoComplete="new-password" required minLength={12} value={form.confirm} onChange={set('confirm')} />
            </Field>
          )}
          <ErrorState error={error} />
          <Button type="submit" busy={busy} className="w-full py-3.5">
            {signup ? 'create account' : 'let me in'} <ArrowRight className="h-4 w-4" />
          </Button>
          <p className="text-center text-xs text-mid">
            {signup ? 'already have an account? ' : 'new here? '}
            <button type="button" onClick={() => switchMode(signup ? 'signin' : 'signup')} className="font-semibold text-lime underline">
              {signup ? 'sign in' : 'create an account'}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
