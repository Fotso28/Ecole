'use client';

import { ChevronLeft, ChevronRight, Clock, MapPin } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { eventCoversDay, monthGrid } from '@ecole/shared';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/card';
import type { SchoolEvent } from '@/lib/communication';
import { formatShortDate, formatWeekday, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';

export const CATEGORY_TONE = {
  PARENT_MEETING: 'info',
  HOLIDAY: 'success',
  CELEBRATION: 'saffron',
  OUTING: 'warn',
  EXAM: 'danger',
  OTHER: 'neutral',
} as const;

const DOT = {
  PARENT_MEETING: 'bg-info',
  HOLIDAY: 'bg-primary',
  CELEBRATION: 'bg-saffron',
  OUTING: 'bg-warn',
  EXAM: 'bg-danger',
  OTHER: 'bg-muted',
} as const;

const WEEKDAYS = [
  ['L', 'lundi'],
  ['M', 'mardi'],
  ['M', 'mercredi'],
  ['J', 'jeudi'],
  ['V', 'vendredi'],
  ['S', 'samedi'],
  ['D', 'dimanche'],
] as const;

const monthFmt = new Intl.DateTimeFormat('fr-FR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export interface Month {
  year: number;
  month: number;
}

export function currentMonth(): Month {
  const [y, m] = todayIso().split('-').map(Number);
  return { year: y!, month: m! };
}

export function shiftMonth({ year, month }: Month, delta: number): Month {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function when(e: SchoolEvent): string {
  const dates =
    e.endDate !== e.startDate
      ? `Du ${formatShortDate(e.startDate)} au ${formatShortDate(e.endDate)}`
      : formatWeekday(e.startDate).replace(/^./, (c) => c.toUpperCase());
  const time = e.startTime ? ` · ${e.startTime}${e.endTime ? `–${e.endTime}` : ''}` : '';
  return `${dates}${time}`;
}

function EventCard({ event, action }: { event: SchoolEvent; action?: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-white p-3.5">
      <div className="flex items-start justify-between gap-2">
        <strong className="text-[15px] [overflow-wrap:anywhere]">{event.title}</strong>
        <Badge tone={CATEGORY_TONE[event.category]}>{event.categoryLabel}</Badge>
      </div>
      <span className="flex items-center gap-1.5 text-sm text-muted">
        <Clock className="size-4 shrink-0" aria-hidden />
        {when(event)}
      </span>
      {event.location ? (
        <span className="flex items-center gap-1.5 text-sm text-muted">
          <MapPin className="size-4 shrink-0" aria-hidden />
          {event.location}
        </span>
      ) : null}
      {event.description ? (
        <p className="text-sm whitespace-pre-line [overflow-wrap:anywhere]">{event.description}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {event.targetName}
          {event.remindBySms ? ' · rappel la veille' : ''}
        </span>
        {action}
      </div>
    </li>
  );
}

/** Calendrier du mois : vue liste ou grille, pensé pour le téléphone. */
export function EventCalendar({
  events,
  month,
  onMonthChange,
  actionFor,
  loading,
}: {
  events: SchoolEvent[];
  month: Month;
  onMonthChange: (next: Month) => void;
  actionFor?: (event: SchoolEvent) => ReactNode;
  loading?: boolean;
}) {
  const [view, setView] = useState<'list' | 'month'>('list');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const today = todayIso();
  const grid = monthGrid(month.year, month.month);
  const title = monthFmt.format(new Date(Date.UTC(month.year, month.month - 1, 1)));
  const dayEvents = selectedDay ? events.filter((e) => eventCoversDay(e, selectedDay)) : [];
  const change = (delta: number) => {
    setSelectedDay(null);
    onMonthChange(shiftMonth(month, delta));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => change(-1)}
            aria-label="Mois précédent"
            className="flex size-11 items-center justify-center rounded-[10px] border border-line-strong bg-white"
          >
            <ChevronLeft className="size-5" aria-hidden />
          </button>
          <h2
            className="min-w-36 text-center text-base font-bold first-letter:uppercase"
            aria-live="polite"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={() => change(1)}
            aria-label="Mois suivant"
            className="flex size-11 items-center justify-center rounded-[10px] border border-line-strong bg-white"
          >
            <ChevronRight className="size-5" aria-hidden />
          </button>
        </div>
        <div
          role="group"
          aria-label="Affichage"
          className="flex rounded-[12px] border border-line-strong bg-white p-1"
        >
          {(
            [
              ['list', 'Liste'],
              ['month', 'Mois'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                'min-h-10 rounded-[9px] px-4 text-sm font-semibold',
                view === v ? 'bg-primary text-white' : 'text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === 'month' ? (
        <>
          <table className="w-full table-fixed border-separate border-spacing-1">
            <caption className="sr-only">Événements de {title}</caption>
            <thead>
              <tr>
                {WEEKDAYS.map(([short, long], i) => (
                  <th key={i} scope="col" className="text-xs font-semibold text-muted">
                    <abbr title={long} className="no-underline">
                      {short}
                    </abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((week) => (
                <tr key={week[0]!.date}>
                  {week.map((d) => {
                    const covering = events.filter((e) => eventCoversDay(e, d.date));
                    const day = Number(d.date.slice(8));
                    const selected = selectedDay === d.date;
                    return (
                      <td key={d.date} className="p-0">
                        <button
                          type="button"
                          onClick={() => setSelectedDay(selected ? null : d.date)}
                          aria-pressed={selected}
                          aria-label={`${formatWeekday(d.date)}${covering.length ? `, ${covering.length} événement${covering.length > 1 ? 's' : ''}` : ''}`}
                          className={cn(
                            'flex min-h-12 w-full flex-col items-center justify-start gap-1 rounded-[10px] border py-1.5 text-sm tabular lg:min-h-16',
                            d.inMonth ? 'bg-white' : 'bg-paper text-muted',
                            selected
                              ? 'border-2 border-primary'
                              : d.date === today
                                ? 'border-saffron'
                                : 'border-line',
                            d.date === today && 'font-bold',
                          )}
                        >
                          {day}
                          <span className="flex gap-0.5" aria-hidden>
                            {covering.slice(0, 3).map((e) => (
                              <span
                                key={e.id}
                                className={cn('size-1.5 rounded-full', DOT[e.category])}
                              />
                            ))}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {selectedDay ? (
            <section
              aria-label={`Événements du ${formatWeekday(selectedDay)}`}
              className="flex flex-col gap-2"
            >
              <h3 className="text-sm font-bold first-letter:uppercase">
                {formatWeekday(selectedDay)}
              </h3>
              {dayEvents.length === 0 ? (
                <p className="text-sm text-muted">Aucun événement ce jour-là.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {dayEvents.map((e) => (
                    <EventCard key={e.id} event={e} action={actionFor?.(e)} />
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <p className="text-sm text-muted">Touchez un jour pour voir ses événements.</p>
          )}
        </>
      ) : loading ? null : events.length === 0 ? (
        <EmptyState title="Aucun événement ce mois-ci" />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={`Événements de ${title}`}>
          {events.map((e) => (
            <EventCard key={e.id} event={e} action={actionFor?.(e)} />
          ))}
        </ul>
      )}
    </div>
  );
}
