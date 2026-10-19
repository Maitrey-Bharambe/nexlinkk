'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Check, Copy, Download, Laptop, Loader2 } from 'lucide-react';
import { useApi, useNow } from '@/hooks/useApi';
import { Button, Card, ErrorState, Field, PageHeader, inputCls } from '@/components/ui';
import StatusBadge from '@/components/StatusBadge';
import { post } from '@/lib/api';

function guessPlatform() {
  if (typeof navigator === 'undefined') return 'other';
  const p = `${navigator.userAgentData?.platform || ''} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  if (p.includes('linux')) return 'linux';
  return 'other';
}

const DEFAULT_NAME = { windows: 'my-windows-pc', mac: 'my-mac', linux: 'my-linux-pc', other: 'my-pc' };

const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1';

/**
 * Commands for the PC being registered. When the portal is opened from
 * another PC on the LAN, the server address is this page's host and plain
 * http needs --allow-http. --userspace runs the tunnel inside the agent, so
 * no WireGuard app and no Administrator rights are required.
 */
function commandsFor(platform, server, host) {
  const flags = isLocalHost(host) ? '' : ' --allow-http';
  if (platform === 'windows') {
    return [
      '# PowerShell, in the folder you downloaded nexlink-agent.exe to (e.g. Downloads)',
      'cd $HOME\\Downloads',
      `.\\nexlink-agent.exe enroll --server ${server}${flags}`,
      `.\\nexlink-agent.exe run --userspace${flags}`,
    ];
  }
  return [
    '# build the agent from the repository (Go 1.22+): cd networking-agent && go build -o nexlink-agent ./cmd/nexlink-agent',
    `./nexlink-agent enroll --server ${server}${flags}`,
    `./nexlink-agent run --userspace${flags}`,
  ];
}

/** Waits for the agent to complete enrollment — the only thing that makes a PC "registered". */
function WaitForAgent({ deviceId }) {
  const { data: d } = useApi(`/devices/${deviceId}`, { events: ['device:update'], pollMs: 3000 });
  if (!d || d.enrollmentState === 'pending') {
    return (
      <Card tone="charcoal" label="step 3 · waiting for this pc">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-lime" />
          <span className="text-sm text-white/80">waiting for the agent to enroll with the token…</span>
        </div>
        <p className="mt-3 text-xs text-white/50">this page updates on its own. nothing is registered until the agent proves it holds its own key.</p>
      </Card>
    );
  }
  return (
    <Card tone="lime" label="registered">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-ink text-lime">
          <Check className="h-5 w-5" />
        </span>
        <div>
          <div className="text-2xl font-bold">{d.name} is in.</div>
          <div className="font-mono text-sm text-ink/70">virtual ip {d.membership?.address || '—'} · {d.identityFingerprint?.slice(0, 20)}…</div>
        </div>
      </div>
      <p className="mt-4 text-sm text-ink/70">
        enrolled ≠ connected: the tunnel shows as connected only after WireGuard reports a handshake with another device.
      </p>
      <div className="mt-5 flex gap-2">
        <Link href={`/devices/${d.id}`}><Button variant="white">open device</Button></Link>
        <Link href="/"><Button variant="ghost" className="!border-ink/30 !text-ink">overview</Button></Link>
      </div>
    </Card>
  );
}

export default function SetupPage() {
  const now = useNow(1000);
  const [platform, setPlatform] = useState('other');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const p = guessPlatform();
    setPlatform(p);
    setName((n) => n || DEFAULT_NAME[p]);
  }, []);

  async function register(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await post('/onboarding/register-device', { deviceName: name }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const server = typeof window !== 'undefined' ? `${window.location.protocol}//${host}:4000` : '';
  const secondsLeft = result ? Math.max(0, Math.round((new Date(result.enrollment.expiresAt) - now) / 1000)) : 0;

  return (
    <div className="max-w-3xl">
      <PageHeader kicker="onboarding" title="register this pc" />

      {!result ? (
        <Card label="step 1 · name it">
          <form onSubmit={register} className="space-y-4">
            <div className="flex items-center gap-3 text-sm text-white/80">
              <Laptop className="h-5 w-5 text-lime" />
              detected: <StatusBadge state="configured" label={platform} />
            </div>
            <Field label="device name" hint="how this computer shows up in your network">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={64} pattern="[\w .\-]+" />
            </Field>
            <ErrorState error={error} />
            <Button type="submit" busy={busy}>register this pc</Button>
            <p className="text-xs text-mid">
              if you don&apos;t have a network yet, a private one with a free 10.x.0.0/24 range is created for you.
            </p>
          </form>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card label={`step 2 · run the agent on this pc${result.createdNetwork ? ` · new network ${result.network.name} (${result.network.cidr})` : ` · network ${result.network.name}`}`}>
            <div className="rounded-2xl bg-lime p-4 text-ink">
              <div className="label !text-ink/60 mb-2">
                one-time token · {secondsLeft > 0 ? `expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'expired — register again'}
              </div>
              <div className="break-all font-mono text-sm">{result.enrollment.token}</div>
            </div>
            <Button
              variant="white"
              className="mt-3 w-full"
              onClick={async () => {
                await navigator.clipboard.writeText(result.enrollment.token);
                setCopied(true);
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'copied' : 'copy token'}
            </Button>
            {platform === 'windows' && (
              <a
                href="/downloads/nexlink-agent.exe"
                download
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-lime px-5 py-2.5 text-sm font-semibold text-ink hover:bg-white"
              >
                <Download className="h-4 w-4" /> download agent for Windows (nexlink-agent.exe)
              </a>
            )}
            <pre className="mt-4 overflow-x-auto rounded-2xl border border-charcoal bg-ink p-4 font-mono text-xs leading-relaxed text-lime scrollbar-thin">
              {commandsFor(platform, server, host).join('\n')}
            </pre>
            <p className="mt-3 text-xs text-mid">
              paste the token when <span className="font-mono text-white">enroll</span> asks for it. the agent makes its own keys — private keys never leave this pc.
              <span className="font-mono text-white"> run --userspace</span> carries the WireGuard tunnel inside the agent: no WireGuard app and no admin rights needed.
              keep that window open (or install it as a service). if Windows asks about network access, allow it on private networks.
            </p>
          </Card>
          <WaitForAgent deviceId={result.device.id} />
        </div>
      )}
    </div>
  );
}
