'use client';

import { Button } from './button';

interface LoadMoreProps {
  /** Éléments affichés et total connu (absent pour une pagination par curseur). */
  shown: number;
  total?: number;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  /** Libellé du compteur, par exemple « élèves ». */
  noun: string;
}

/**
 * Pagination « Charger plus » : la liste grandit par pages, sans tout charger d'un coup sur un
 * téléphone modeste. Bouton plutôt que défilement infini : utilisable au clavier et au lecteur
 * d'écran, et le pied de page reste atteignable.
 */
export function LoadMore({ shown, total, hasMore, loading, onMore, noun }: LoadMoreProps) {
  return (
    <div className="flex flex-col items-center gap-2 py-1">
      <p className="text-sm text-muted tabular" aria-live="polite">
        {total === undefined ? `${shown} ${noun} affichés` : `${shown} sur ${total} ${noun}`}
      </p>
      {hasMore ? (
        <Button variant="secondary" onClick={onMore} loading={loading} className="w-full sm:w-auto">
          Charger plus
        </Button>
      ) : null}
    </div>
  );
}
