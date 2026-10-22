'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, KeyRound, ShieldCheck, X } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { Button, ErrorState, Field, inputCls } from '@/components/ui';
import { api, post } from '@/lib/api';
import { OSES, guessOs } from '@/lib/join';
import { timeAgo } from '@/lib/format';
import { CopyButton } from './JoinInstructions';

/** The same line for every computer: no token, nothing secret to share. */
export function universalLine(origin, os) {
  return os === 'unix' ? `curl -fsSL '${origin}/join.sh' | sh` : `irm '${origin}/join.ps1' | iex`;
}

export function UniversalCommand() {
  const [os, setOs] = useState('windows');
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setOs(guessOs());
    setOrigin(window.location.origin);
    fetch('/api/v1/meta', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => j?.data?.publicUrl && setOrigin(j.data.publicUrl))
      .catch(() => {});
  }, []);
  if (!origin) return null;
  const line = universalLine(origin, os);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-control border border-line bg-ink p-0.5" role="tablist" aria-label="Operating system">
        {OSES.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={os === k}
            onClick={() => setOs(k)}
            className={`rounded-[2px] px-3 py-1.5 text-xs font-semibold transition-colors ${os === k ? 'bg-lime text-ink' : 'text-mid hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-sm text-white/75">
        {os === 'windows' ? 'open PowerShell on that computer (no admin needed), paste, press Enter:' : 'open a terminal on that computer (no sudo needed), paste, press Enter:'}
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-control border border-line bg-ink p-3.5 font-mono text-[13px] text-lime">{line}</pre>
      <CopyButton text={line} label="copy command" className="w-full" />
      <p className="text-xs text-mid">
        the same line works for every computer and contains no secret. it installs the agent, creates the computer&apos;s own keys and shows a short code.
        {local && <span className="text-amber"> this portal is open as localhost: other computers need its real address.</span>}
      </p>
    </div>
  );
}

const fmt = (raw) => {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

/**
 * Enter the code a computer shows, see exactly which computer asked, choose
 * name and network, approve. The device is enrolled the moment you approve.
 */
export function ApproveCode({ initialCode = '', defaultNetworkId = '', onApproved }) {
  const [code, setCode] = useState(fmt(initialCode));
  const [found, setFound] = useState(null);
  const [name, setName] = useState('');
  const [networkId, setNetworkId] = useState(defaultNetworkId);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const { data: networks } = useApi('/networks');

  async function lookup(c = code) {
    setBusy('lookup');
    setError(null);
    setFound(null);
    try {
      const d = await api(`/device-codes/${encodeURIComponent(c)}`);
      setFound(d);
      setName(d.suggestedName);
    } catch (err) {
      setError(err.status === 404 ? { code: 'CODE_NOT_FOUND', message: 'No computer is waiting with that code. Codes expire after 15 minutes — run the command again for a new one.' } : err);
    } finally {
      setBusy(null);
    }
  }
  useEffect(() => {
    if (initialCode && fmt(initialCode).length === 9) lookup(fmt(initialCode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!networkId && networks?.length) setNetworkId(defaultNetworkId || networks[0].id);
  }, [networks, networkId, defaultNetworkId]);

  async function decide(kind) {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'approve') {
        const r = await post(`/device-codes/${encodeURIComponent(found.userCode)}/approve`, { deviceName: name, ...(networkId ? { networkId } : {}) });
        setDone(r);
        onApproved?.(r);
      } else {
        await post(`/device-codes/${encodeURIComponent(found.userCode)}/deny`, {});
        setFound(null);
        setCode('');
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <div className="rounded-panel border border-lime/40 bg-lime/[0.05] p-4" role="status">
        <div className="flex items-center gap-2 font-semibold">
          <Check className="h-4 w-4 text-lime" aria-hidden /> {done.device.name} is enrolled in {done.network.name}
        </div>
        <p className="mt-1 text-sm text-white/70">
          virtual ip <span className="font-mono text-white">{done.device.membership?.address}</span>. the computer picks this up within a few seconds and
          starts its tunnel. enrolled is not yet connected: connectivity shows once a WireGuard handshake is observed.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/devices/${done.device.id}`}><Button size="sm" variant="white">open device</Button></Link>
          <Button size="sm" variant="ghost" onClick={() => { setDone(null); setFound(null); setCode(''); }}>approve another</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          lookup();
        }}
        className="flex gap-2"
      >
        <label className="sr-only" htmlFor="device-code">code shown on the computer</label>
        <input
          id="device-code"
          className={`${inputCls} max-w-[220px] text-center font-mono text-lg uppercase tracking-[0.25em]`}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(fmt(e.target.value))}
        />
        <Button type="submit" busy={busy === 'lookup'} disabled={code.length !== 9}>
          <KeyRound className="h-4 w-4" aria-hidden /> find
        </Button>
      </form>
      <ErrorState error={error} />

      {found && (
        <div className="rounded-panel border border-line bg-ink p-4">
          <div className="label mb-3">a computer asked to join</div>
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1.5 text-sm">
            <dt className="text-mid">computer</dt><dd className="font-medium">{found.hostname}</dd>
            <dt className="text-mid">system</dt><dd>{found.platform} · agent {found.agentVersion}</dd>
            <dt className="text-mid">identity key</dt><dd className="truncate font-mono text-xs" title={found.identityFingerprint}>{found.identityFingerprint}</dd>
            <dt className="text-mid">asked from</dt><dd className="font-mono text-xs">{found.requestedFrom || 'unknown'} · {timeAgo(found.createdAt)}</dd>
          </dl>
          <p className="mt-3 flex gap-2 text-xs text-amber">
            <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
            approve only a code you got from the person at that computer. anyone who can run the command can ask; nothing joins until you approve.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="device name">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={64} pattern="[\w .\-]+" />
            </Field>
            <Field label="network" hint={networks?.length ? undefined : 'a private network is created for you'}>
              <select className={inputCls} value={networkId} onChange={(e) => setNetworkId(e.target.value)} disabled={!networks?.length}>
                {!networks?.length && <option value="">new private network</option>}
                {networks?.map((n) => <option key={n.id} value={n.id}>{n.name} · {n.cidr}</option>)}
              </select>
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button busy={busy === 'approve'} disabled={Boolean(busy) || name.trim().length < 2} onClick={() => decide('approve')}>
              <Check className="h-4 w-4" aria-hidden /> approve & enroll
            </Button>
            <Button variant="ghost" busy={busy === 'deny'} disabled={Boolean(busy)} onClick={() => decide('deny')}>
              <X className="h-4 w-4" aria-hidden /> deny
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
