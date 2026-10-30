'use client';

import type { Module, Permission } from '@ecole/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  getAccessToken,
  lastRefreshFailure,
  refreshSession,
  setAccessToken,
  setSessionLostHandler,
} from './api';
import { isOffline, purgeOfflineData, readOfflineProfile, saveOfflineProfile } from './offline';
import type { Me, SessionResponse } from './types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthValue {
  status: Status;
  me: Me | null;
  loginStaff: (email: string, password: string) => Promise<{ mfaToken?: string }>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  requestOtp: (phone: string) => Promise<void>;
  verifyOtp: (phone: string, code: string) => Promise<void>;
  switchSchool: (schoolId: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  can: (permission: Permission) => boolean;
  hasModule: (module: Module) => boolean;
  /** Vrai pour un enseignant sans autre rôle. */
  teacherOnly: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Déconnexion demandée hors connexion : le cookie de session est révoqué au retour du réseau. */
const LOGOUT_PENDING = 'ecole.logout-pending';
function logoutPending(): boolean {
  try {
    return localStorage.getItem(LOGOUT_PENDING) === '1';
  } catch {
    return false;
  }
}
async function finishPendingLogout(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) return false;
    localStorage.removeItem(LOGOUT_PENDING);
    return true;
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const queryClient = useQueryClient();
  const router = useRouter();

  const loadMe = useCallback(async () => {
    const data = await api<Me>('/auth/me');
    saveOfflineProfile(data);
    setMe(data);
    setStatus('authenticated');
  }, []);

  const clear = useCallback(() => {
    setAccessToken(null);
    setMe(null);
    setStatus('anonymous');
    queryClient.clear();
    void purgeOfflineData();
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (logoutPending()) {
        await finishPendingLogout();
        if (!cancelled) clear();
        return;
      }
      const ok = await refreshSession();
      if (cancelled) return;
      if (ok) {
        try {
          await loadMe();
          return;
        } catch {
          // Session invalide : retour à l'écran de connexion.
        }
      } else if (lastRefreshFailure() === 'network') {
        // Hors connexion : lecture des dernières données avec le profil gardé sur l'appareil.
        const profile = readOfflineProfile();
        if (profile) {
          setMe(profile);
          setStatus('authenticated');
          return;
        }
      }
      if (!cancelled) clear();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe, clear]);

  // Retour du réseau après une ouverture hors connexion : la session est revérifiée.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const onOnline = async () => {
      if (getAccessToken()) return;
      if (await refreshSession()) {
        await loadMe().catch(() => undefined);
      } else if (lastRefreshFailure() === 'denied') {
        clear();
        router.replace(me?.kind === 'parent' ? '/parent/connexion' : '/connexion?expiree=1');
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [status, me, loadMe, clear, router]);

  useEffect(() => {
    setSessionLostHandler(() => {
      clear();
      router.replace('/connexion?expiree=1');
    });
    return () => setSessionLostHandler(null);
  }, [clear, router]);

  const startSession = useCallback(
    async (session: SessionResponse) => {
      await purgeOfflineData();
      setAccessToken(session.accessToken);
      queryClient.clear();
      await loadMe();
    },
    [loadMe, queryClient],
  );

  const value = useMemo<AuthValue>(() => {
    const permissions = new Set(me?.permissions ?? []);
    return {
      status,
      me,
      loginStaff: async (email, password) => {
        const res = await api<SessionResponse | { mfaRequired: true; mfaToken: string }>(
          '/auth/login',
          {
            method: 'POST',
            body: { email, password },
          },
        );
        if ('mfaRequired' in res) return { mfaToken: res.mfaToken };
        await startSession(res);
        return {};
      },
      verifyMfa: async (mfaToken, code) => {
        await startSession(
          await api<SessionResponse>('/auth/mfa/verify', {
            method: 'POST',
            body: { mfaToken, code },
          }),
        );
      },
      requestOtp: async (phone) => {
        await api('/auth/otp/request', { method: 'POST', body: { phone } });
      },
      verifyOtp: async (phone, code) => {
        await startSession(
          await api<SessionResponse>('/auth/otp/verify', { method: 'POST', body: { phone, code } }),
        );
      },
      switchSchool: async (schoolId) => {
        await startSession(
          await api<SessionResponse>('/auth/switch-school', { method: 'POST', body: { schoolId } }),
        );
      },
      logout: async () => {
        if (isOffline()) {
          try {
            localStorage.setItem(LOGOUT_PENDING, '1');
          } catch {
            // Stockage indisponible.
          }
        }
        try {
          await api('/auth/logout', { method: 'POST' });
        } finally {
          clear();
        }
      },
      reload: loadMe,
      can: (p) => permissions.has(p),
      hasModule: (m) => !!me?.activeSchool?.modules.includes(m),
      teacherOnly:
        !!me &&
        me.kind === 'staff' &&
        me.roles.length > 0 &&
        me.roles.every((r) => r === 'TEACHER'),
    };
  }, [status, me, startSession, clear, loadMe]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans AuthProvider');
  return ctx;
}

/** Page d'accueil selon le profil connecté. */
export function homeFor(me: Me | null, teacherOnly: boolean): string {
  if (!me) return '/connexion';
  if (me.kind === 'parent') return '/portail';
  if (teacherOnly) return '/enseignant';
  if (me.roles.length > 0 && me.roles.every((r) => r === 'TRANSPORT')) return '/transport/appel';
  if (me.user.isPlatformAdmin && !me.activeSchool) return '/plateforme/facturation';
  if (me.permissions.includes('dashboard.read')) return '/tableau-de-bord';
  return '/eleves';
}
