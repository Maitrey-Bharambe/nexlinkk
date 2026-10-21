'use client';

import Link from 'next/link';
import StatusBadge from '@/components/StatusBadge';
import { Freshness } from '@/components/ui';
import { fmtMeasurement, shortId } from '@/lib/format';
import { useNow } from '@/hooks/useApi';

export default function DeviceTable({ devices, networkNames = {} }) {
  const now = useNow();
  return (
    <div className="overflow-x-auto rounded-blob border border-charcoal scrollbar-thin">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead>
          <tr className="border-b border-charcoal bg-ink-2">
            {['device', 'status', 'enrollment', 'virtual ip', 'network', 'heartbeat', 'vpn iface', 'last handshake', 'latency'].map((h) => (
              <th key={h} className="label px-4 py-3 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} className="border-b border-charcoal/60 last:border-0 hover:bg-ink-2">
              <td className="px-4 py-3">
                <Link href={`/devices/${d.id}`} className="font-semibold hover:text-lime">{d.name}</Link>
                <div className="font-mono text-[11px] text-mid">{shortId(d.id)}</div>
              </td>
              <td className="px-4 py-3">
                <StatusBadge state={d.health?.status || 'unknown'} />
              </td>
              <td className="px-4 py-3"><StatusBadge state={d.enrollmentState} /></td>
              <td className="px-4 py-3 font-mono text-xs">
                {d.membership ? (
                  <span className={d.membership.status === 'active' ? 'text-lime' : 'text-mid line-through'}>{d.membership.address}</span>
                ) : (
                  <span className="text-mid">unassigned</span>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-mid">{networkNames[d.networkId] || '—'}</td>
              <td className="px-4 py-3"><Freshness at={d.lastHeartbeatAt} now={now} /></td>
              <td className="px-4 py-3">
                <StatusBadge state={d.health?.vpn?.state || 'unknown'} label={d.health?.vpn?.source === 'simulated' ? 'simulated' : undefined} />
              </td>
              <td className="px-4 py-3"><Freshness at={d.health?.lastHandshakeAt} staleAfterSec={180} now={now} /></td>
              <td className="px-4 py-3 font-mono text-xs">
                {d.health?.latestRtt ? fmtMeasurement(d.health.latestRtt) : <span className="text-mid">not measured</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
