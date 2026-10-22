'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { Lock, Globe, KeyRound } from 'lucide-react';
import JoinInstructions from '@/features/devices/JoinInstructions';
import { parseInvite } from '@/lib/join';

/**
 * /join#t=<token>&d=<device>&n=<name> — the page an operator's invite link
 * opens. No account needed: it only shows the one command for this computer.
 * The token is read from the URL fragment, which never leaves this browser.
 */
export default function JoinPage() {
  const [invite, setInvite] = useState(undefined);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setInvite(parseInvite(window.location.hash));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = invite?.expiresAt ? Math.max(0, Math.round((invite.expiresAt - now) / 1000)) : null;

  return (
    <div className="backdrop-photo mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 p-4 md:p-8">
      <Image src="/logo-full.png" alt="NexLink" width={900} height={717} priority className="h-auto w-40" />
      {invite === undefined ? null : !invite ? (
        <section className="rounded-blob border border-line bg-ink-2 p-8">
          <h1 className="t-title">invite link incomplete<span className="text-lime">.</span></h1>
          <p className="mt-3 text-sm text-mid">copy the whole link again (everything after the #), or ask for a new invite.</p>
        </section>
      ) : (
        <>
          <section className="rounded-blob bg-lime p-8 text-ink">
            <div className="label !text-ink/60 mb-2">you&apos;re invited</div>
            <h1 className="t-title">
              connect {invite.name ? <span className="italic">{invite.name}</span> : 'this computer'} to a private network.
            </h1>
            <p className="mt-4 max-w-xl text-ink/75">
              one command sets up the NexLink agent, creates this computer&apos;s keys on this computer, and joins an encrypted WireGuard network. it
              works from wherever you are.
            </p>
            {left !== null && (
              <div className="mt-4 font-mono text-sm">
                {left > 0 ? `invite valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'this invite has expired — ask for a new one'}
              </div>
            )}
          </section>
          {left !== 0 && (
            <section className="rounded-blob border border-line bg-ink-2 p-6">
              <JoinInstructions token={invite.token} deviceId={invite.deviceId} deviceName={invite.name} share={invite.share} showInvite={false} />
            </section>
          )}
          <section className="grid gap-3 text-sm text-white/75 md:grid-cols-3">
            <div className="rounded-panel border border-line p-4">
              <Lock className="mb-2 h-5 w-5 text-lime" />
              private keys are generated here and never leave this computer.
            </div>
            <div className="rounded-panel border border-line p-4">
              <Globe className="mb-2 h-5 w-5 text-lime" />
              any network works. if a direct path is blocked, traffic goes through an encrypted relay.
            </div>
            <div className="rounded-panel border border-line p-4">
              <KeyRound className="mb-2 h-5 w-5 text-lime" />
              nothing is shared unless you choose it above. closing the window disconnects.
            </div>
          </section>
        </>
      )}
    </div>
  );
}
