'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { monthBounds } from '@ecole/shared';
import {
  currentMonth,
  EventCalendar,
  EventCard,
  type Month,
} from '@/components/calendar/event-calendar';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { api } from '@/lib/api';
import type { SchoolEvent } from '@/lib/communication';
import { todayIso } from '@/lib/format';

/** Fenêtre des « prochains événements » montrés quand le mois affiché est vide. */
const UPCOMING_DAYS = 120;

export default function PortalCalendar() {
  const { selected } = useChildren();
  const [month, setMonth] = useState<Month>(currentMonth);
  const range = monthBounds(month.year, month.month);
  const q = useQuery({
    queryKey: ['portal-events', selected?.id, range.from],
    queryFn: () =>
      api<SchoolEvent[]>(
        `/portal/children/${selected?.id}/events?from=${range.from}&to=${range.to}`,
      ),
    enabled: !!selected,
  });
  // Mois vide : les prochains événements, pour ne pas laisser croire que rien n'arrive.
  const today = todayIso();
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + UPCOMING_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const upcoming = useQuery({
    queryKey: ['portal-events', selected?.id, 'upcoming', today],
    queryFn: () =>
      api<SchoolEvent[]>(`/portal/children/${selected?.id}/events?from=${today}&to=${until}`),
    enabled: !!selected && q.data?.length === 0,
  });
  const next = (upcoming.data ?? []).filter((e) => e.endDate >= today).slice(0, 5);
  if (!selected) return <LoadingBlock />;
  return (
    <>
      <ChildSwitcher />
      <Card>
        <CardHeader
          title="Agenda de l’école"
          subtitle={`Réunions, congés, fêtes et sorties concernant ${selected.firstName}.`}
        />
        {q.isError ? <ErrorBlock error={q.error} onRetry={() => q.refetch()} /> : null}
        <EventCalendar
          events={q.data ?? []}
          month={month}
          onMonthChange={setMonth}
          loading={q.isPending}
          emptyExtra={
            next.length > 0 ? (
              <section aria-label="Prochains événements" className="flex flex-col gap-2">
                <h3 className="text-sm font-bold">Prochains événements</h3>
                <ul className="flex flex-col gap-2">
                  {next.map((e) => (
                    <EventCard key={e.id} event={e} />
                  ))}
                </ul>
                <Button
                  variant="secondary"
                  className="self-start"
                  onClick={() => {
                    const [y, m] = next[0]!.startDate.split('-').map(Number);
                    setMonth({ year: y!, month: m! });
                  }}
                >
                  Voir le mois du prochain événement
                </Button>
              </section>
            ) : null
          }
        />
        {q.isPending ? <LoadingBlock /> : null}
      </Card>
    </>
  );
}
