'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Bot, Check, Copy, Eye, Globe, Lock, LogIn, Play, Radio, ShieldCheck, Sparkles, Zap } from 'lucide-react';

/*
 * Public landing page. Everything stated here is true of the product as built:
 * no invented customer numbers, uptime or latency. The two measured figures
 * come from a real two-agent run and say so.
 */


const PILLARS = [
  [Lock, 'end-to-end', 'encrypted'],
  [Globe, 'peer-to-peer', 'connectivity'],
  [Bot, 'ai-powered', 'diagnostics'],
  [Zap, 'approved', 'recovery'],
];

// Coarse world map, one character per dot ('#' = land). Decorative only.
const WORLD = [
  '      ####  ######              ###    ##########           ',
  '   ##################        ## ####################  ##   ',
  '  ####################      ############################## ',
  '     ################      ############################### ',
  '      #############        #########################  ##   ',
  '       ###########        ##########################       ',
  '        #########         ########################         ',
  '         #######         ##########  ##########            ',
  '          ####           ##########    ######              ',
  '           ###            #########     ####  #            ',
  '            ####           ########      ##    #           ',
  '             ######         ######             ##          ',
  '              ########       #####           #  ###        ',
  '              #########      #####             #####       ',
  '               #######        ####           ########      ',
  '                ######        ###            #########     ',
  '                #####          #              ######       ',
  '                ####                            ##     #   ',
  '                ###                                   ##   ',
  '                ##                                         ',
];
const NODES = [
  [9, 4], [17, 5], [21, 13], [32, 3], [42, 9], [48, 5], [51, 15],
];
const LINKS = [[0, 1], [1, 3], [3, 4], [4, 5], [3, 5], [5, 6], [1, 2]];

function WorldDots({ className = '', nodes = true }) {
  const S = 6;
  const w = WORLD[0].length * S;
  const h = WORLD.length * S;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden>
      {WORLD.flatMap((row, y) =>
        [...row].map((c, x) => (c === '#' ? <rect key={`${x}-${y}`} x={x * S + 1.5} y={y * S + 1.5} width={2.4} height={2.4} fill="#C7FF2E" opacity={0.5} /> : null)),
      )}
      {nodes && (
        <>
          {LINKS.map(([a, b]) => (
            <line
              key={`${a}-${b}`}
              x1={NODES[a][0] * S + 3}
              y1={NODES[a][1] * S + 3}
              x2={NODES[b][0] * S + 3}
              y2={NODES[b][1] * S + 3}
              stroke="#C7FF2E"
              strokeWidth={0.8}
              strokeDasharray="3 3"
              opacity={0.75}
              className="welcome-dash"
            />
          ))}
          {NODES.map(([x, y], i) => (
            <rect key={i} x={x * S} y={y * S} width={6} height={6} fill="#0F0F0F" stroke="#C7FF2E" strokeWidth={1.2} />
          ))}
        </>
      )}
    </svg>
  );
}

function useSignedIn() {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    fetch('/api/v1/auth/me', { credentials: 'include' })
      .then((r) => setSignedIn(r.ok))
      .catch(() => {});
  }, []);
  return signedIn;
}

function Bracket({ children, className = '' }) {
  return (
    <span className={`relative inline-flex items-center justify-center ${className}`}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 border-y-2 border-l-2 border-white/45" />
      <span aria-hidden className="absolute inset-y-0 right-0 w-1.5 border-y-2 border-r-2 border-white/45" />
      {children}
    </span>
  );
}

/** The only chrome on this page: the way into the console. */
function SignInButton({ signedIn }) {
  return (
    <Link
      href={signedIn ? '/' : '/login'}
      className="fixed right-4 top-4 z-40 flex h-11 items-center gap-3 border border-white bg-white px-4 font-pixel text-[10px] uppercase leading-none text-ink transition-[transform,box-shadow] duration-100 hover:-translate-x-px hover:-translate-y-px hover:shadow-[3px_3px_0_0_var(--color-lime)] md:right-8 md:top-6"
    >
      <LogIn className="h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden /> {signedIn ? 'open console' : 'sign in'}
    </Link>
  );
}

/** The product, drawn as a desk monitor: the console's real navigation, a state legend and a tunnel readout. */
function MonitorScene() {
  const nav = [['overview', 'networks', 'devices', 'topology'], ['autopsy', 'insights', 'simulation'], ['approvals', 'audit log']];
  return (
    <div className="relative mx-auto w-full max-w-[760px] pb-24 lg:pb-28" aria-label="Illustration of the NexLink console" role="img">
      {/* monitor */}
      <div className="relative border-[6px] border-[#1c1f17] bg-[#0b0d08] shadow-[0_0_0_1px_rgb(199_255_46/0.35),0_0_60px_-10px_rgb(199_255_46/0.45)]">
        <div className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] sm:grid-cols-[minmax(0,150px)_minmax(0,1fr)]">
          <div className="border-r border-lime/25 px-3 py-4">
            <div className="mb-4 flex items-center gap-1.5">
              <Image src="/logo-mark.png" alt="" width={16} height={16} className="h-4 w-4" />
              <span className="font-pixel text-[8px] uppercase text-white">nexlink</span>
            </div>
            {nav.map((g, i) => (
              <ul key={i} className="mb-3 space-y-1.5">
                {g.map((n) => (
                  <li key={n} className={`font-mono text-[9.5px] uppercase tracking-wider sm:text-[10.5px] ${n === 'topology' ? 'text-white' : 'text-white/55'}`}>
                    {n}
                  </li>
                ))}
              </ul>
            ))}
          </div>
          <div className="relative min-h-[220px] p-3 sm:min-h-[280px]">
            <WorldDots className="h-full w-full" />
            <div className="absolute right-3 top-3 border border-lime/50 bg-ink/90 px-3 py-2">
              <div className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-lime">device states</div>
              {[
                ['bg-lime', 'healthy'],
                ['bg-amber', 'degraded'],
                ['bg-coral', 'unreachable'],
                ['border border-white/50', 'unknown'],
              ].map(([c, l]) => (
                <div key={l} className="flex items-center gap-2 font-mono text-[9px] uppercase text-white/75">
                  <span className={`h-1.5 w-1.5 ${c}`} aria-hidden />
                  {l}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* stand */}
      <div aria-hidden className="mx-auto h-5 w-24 bg-[#1c1f17]" />
      <div aria-hidden className="mx-auto h-2 w-48 bg-[#1c1f17]" />

      {/* tunnel readout: values from a real run of two agents */}
      <div className="absolute bottom-0 right-0 w-[min(330px,82%)] border border-lime/45 bg-ink/95 p-4 shadow-[0_0_40px_-12px_rgb(199_255_46/0.5)] backdrop-blur-sm">
        <div className="mb-2.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider">
          <span className="text-lime">&gt; secure tunnel</span>
          <span className="bg-lime px-1.5 py-0.5 text-ink">established</span>
        </div>
        <dl className="space-y-1 font-mono text-[10.5px] uppercase">
          {[
            ['wireguard handshake', 'ok'],
            ['probe through tunnel', 'ok'],
            ['path', 'direct udp'],
            ['tunnel rtt', '0.35 ms'],
            ['relay', 'standby'],
            ['network', 'maitrey-net'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-white/60">&gt; {k}</dt>
              <dd className={v === 'ok' ? 'text-lime' : 'text-white'}>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-2.5 border-t border-dashed border-line pt-2 font-mono text-[9px] uppercase tracking-wider text-white/45">measured · two agents · 22 oct 2026</div>
      </div>
    </div>
  );
}

function StatStrip() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] border border-line bg-ink/85 backdrop-blur-md sm:grid-cols-2 xl:grid-cols-[1.25fr_1fr_1fr_1fr]">
      <div className="flex items-center gap-4 border-b border-line p-5 sm:border-r xl:border-b-0">
        <div className="min-w-0 flex-1">
          <div className="label mb-2 !text-white">
            <span className="text-lime">⁞</span> paths
          </div>
          <WorldDots className="h-16 w-full max-w-[220px]" nodes={false} />
        </div>
        <ul className="space-y-1.5 font-mono text-[11px] uppercase">
          {[
            ['direct', 'udp p2p'],
            ['relay', 'fallback'],
            ['nat', 'no port fwd'],
          ].map(([k, v]) => (
            <li key={k} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 bg-lime" aria-hidden />
              <span className="w-12 text-white/80">{k}</span>
              <span className="text-white/55">{v}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center gap-5 border-b border-line p-5 xl:border-b-0 xl:border-r">
        <div>
          <div className="label mb-3 !text-white">
            <span className="text-lime">⁞</span> measured rtt
          </div>
          <div className="space-y-1.5" aria-hidden>
            <div className="h-2.5 bg-lime" style={{ width: 35 }} />
            <div className="h-2.5 bg-white/35" style={{ width: 100 }} />
          </div>
        </div>
        <div>
          <div className="font-pixel text-[22px] leading-none text-lime">0.35<span className="ml-1 font-mono text-xs text-white/60">ms</span></div>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-wider text-white/55">direct · relay 1.0 ms</div>
        </div>
      </div>
      <div className="flex items-center gap-5 border-b border-line p-5 sm:border-b-0 sm:border-r">
        <div>
          <div className="label mb-2 !text-white">
            <span className="text-lime">⁞</span> health rule
          </div>
          <p className="max-w-[16rem] text-xs leading-relaxed text-white/65">nothing counts as connected without a fresh WireGuard handshake.</p>
        </div>
        <div>
          <div className="font-pixel text-[22px] leading-none text-lime">180s</div>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-wider text-white/55">freshness</div>
        </div>
      </div>
      <div className="flex items-center gap-4 p-5">
        <div className="min-w-0">
          <div className="label mb-3 !text-white">
            <span className="text-lime">⁞</span> encryption
          </div>
          <div className="flex items-center gap-3">
            <Lock className="h-7 w-7 shrink-0 text-lime" aria-hidden />
            <div className="font-mono text-[11px] uppercase leading-relaxed">
              <div className="text-white">wireguard</div>
              <div className="text-white/60">chacha20-poly1305</div>
              <div className="text-white/60">curve25519</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  [Globe, 'one-line join', 'Run one line on any Windows, macOS or Linux computer. It shows a short code; you approve it in the console. No tokens in shell history, no admin rights in userspace mode.'],
  [Radio, 'works behind nat', 'Agents try a direct UDP path first and fall back to an encrypted relay when firewalls or CGNAT block it. The relay only ever sees WireGuard ciphertext.'],
  [Eye, 'live network observatory', 'Heartbeats, handshake age, tunnel latency and loss per peer pair, streamed to the console. Stale data is shown as stale, never as healthy.'],
  [Sparkles, 'ai insights with receipts', 'AI briefings and incident analysis cite the exact evidence records they rely on. Claims without evidence are rejected before you see them.'],
  [ShieldCheck, 'human-approved recovery', 'Diagnostics can propose actions; a policy engine checks them and an operator approves. Every outcome is verified and written to the audit log.'],
  [Play, 'remote sessions', 'Open RDP, SSH or a web service on another device straight through the tunnel, only for the services its owner chose to share.'],
];

const SECURITY = [
  'Device identity is an Ed25519 key that never leaves the device; every agent request is signed.',
  'Private WireGuard keys stay on the device. The control plane only stores public keys.',
  'AI models never receive private keys, passwords or session tokens.',
  'No silent changes to host routes, firewall rules or VPN config: privileged mode is opt-in on each host.',
  'Every security-sensitive action creates an audit event with actor, target and outcome.',
];

function CommandLine({ cmd, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border border-line bg-ink/90">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="label !text-[10px]">{label}</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(cmd).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="flex items-center gap-1.5 font-mono text-[10px] uppercase text-white/60 hover:text-lime"
          aria-label={`Copy ${label} command`}
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <code className="block overflow-x-auto whitespace-pre px-3 py-3 font-mono text-[12.5px] text-lime scrollbar-thin">{cmd}</code>
    </div>
  );
}

function SectionTitle({ id, kicker, children }) {
  return (
    <div className="mb-8">
      <div className="mb-3 font-mono text-[12px] uppercase tracking-[0.12em] text-white/60">
        <span className="text-lime">&gt;</span> {kicker}
      </div>
      <h2 id={`${id}-title`} className="font-pixel text-[20px] uppercase leading-[1.4] md:text-[28px]">
        {children}
      </h2>
    </div>
  );
}

export default function Welcome() {
  const signedIn = useSignedIn();
  const [origin, setOrigin] = useState('https://your-nexlink-server');
  useEffect(() => setOrigin(window.location.origin), []);

  return (
    <div className="backdrop-photo min-h-screen">
      <SignInButton signedIn={signedIn} />
      <div>

      {/* ── hero ─────────────────────────────────────────────── */}
      <section id="home" aria-labelledby="hero-title" className="mx-auto max-w-[1520px] px-4 pb-10 pt-12 md:px-10 lg:pt-20">
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <div className="enter">
            <div className="mb-10 flex items-center gap-2.5">
              <Image src="/logo-mark.png" alt="" width={34} height={34} priority className="h-[34px] w-[34px]" />
              <span className="font-pixel text-[15px] uppercase leading-none">nexlink</span>
            </div>
            <div className="mb-6 font-mono text-[12px] uppercase tracking-[0.1em] text-white/75">
              <span className="text-lime">&gt;</span> private networking for a more connected world
            </div>
            <h1 id="hero-title" className="font-pixel text-[24px] uppercase leading-[1.3] sm:text-[34px] lg:text-[32px] xl:text-[42px] 2xl:text-[50px]">
              <span className="block">your devices.</span>
              <span className="block text-lime">your network.</span>
              <span className="block">no limits.</span>
            </h1>
            <p className="mt-7 max-w-[34rem] text-[17px] leading-relaxed text-white/80 md:text-lg">
              NexLink creates secure, private networks between your devices with honest monitoring and AI-powered diagnostics — so you stay connected,
              anywhere.
            </p>

            <ul className="mt-9 grid max-w-[36rem] grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
              {PILLARS.map(([Icon, a, b]) => (
                <li key={a} className="flex flex-col items-center text-center">
                  <Bracket className="h-12 w-14">
                    <Icon className="h-6 w-6 text-white" aria-hidden />
                  </Bracket>
                  <span className="mt-3 font-mono text-[11px] uppercase tracking-wider text-white">{a}</span>
                  <span className="font-mono text-[11px] uppercase tracking-wider text-white/60">{b}</span>
                </li>
              ))}
            </ul>

            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                href={signedIn ? '/' : '/login?mode=signup'}
                className="inline-flex h-[52px] min-w-[15rem] items-center justify-center gap-3 border border-lime bg-lime px-7 font-mono text-[14px] font-medium uppercase tracking-wider text-ink transition-[transform,box-shadow] hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_0_#fff]"
              >
                [ {signedIn ? 'open console' : 'get started'} <ArrowRight className="h-4 w-4" aria-hidden /> ]
              </Link>
              <a
                href="#product"
                className="inline-flex h-[52px] min-w-[14rem] items-center justify-center gap-3 border border-white/80 px-7 font-mono text-[14px] font-medium uppercase tracking-wider text-white transition-colors hover:border-lime hover:text-lime"
              >
                [ how it works <Play className="h-3.5 w-3.5 fill-current" aria-hidden /> ]
              </a>
            </div>
            <p className="mt-5 text-sm text-white/70">Set up your private network in minutes. No complicated configuration.</p>
          </div>

          <MonitorScene />
        </div>

        <div className="mt-14">
          <StatStrip />
        </div>
      </section>

      {/* ── product: how it works ───────────────────────────── */}
      <section id="product" aria-labelledby="product-title" className="mx-auto max-w-[1520px] px-4 py-20 md:px-10">
        <SectionTitle id="product" kicker="how it works">
          three steps<span className="text-lime">.</span> one private network<span className="text-lime">.</span>
        </SectionTitle>
        <ol className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-3">
          {[
            ['01', 'create a network', 'Sign in and create a network. NexLink suggests a private address range that does not clash with the ones you use.'],
            ['02', 'run the join line', 'Paste one line on each computer. The agent creates its own keys and shows a short code. Nothing secret is in the command.'],
            ['03', 'approve, then verify', 'Approve the code in the console. The device joins, tunnels come up, and it only shows as connected once a handshake proves it.'],
          ].map(([n, t, d]) => (
            <li key={n} className="border border-line bg-ink/85 p-6 backdrop-blur-sm">
              <div className="t-ident text-lime">{n}</div>
              <h3 className="t-section mt-4">{t}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-white/75">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── features ───────────────────────────────────────── */}
      <section id="features" aria-labelledby="features-title" className="mx-auto max-w-[1520px] px-4 py-20 md:px-10">
        <SectionTitle id="features" kicker="what you get">
          built to be trusted<span className="text-lime">.</span>
        </SectionTitle>
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-px border border-line bg-line md:grid-cols-2 xl:grid-cols-3">
          {FEATURES.map(([Icon, t, d]) => (
            <li key={t} className="group bg-ink/90 p-6 transition-colors hover:bg-ink-2">
              <Icon className="h-6 w-6 text-lime" aria-hidden />
              <h3 className="t-section mt-5">{t}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-white/75">{d}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── security ───────────────────────────────────────── */}
      <section id="security" aria-labelledby="security-title" className="mx-auto max-w-[1520px] px-4 py-20 md:px-10">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <SectionTitle id="security" kicker="security model">
            your keys never<br />leave your devices<span className="text-lime">.</span>
          </SectionTitle>
          <ul className="space-y-3">
            {SECURITY.map((s, i) => (
              <li key={i} className="grid grid-cols-[44px_minmax(0,1fr)] gap-3 border border-line bg-ink/85 p-4 backdrop-blur-sm">
                <span className="t-data border-l-2 border-lime pl-2 text-[11px] text-lime">S-{String(i + 1).padStart(2, '0')}</span>
                <span className="text-[15px] leading-relaxed text-white/85">{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── docs: get started ──────────────────────────────── */}
      <section id="docs" aria-labelledby="docs-title" className="mx-auto max-w-[1520px] px-4 pb-24 pt-20 md:px-10">
        <SectionTitle id="docs" kicker="get started">
          add a computer<span className="text-lime">.</span>
        </SectionTitle>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
          <CommandLine label="windows · powershell" cmd={`irm '${origin}/join.ps1' | iex`} />
          <CommandLine label="macos · linux" cmd={`curl -fsSL '${origin}/join.sh' | sh`} />
        </div>
        <p className="mt-4 max-w-2xl text-sm text-white/65">
          The line installs the agent, creates the computer&apos;s own keys and shows a short code. An operator approves the code in the console; until then the computer
          has no access to anything.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link
            href={signedIn ? '/' : '/login?mode=signup'}
            className="inline-flex h-12 items-center gap-3 border border-lime bg-lime px-6 font-mono text-[13px] font-medium uppercase tracking-wider text-ink transition-[transform,box-shadow] hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_0_#fff]"
          >
            [ {signedIn ? 'open console' : 'create your network'} <ArrowRight className="h-4 w-4" aria-hidden /> ]
          </Link>
        </div>
      </section>

      <footer className="border-t border-line bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1520px] flex-wrap items-center justify-between gap-4 px-4 py-6 md:px-10">
          <div className="flex items-center gap-2.5">
            <Image src="/logo-mark.png" alt="" width={22} height={22} className="h-[22px] w-[22px]" />
            <span className="font-pixel text-[10px] uppercase">nexlink</span>
          </div>
          <span className="font-mono text-[11px] uppercase tracking-wider text-white/50">wireguard · e2e encrypted · explains, never acts alone</span>
        </div>
      </footer>
      </div>
    </div>
  );
}
