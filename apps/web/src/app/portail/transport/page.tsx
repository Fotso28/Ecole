'use client';

import { useQuery } from '@tanstack/react-query';
import { TRANSPORT_DIRECTION_LABELS, type TransportDirection } from '@ecole/shared';
import { Bus, Check, MapPin, X } from 'lucide-react';
import { Card, CardHeader, EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { api } from '@/lib/api';
import { formatTime } from '@/lib/format';

interface ChildTransport {
  enabled: boolean;
  subscription: {
    line: string;
    stop: string;
    direction: TransportDirection;
    morningTime: string | null;
    eveningTime: string | null;
    vehicle: string | null;
  } | null;
  today: {
    direction: 'OUTBOUND' | 'RETURN';
    boarded: boolean | null;
    boardedAt: string | null;
    alighted: boolean | null;
    alightedAt: string | null;
  }[];
}

const TRIP = { OUTBOUND: 'Ce matin', RETURN: 'Ce soir' } as const;

export default function PortalTransport() {
  const { selected } = useChildren();
  const q = useQuery({
    queryKey: ['portal-transport', selected?.id],
    queryFn: () => api<ChildTransport>(`/portal/children/${selected?.id}/transport`),
    enabled: !!selected,
  });
  if (!selected || q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const sub = q.data.subscription;
  return (
    <>
      <ChildSwitcher />
      <h2 className="font-display text-xl font-bold">Transport scolaire</h2>
      {!sub ? (
        <EmptyState title={`${selected.firstName} n’est pas inscrit(e) au transport`}>
          {q.data.enabled
            ? 'Pour un abonnement, adressez-vous au secrétariat de l’école.'
            : 'L’école ne propose pas ce service dans l’application.'}
        </EmptyState>
      ) : (
        <>
          <Card className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Bus className="size-5 text-primary" aria-hidden />
              <strong className="text-[15px]">{sub.line}</strong>
            </div>
            <div className="flex items-start gap-2 text-sm">
              <MapPin className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>
                Arrêt <strong>{sub.stop}</strong>
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted">Passage du matin</dt>
                <dd className="text-lg font-bold tabular">{sub.morningTime ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-muted">Dépose du soir</dt>
                <dd className="text-lg font-bold tabular">{sub.eveningTime ?? '—'}</dd>
              </div>
            </dl>
            <span className="text-[13px] text-muted">
              {TRANSPORT_DIRECTION_LABELS[sub.direction]}
              {sub.vehicle ? ` · véhicule ${sub.vehicle}` : ''}
            </span>
          </Card>
          <Card>
            <CardHeader title="Aujourd’hui" />
            {q.data.today.length === 0 ? (
              <p className="text-sm text-muted">L’appel du car n’a pas encore été fait.</p>
            ) : (
              <ul className="flex flex-col">
                {q.data.today.map((t) => (
                  <li
                    key={t.direction}
                    className="flex items-center justify-between gap-3 border-t border-line py-2.5 text-sm first:border-t-0"
                  >
                    <span className="font-semibold">{TRIP[t.direction]}</span>
                    {t.boarded === false ? (
                      <span className="flex items-center gap-1 font-semibold text-danger">
                        <X className="size-4" aria-hidden />
                        Pas monté(e)
                      </span>
                    ) : t.boarded ? (
                      <span className="flex items-center gap-1 font-semibold text-primary">
                        <Check className="size-4" aria-hidden />
                        {t.alighted
                          ? `Déposé(e)${t.alightedAt ? ` à ${formatTime(t.alightedAt)}` : ''}`
                          : `Monté(e)${t.boardedAt ? ` à ${formatTime(t.boardedAt)}` : ''}`}
                      </span>
                    ) : (
                      <span className="text-muted">Non pointé(e)</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}
