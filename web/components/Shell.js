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
  {
    label: 'operate',
    items: [
      { href: '/', label: 'overview', icon: Activity },
      { href: '/networks', label: 'networks', icon: Network },
      { href: '/devices', label: 'devices', icon: Cpu },
      { href: '/topology', label: 'topology', icon: Share2 },
    ],
  },
  {
    label: 'investigate',
    items: [
      { href: '/insights', label: 'ai insights', icon: Sparkles },
      { href: '/diagnostics', label: 'diagnostics', icon: Stethoscope },
      { href: '/simulation', label: 'simulation', icon: Radio },
    ],
  },
  {
    label: 'govern',
    items: [
      { href: '/approvals', label: 'approvals', icon: CheckSquare },
      { href: '/audit', label: 'audit log', icon: ScrollText, perm: 'audit:read' },
    ],
  },
];

const LIVE = {
  live: { text: 'live updates', dot: 'bg-lime pulse-lime', hint: 'Socket.IO channel open: pages refresh on events' },
  connecting: { text: 'connecting', dot: 'border border-mid', hint: 'opening the live channel' },
  disconnected: { text: 'updates paused', dot: 'bg-amber', hint: 'live channel down: pages refresh on a timer' },
};

function NavList({ can, active, onNavigate }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-6">
      {GROUPS.map((g) => {
        const items = g.items.filter((n) => !n.perm || can(n.perm));
        if (!items.length) return null;
        return (
          <div key={g.label}>
            <div className="label mb-2 px-3 !text-[10px] !text-white/50">{g.label}</div>
            <ul className="flex flex-col gap-px">
              {items.map(({ href, label, icon: Icon }) => {
                const on = active(href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      aria-current={on ? 'page' : undefined}
                      className={`group relative flex h-9 items-center gap-3 rounded-control px-3 text-sm transition-colors duration-150 ${
                        on ? 'bg-ink-3 text-white' : 'text-mid hover:bg-white/[0.03] hover:text-white'
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-lime transition-transform duration-200 ${on ? 'scale-y-100' : 'scale-y-0'}`}
                      />
                      <Icon className={`h-4 w-4 shrink-0 ${on ? 'text-lime' : ''}`} strokeWidth={1.75} aria-hidden />
                      {label}
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
          href="/setup"
          onClick={onNavigate}
          aria-current={active('/setup') ? 'page' : undefined}
          className={`flex h-9 items-center gap-3 rounded-control border px-3 text-sm transition-colors ${
            active('/setup') ? 'border-lime text-lime' : 'border-dashed border-line-strong text-white/80 hover:border-lime hover:text-lime'
          }`}
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden /> register a pc
        </Link>
      )}
    </nav>
  );
}

function Account({ user, live, logout }) {
  const l = LIVE[live] || LIVE.connecting;
  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex items-center gap-2 px-3" title={l.hint}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${l.dot}`} aria-hidden />
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-mid">{l.text}</span>
      </div>
      <div className="flex items-center justify-between gap-2 px-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{user.displayName}</div>
          <div className="font-mono text-[10.5px] uppercase tracking-widest text-white/50">{user.role}</div>
        </div>
        <button onClick={logout} className="rounded-control p-2 text-mid hover:bg-ink-3 hover:text-white" aria-label="Sign out" title="Sign out">
          <LogOut className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-3" aria-label="NexLink overview">
      <Image src="/logo-mark.png" alt="" width={32} height={32} priority className="h-8 w-8" />
      <span className="font-display text-lg font-semibold tracking-tight">nexlink</span>
    </Link>
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

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col gap-8 border-r border-line bg-ink/85 px-3 py-5 md:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <NavList can={can} active={active} />
        </div>
        <Account user={user} live={live} logout={logout} />
      </aside>

      {/* Small screens: top bar + full navigation drawer (every route stays reachable). */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-ink/95 px-2 md:hidden">
        <Brand />
        <div className="flex items-center gap-1">
          <span className={`mr-2 h-2 w-2 rounded-full ${(LIVE[live] || LIVE.connecting).dot}`} title={(LIVE[live] || LIVE.connecting).text} aria-hidden />
          <button onClick={() => setDrawer(true)} className="rounded-control p-2.5 text-white hover:bg-ink-3" aria-label="Open navigation" aria-expanded={drawer}>
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>
      {drawer && (
        <div className="fixed inset-0 z-50 bg-black/70 md:hidden" onClick={() => setDrawer(false)}>
          <div className="enter flex h-full w-[min(300px,86vw)] flex-col gap-6 border-r border-line bg-ink px-3 py-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <Brand />
              <button onClick={() => setDrawer(false)} className="rounded-control p-2.5 text-mid hover:text-white" aria-label="Close navigation">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavList can={can} active={active} onNavigate={() => setDrawer(false)} />
            </div>
            <Account user={user} live={live} logout={logout} />
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 pb-16 pt-20 md:px-10 md:pt-9">
        <div className="mx-auto max-w-[1520px]">
          {live === 'disconnected' && (
            <div role="status" className="mb-6 flex items-center gap-2 rounded-control border border-amber/30 bg-amber/[0.05] px-3 py-2 font-mono text-[11px] text-amber">
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
  );
}
