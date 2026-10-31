'use client';

import { useSyncExternalStore } from 'react';
import type { Me } from './types';

/** Accès hors connexion en lecture : service worker, heure des données en cache, purge. */

export const DATA_CACHE = 'ecole-data';
export const CACHED_AT_HEADER = 'x-ecole-cached-at';
const SNAPSHOT_KEY = 'ecole.offline.me';

let oldestCachedAt: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Une réponse servie par le cache : on garde l'heure de la plus ancienne pour le bandeau. */
export function noteCachedResponse(cachedAt: string | null): void {
  if (!cachedAt || (oldestCachedAt && oldestCachedAt <= cachedAt)) return;
  oldestCachedAt = cachedAt;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onOnline = () => {
    oldestCachedAt = null;
    emit();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', emit);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', emit);
  };
}

export function useOfflineStatus(): { offline: boolean; dataDate: string | null } {
  const offline = useSyncExternalStore(subscribe, isOffline, () => false);
  const dataDate = useSyncExternalStore(
    subscribe,
    () => oldestCachedAt,
    () => null,
  );
  return { offline, dataDate };
}

/** « JJ/MM à HH:MM » pour le bandeau hors connexion. */
export function formatCachedAt(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Profil gardé pour rouvrir l'application hors connexion : parents, enseignants (« Ma journée »)
 * et chauffeurs ou accompagnateurs (appel du car, qui continue sans réseau).
 */
export function offlineEligible(me: Me): boolean {
  return (
    me.kind === 'parent' ||
    me.roles.includes('TEACHER') ||
    me.roles.includes('TRANSPORT') ||
    !!me.scopes?.lines
  );
}

/** Pages où la saisie continue sans réseau (gardée sur l'appareil, envoyée au retour du réseau). */
const OFFLINE_ENTRY_PAGES: Record<string, string> = {
  '/transport/appel':
    'L’appel continue sans réseau : il est gardé sur le téléphone et envoyé au retour du réseau.',
};

/** Consigne du bandeau hors connexion pour la page ouverte. */
export function offlineEntryNote(pathname: string): string | null {
  return OFFLINE_ENTRY_PAGES[pathname] ?? null;
}

export function saveOfflineProfile(me: Me): void {
  try {
    if (offlineEligible(me)) localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(me));
    else localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Stockage indisponible : pas de lecture hors connexion.
  }
}

export function readOfflineProfile(): Me | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

/** Déconnexion ou changement de compte : aucune donnée personnelle ne reste sur l'appareil. */
export async function purgeOfflineData(): Promise<void> {
  oldestCachedAt = null;
  emit();
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Stockage indisponible.
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'purge' });
    if (typeof caches !== 'undefined') await caches.delete(DATA_CACHE);
  } catch {
    // Cache indisponible (navigation privée).
  }
}

export function registerServiceWorker(): void {
  if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
