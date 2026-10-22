'use client';

import { useEffect, useState } from 'react';

/** Real reachability of this server's control plane (GET /healthz): checking | online | offline. */
export function useHealth(intervalMs = 30000) {
  const [state, setState] = useState('checking');
  useEffect(() => {
    let alive = true;
    const check = () =>
      fetch('/healthz', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => alive && setState(d?.ok ? 'online' : 'offline'))
        .catch(() => alive && setState('offline'));
    check();
    const t = setInterval(check, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return state;
}

export const HEALTH_LABEL = {
  checking: ['bg-white/40', 'checking'],
  online: ['bg-lime', 'systems online'],
  offline: ['bg-coral', 'control plane offline'],
};
