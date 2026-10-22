'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Activity, CheckSquare, Cpu, LogOut, Menu, Network, Plus, Radio, ScrollText, Share2, Sparkles, Stethoscope, X } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { useLiveStatus } from '@/hooks/useApi';
import { Loading } from './ui';

// Routes are unchanged; they are only grouped by what an operator is doing.
const GROUPS = [
  { label: null, items: [{ href: '/', label: 'overview', icon: Activity }] },
  {
    label: 'network',
    items: [
      { href: '/networks', label: 'networks', icon: Network },
      { href: '/topology', label: 'topology', icon: Share2 },
      { href: '/devices', label: 'devices', icon: Cpu },
    ],
  },
  {
    label: 'intelligence',
    items: [
      { href: '/diagnostics', label: 'autopsy', icon: Stethoscope, hint: 'incidents & diagnostics' },
      { href: '/insights', label: 'ai insights', icon: Sparkles },
      { href: '/simulation', label: 'simulation', icon: Radio },
    ],
  },
  {
    label: 'security',
    items: [
      { href: '/approvals', label: 'approvals', icon: CheckSquare },
      { href: '/audit', label: 'audit log', icon: ScrollText, perm: 'audit:read' },
    ],
  },
];

const PAGE_NAMES = [
  ['/devices/', 'device'],
  ['/diagnostics/', 'autopsy'],
  ['/networks/', 'network'],
  ['/activate', 'add a device'],
  ['/setup', 'setup'],
  ...GROUPS.flatMap((g) => g.items.map((i) => [i.href, i.label])),
];

// Real state of the Socket.IO channel — nothing here is decorative.
const LIVE = {
  live: { text: 'live', dot: 'bg-lime', hint: 'Socket.IO channel open: pages refresh on events' },
  connecting: { text: 'connecting', dot: 'border border-mid', hint: 'opening the live channel' },
  disconnected: { text: 'polling', dot: 'bg-amber', hint: 'live channel down: pages refresh on a timer' },
};

function NavList({ can, active, onNavigate }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {GROUPS.map((g, gi) => {
        const items = g.items.filter((n) => !n.perm || can(n.perm));
        if (!items.length) return null;
        return (
          <div key={g.label || gi}>
            {g.label && (
              <div className="mb-2 flex items-center gap-2 px-2.5 font-pixel text-[8px] uppercase leading-none text-white/50">
                <span aria-hidden className="h-px w-3 bg-white/30" />
                {g.label}
              </div>
            )}
            <ul className="flex flex-col">
              {items.map(({ href, label, icon: Icon, hint }) => {
                const on = active(href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      title={hint}
                      aria-current={on ? 'page' : undefined}
                      className={`flex h-9 items-center gap-3 px-2.5 font-pixel text-[9.5px] uppercase leading-none transition-colors duration-100 ${
                        on ? 'bg-lime font-semibold text-ink' : 'text-white/65 hover:bg-white/[0.04] hover:text-white'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={on ? 2.25 : 1.75} aria-hidden />
                      {label}
                      {on && <span aria-hidden className="ml-auto font-mono text-[11px]">◂</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {can('devices:enroll') && (
        <Link
          href="/activate"
          onClick={onNavigate}
          aria-current={active('/activate') || active('/setup') ? 'page' : undefined}
          className={`flex h-10 items-center gap-3 border px-2.5 font-pixel text-[9.5px] uppercase leading-none transition-[transform,box-shadow,background-color] duration-100 ${
            active('/activate') || active('/setup')
              ? 'border-lime bg-lime text-ink'
              : 'border-white bg-white text-ink hover:-translate-x-px hover:-translate-y-px hover:shadow-[3px_3px_0_0_var(--color-lime)]'
          }`}
        >
          <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden /> add a device
        </Link>
      )}
    </nav>
  );
}

function LiveChip({ live }) {
  const l = LIVE[live] || LIVE.connecting;
  return (
    <span className="flex items-center gap-2 border border-line bg-ink/60 px-2.5 py-1.5 font-pixel text-[8px] uppercase leading-none text-white/70" title={l.hint} role="status">
      <span className={`h-2 w-2 ${l.dot}`} aria-hidden />
      {l.text}
    </span>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2" aria-label="NexLink overview">
      <Image src="/logo-mark.png" alt="" width={30} height={30} priority className="h-[30px] w-[30px]" />
      <span className="font-pixel text-[13px] uppercase leading-none">nexlink</span>
    </Link>
  );
}

function UserBox({ user, logout }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 text-right">
        <div className="truncate font-pixel text-[9px] uppercase leading-none">{user.displayName}</div>
        <div className="mt-1.5 font-pixel text-[7px] uppercase leading-none text-white/50">{user.role}</div>
      </div>
      <button onClick={logout} className="border border-line p-2 text-white/70 hover:border-white hover:text-white" aria-label="Sign out" title="Sign out">
        <LogOut className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}

export default function Shell({ children }) {
  const pathname = usePathname();
  const { user, loading, logout, can } = useAuth();
  // Connect only once a session exists; the socket handshake is cookie-authenticated.
  const live = useLiveStatus(Boolean(user));
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [pathname]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2">
        <Image src="/logo-mark.png" alt="NexLink" width={56} height={56} priority className="h-14 w-14 opacity-90" />
        <Loading label="checking session" />
      </div>
    );
  }

  const active = (href) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const page = (PAGE_NAMES.find(([p]) => (p === '/' ? pathname === '/' : pathname.startsWith(p))) || [null, ''])[1];

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col gap-7 border-r border-line bg-ink/80 px-3 py-5 backdrop-blur-md md:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <NavList can={can} active={active} />
        </div>
        <div className="border-t border-line px-2 pt-3 font-pixel text-[7px] uppercase leading-relaxed text-white/55">wireguard · e2e encrypted</div>
      </aside>

      {/* Small screens: top bar + full navigation drawer (every route stays reachable). */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-ink/85 px-2 backdrop-blur-md md:hidden">
        <Brand />
        <div className="flex items-center gap-2">
          <LiveChip live={live} />
          <button onClick={() => setDrawer(true)} className="border border-line p-2.5 text-white" aria-label="Open navigation" aria-expanded={drawer}>
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>
      {drawer && (
        <div className="fixed inset-0 z-50 bg-black/75 md:hidden" onClick={() => setDrawer(false)}>
          <div className="enter flex h-full w-[min(300px,86vw)] flex-col gap-6 border-r border-line bg-ink/95 px-3 py-4 backdrop-blur-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <Brand />
              <button onClick={() => setDrawer(false)} className="border border-line p-2.5 text-white/70 hover:text-white" aria-label="Close navigation">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavList can={can} active={active} onNavigate={() => setDrawer(false)} />
            </div>
            <div className="border-t border-line pt-4">
              <UserBox user={user} logout={logout} />
            </div>
          </div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Desktop top bar: where you are, the live channel's real state, who you are. */}
        <div className="sticky top-0 z-30 hidden h-12 items-center justify-between border-b border-line bg-ink/75 px-10 backdrop-blur-md md:flex">
          <div className="flex items-center gap-2 font-pixel text-[8px] uppercase leading-none text-white/50">
            <span>nexlink</span>
            <span aria-hidden>/</span>
            <span className="text-white">{page}</span>
          </div>
          <div className="flex items-center gap-4">
            <LiveChip live={live} />
            <UserBox user={user} logout={logout} />
          </div>
        </div>

        <main className="px-4 pb-16 pt-20 md:px-10 md:pt-8">
          <div className="mx-auto max-w-[1520px]">
            {live === 'disconnected' && (
              <div role="status" className="mb-6 flex items-center gap-2 border border-amber/40 bg-amber/[0.05] px-3 py-2 font-mono text-[11px] text-amber">
                <span className="h-1.5 w-1.5 rotate-45 bg-amber" aria-hidden />
                live channel disconnected — data refreshes on a timer; timestamps show how fresh each value is.
              </div>
            )}
            <div key={pathname} className="enter">
              {children}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
