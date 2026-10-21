'use client';

import { io } from 'socket.io-client';

/**
 * One Socket.IO connection per tab. Events only carry ids; consumers refetch
 * through the REST API (which enforces authorization).
 */
let socket = null;
let status = 'connecting';
const statusListeners = new Set();

function setStatus(s) {
  status = s;
  statusListeners.forEach((fn) => fn(s));
}

export function getSocket() {
  if (typeof window === 'undefined') return null;
  if (!socket) {
    // Same origin: server.js serves Socket.IO on the console's own port.
    socket = io({ withCredentials: true, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
    socket.on('connect', () => setStatus('live'));
    socket.on('disconnect', () => setStatus('disconnected'));
    // A handshake rejected by auth middleware is not retried by socket.io; retry ourselves.
    socket.on('connect_error', () => {
      setStatus('disconnected');
      setTimeout(() => socket && !socket.connected && socket.connect(), 5000);
    });
  }
  return socket;
}

export function onStatus(fn) {
  statusListeners.add(fn);
  fn(status);
  return () => statusListeners.delete(fn);
}

export function closeSocket() {
  socket?.close();
  socket = null;
  setStatus('disconnected');
}
