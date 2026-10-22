'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, post, setCsrfToken } from '@/lib/api';
import { closeSocket } from '@/lib/realtime';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const router = useRouter();
  const [state, setState] = useState({ user: null, loading: true });

  useEffect(() => {
    api('/auth/me')
      .then((d) => {
        setCsrfToken(d.csrfToken);
        setState({ user: d.user, loading: false });
      })
      .catch(() => {
        setState({ user: null, loading: false });
        // Come back here after signing in (e.g. the agent's /activate?code= link).
        const here = window.location.pathname + window.location.search;
        router.replace(here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login');
      });
  }, [router]);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      setCsrfToken(null);
      closeSocket();
      router.replace('/login');
    }
  }, [router]);

  // UI hint only. Every permission is enforced again by the control plane.
  const can = useCallback((perm) => {
    const p = state.user?.permissions || [];
    return p.includes('*') || p.includes(perm);
  }, [state.user]);

  return <AuthCtx.Provider value={{ ...state, logout, can }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
