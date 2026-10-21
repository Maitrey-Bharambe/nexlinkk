'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, CheckSquare, Cpu, LogOut, Network, Plus, Radio, ScrollText, Share2, Stethoscope } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { useLiveStatus } from '@/hooks/useApi';
import { Loading } from './ui';

const NAV = [
  { href: '/', label: 'overview', icon: Activity },
  { href: '/networks', label: 'networks', icon: Network },
  { href: '/devices', label: 'devices', icon: Cpu },
  { href: '/topology', label: 'topology', icon: Share2 },
  { href: '/simulation', label: 'simulation', icon: Radio },
  { href: '/diagnostics', label: 'diagnostics', icon: Stethoscope },
  { href: '/approvals', label: 'approvals', icon: CheckSquare },
  { href: '/audit', label: 'audit log', icon: ScrollText, perm: 'audit:read' },
  { href: '/setup', label: 'register a pc', icon: Plus, perm: 'devices:enroll' },
];

export default function Shell({ children }) {
  const pathname = usePathname();
  const { user, loading, logout, can } = useAuth();
  // Connect only once a session exists; the socket handshake is cookie-authenticated.
  const live = useLiveStatus(Boolean(user));

  if (loading || !user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2">
        <Image src="/logo-mark.png" alt="NexLink" width={72} height={72} priority className="h-[72px] w-[72px] animate-pulse" />
        <Loading label="checking session" />
      </div>
    );
  }

  const active = (href) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-charcoal/70 bg-ink/70 p-4 backdrop-blur-md md:flex">
        <Link href="/" className="mb-8 flex items-center gap-2 px-3 pt-2">
          <Image src="/logo-mark.png" alt="NexLink" width={40} height={40} priority className="h-10 w-10" />
          <span className="text-xl font-bold tracking-tight">nexlink</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.filter((n) => !n.perm || can(n.perm)).map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-full px-4 py-2.5 text-sm font-medium transition-colors ${
                active(href) ? 'bg-lime text-ink' : 'text-mid hover:bg-charcoal/60 hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="space-y-3 rounded-3xl bg-ink-2 p-4">
          <div className="flex items-center gap-2" title="Live update channel (Socket.IO) to the control plane">
            <span className={`h-2 w-2 rounded-full ${live === 'live' ? 'bg-lime pulse-lime' : live === 'connecting' ? 'bg-mid' : 'bg-coral'}`} />
            <span className="font-mono text-[11px] uppercase tracking-widest text-mid">
              {live === 'live' ? 'live updates' : live === 'connecting' ? 'connecting' : 'updates offline'}
            </span>
          </div>
          <div>
            <div className="truncate text-sm font-semibold">{user.displayName}</div>
            <div className="font-mono text-[11px] uppercase tracking-widest text-lime">{user.role}</div>
          </div>
          <button onClick={logout} className="flex items-center gap-2 text-xs text-mid hover:text-white">
            <LogOut className="h-3.5 w-3.5" /> sign out
          </button>
        </div>
      </aside>

      {/* Mobile nav */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-charcoal bg-ink/95 p-2 backdrop-blur md:hidden">
        {NAV.filter((n) => !n.perm || can(n.perm)).slice(0, 6).map(({ href, icon: Icon, label }) => (
          <Link key={href} href={href} aria-label={label} className={`rounded-full p-3 ${active(href) ? 'bg-lime text-ink' : 'text-mid'}`}>
            <Icon className="h-5 w-5" />
          </Link>
        ))}
      </div>

      <main className="min-w-0 flex-1 px-4 pb-24 pt-8 md:px-10 md:pb-12">
        {live === 'disconnected' && (
          <div className="mb-6 rounded-2xl border border-charcoal bg-ink-2 px-4 py-2 font-mono text-xs text-mid">
            live channel disconnected — data refreshes on a timer; timestamps show how fresh each value is.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
