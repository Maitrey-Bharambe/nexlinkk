'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Link2, MonitorSmartphone } from 'lucide-react';
import { Button } from '@/components/ui';
import { OSES, copyText, guessOs, inviteLink, joinLine } from '@/lib/join';

export function CopyButton({ text, label, className = '', variant = 'white' }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant={variant}
      className={className}
      onClick={async () => {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'copied' : label}
    </Button>
  );
}

const SHARES = [
  ['', 'nothing'],
  ['rdp', 'remote desktop'],
  ['ssh', 'ssh'],
  ['rdp,ssh', 'both'],
];

/**
 * The one line that connects a computer, for Windows or macOS/Linux, plus
 * (for operators) an invite link to send to whoever sits at that computer.
 * `allowShareChoice` lets the person running it decide what to share for
 * remote sessions; nothing is shared unless they pick it.
 */
export default function JoinInstructions({ token, deviceId, deviceName, expiresAt, share: initialShare = '', showInvite = true, allowShareChoice = true }) {
  const [os, setOs] = useState('windows');
  const [share, setShare] = useState(initialShare);
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setOs(guessOs());
    setOrigin(window.location.origin);
    // A configured public address beats whatever address this browser used.
    fetch('/api/v1/meta', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => j?.data?.publicUrl && setOrigin(j.data.publicUrl))
      .catch(() => {});
  }, []);
  if (!origin) return null;

  const line = joinLine({ origin, token, deviceId, share, os });
  const invite = inviteLink({ origin, token, deviceId, name: deviceName, share, expiresAt });
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-control border border-line bg-ink-2 p-0.5" role="tablist">
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
        {allowShareChoice && (
          <label className="ml-auto flex items-center gap-2 text-xs text-mid">
            <MonitorSmartphone className="h-4 w-4" /> allow remote sessions to it:
            <select className="rounded-control border border-line bg-ink px-2.5 py-1.5 text-xs text-white" value={share} onChange={(e) => setShare(e.target.value)}>
              {SHARES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <ol className="space-y-1 text-sm text-white/80">
        {os === 'windows' ? (
          <>
            <li><span className="font-mono text-lime">1</span>&nbsp; open <b className="text-white">PowerShell</b> (Start → type powershell → Enter) — no admin needed</li>
            <li><span className="font-mono text-lime">2</span>&nbsp; paste this line and press <b className="text-white">Enter</b>; keep the window open</li>
          </>
        ) : (
          <>
            <li><span className="font-mono text-lime">1</span>&nbsp; open a <b className="text-white">terminal</b> — no sudo needed</li>
            <li><span className="font-mono text-lime">2</span>&nbsp; paste this line and press <b className="text-white">Enter</b>; keep it running</li>
          </>
        )}
      </ol>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-panel border border-line bg-ink p-4 font-mono text-xs leading-relaxed text-lime scrollbar-thin">{line}</pre>
      <CopyButton text={line} label="copy command" className="w-full" />

      {showInvite && (
        <div className="rounded-panel border border-dashed border-line p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Link2 className="h-4 w-4 text-lime" /> not at that computer? send this invite link instead
          </div>
          <p className="mb-3 text-xs text-mid">
            whoever opens it gets the right command for their system. it works from any network — home, office, mobile hotspot — no VPN app, no
            port forwarding. the token sits after the <span className="font-mono">#</span>, which browsers never send to a server.
          </p>
          <div className="mb-3 break-all rounded-control bg-ink p-3 font-mono text-[11px] text-white/70">{invite}</div>
          <CopyButton text={invite} label="copy invite link" variant="ghost" className="w-full" />
          {local && (
            <p className="mt-3 text-xs text-coral">
              this portal is open as localhost, so the link only works on this computer. open the portal by its public address (or set PUBLIC_URL)
              before inviting someone else.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
