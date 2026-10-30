'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { monthBounds } from '@ecole/shared';
import { currentMonth, EventCalendar, type Month } from '@/components/calendar/event-calendar';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { Card, CardHeader, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { api } from '@/lib/api';
import type { SchoolEvent } from '@/lib/communication';

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
        />
        {q.isPending ? <LoadingBlock /> : null}
      </Card>
    </>
  );
}
