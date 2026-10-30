'use client';

import { WifiOff } from 'lucide-react';
import { formatCachedAt, useOfflineStatus } from '@/lib/offline';
import { cn } from '@/lib/utils';

/** Bandeau « hors connexion, données du JJ/MM à HH:MM » : lecture seule, aucune saisie. */
export function OfflineBanner({ className }: { className?: string }) {
  const { offline, dataDate } = useOfflineStatus();
  if (!offline) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 bg-warn-soft px-4 py-2.5 text-sm font-semibold text-ink',
        className,
      )}
    >
      <WifiOff className="size-4 shrink-0" aria-hidden />
      <span>
        {dataDate
          ? `Hors connexion, données du ${formatCachedAt(dataDate)}`
          : 'Hors connexion : dernières données enregistrées'}
        <span className="block text-xs font-normal text-muted">
          Lecture seule : la saisie reprendra au retour du réseau.
        </span>
      </span>
    </div>
  );
}
