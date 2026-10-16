'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { getSocket, onStatus } from '@/lib/realtime';

/**
 * Fetches a resource and keeps it fresh:
 *  - refetches on the listed Socket.IO events (debounced)
 *  - optionally polls, because health is time-dependent: a device becomes
 *    "unreachable" when heartbeats *stop*, which produces no event.
 */
export function useApi(path, { events = [], pollMs = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) });
  const [fetchedAt, setFetchedAt] = useState(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      const data = await api(pathRef.current);
      setState({ data, error: null, loading: false });
      setFetchedAt(new Date());
    } catch (error) {
      setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true }));
    load();
  }, [path, load]);

  const eventsKey = events.join(',');
  useEffect(() => {
    if (!eventsKey) return undefined;
    // Pages only render inside the authenticated Shell, so connecting here is safe.
    const socket = getSocket();
    if (!socket) return undefined;
    let t = null;
    const handler = () => {
      clearTimeout(t);
      t = setTimeout(load, 250);
    };
    const names = eventsKey.split(',');
    names.forEach((e) => socket.on(e, handler));
    return () => {
      clearTimeout(t);
      names.forEach((e) => socket.off(e, handler));
    };
  }, [eventsKey, load]);

  useEffect(() => {
    if (!pollMs) return undefined;
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [pollMs, load]);

  return { ...state, reload: load, fetchedAt };
}

export function useLiveStatus(enabled = true) {
  const [status, setStatus] = useState('connecting');
  useEffect(() => {
    if (!enabled) return undefined;
    getSocket();
    return onStatus(setStatus);
  }, [enabled]);
  return status;
}

/** Re-render periodically so "x seconds ago" labels stay honest. */
export function useNow(intervalMs = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
