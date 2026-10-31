'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EVENT_CATEGORIES, EVENT_CATEGORY_LABELS, monthBounds } from '@ecole/shared';
import { currentMonth, EventCalendar, type Month } from '@/components/calendar/event-calendar';
import { Button } from '@/components/ui/button';
import { ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { Checkbox, InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { SchoolEvent } from '@/lib/communication';
import { todayIso } from '@/lib/format';
import { useClasses } from '@/lib/queries';

interface Cycle {
  id: string;
  name: string;
  levels: { id: string; name: string }[];
}
type Scope = 'SCHOOL' | 'CYCLE' | 'LEVEL' | 'CLASS';

function EventForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const classes = useClasses();
  const cycles = useQuery({
    queryKey: ['cycles'],
    queryFn: () => api<Cycle[]>('/academic/cycles'),
  });
  const [scope, setScope] = useState<Scope>('SCHOOL');
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<SchoolEvent>('/events', { method: 'POST', body }),
    onSuccess: () => {
      toast('Événement ajouté au calendrier');
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      onDone();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const err = (path: string) =>
    create.error instanceof ApiError
      ? create.error.fieldErrors.find((f) => f.path === path)?.message
      : undefined;
  const targets =
    scope === 'CLASS'
      ? (classes.data ?? []).map((c) => ({ id: c.id, name: c.name }))
      : scope === 'LEVEL'
        ? (cycles.data ?? []).flatMap((c) => c.levels)
        : scope === 'CYCLE'
          ? (cycles.data ?? []).map((c) => ({ id: c.id, name: c.name }))
          : [];
  const opt = (v: FormDataEntryValue | null) => (v ? String(v) : undefined);
  return (
    <form
      className="grid gap-4 p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        create.mutate({
          title: fd.get('title'),
          category: fd.get('category'),
          startDate: fd.get('startDate'),
          endDate: opt(fd.get('endDate')),
          startTime: opt(fd.get('startTime')),
          endTime: opt(fd.get('endTime')),
          location: opt(fd.get('location')),
          description: opt(fd.get('description')),
          scope,
          targetId: opt(fd.get('targetId')),
          remindBySms: fd.get('remindBySms') === 'on',
        });
      }}
    >
      <InputField
        label="Titre"
        name="title"
        required
        minLength={3}
        maxLength={120}
        containerClassName="sm:col-span-2"
      />
      <SelectField label="Type" name="category" defaultValue="PARENT_MEETING">
        {EVENT_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {EVENT_CATEGORY_LABELS[c]}
          </option>
        ))}
      </SelectField>
      <InputField label="Lieu" name="location" optional maxLength={120} />
      <InputField
        label="Date de début"
        name="startDate"
        type="date"
        required
        defaultValue={todayIso()}
      />
      <InputField label="Date de fin" name="endDate" type="date" optional error={err('endDate')} />
      <InputField label="Heure de début" name="startTime" type="time" optional />
      <InputField label="Heure de fin" name="endTime" type="time" optional error={err('endTime')} />
      <SelectField
        label="Concerne"
        value={scope}
        onChange={(e) => setScope(e.target.value as Scope)}
      >
        <option value="SCHOOL">Toute l’école</option>
        <option value="CYCLE">Un cycle</option>
        <option value="LEVEL">Un niveau</option>
        <option value="CLASS">Une classe</option>
      </SelectField>
      {scope !== 'SCHOOL' ? (
        <SelectField
          key={scope}
          label={scope === 'CLASS' ? 'Classe' : scope === 'LEVEL' ? 'Niveau' : 'Cycle'}
          name="targetId"
          required
          defaultValue=""
        >
          <option value="">Choisir…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <TextareaField
        label="Description"
        name="description"
        optional
        maxLength={2000}
        containerClassName="sm:col-span-2"
      />
      <Checkbox
        name="remindBySms"
        label="Envoyer un rappel aux parents concernés la veille (SMS ou e-mail)"
        className="sm:col-span-2"
      />
      <Button type="submit" loading={create.isPending} className="sm:col-span-2">
        Ajouter au calendrier
      </Button>
    </form>
  );
}

export default function CalendarPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState<Month>(currentMonth);
  const [adding, setAdding] = useState(false);
  const range = monthBounds(month.year, month.month);
  const q = useQuery({
    queryKey: ['events', range.from],
    queryFn: () => api<SchoolEvent[]>(`/events?from=${range.from}&to=${range.to}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/events/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Événement supprimé');
      void queryClient.invalidateQueries({ queryKey: ['events'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const canWrite = can('communication.write');
  return (
    <>
      <PageHeader
        title="Calendrier"
        subtitle="Réunions de parents, congés, fêtes et sorties, visibles sur le portail des parents concernés."
        actions={
          canWrite ? (
            <Button onClick={() => setAdding(true)}>
              <CalendarPlus className="size-4" aria-hidden />
              Nouvel événement
            </Button>
          ) : null
        }
      />
      {q.isError ? <ErrorBlock error={q.error} onRetry={() => q.refetch()} /> : null}
      <EventCalendar
        events={q.data ?? []}
        month={month}
        onMonthChange={setMonth}
        loading={q.isPending}
        actionFor={
          canWrite
            ? (e) => (
                <Button
                  variant="danger"
                  size="sm"
                  loading={remove.isPending && remove.variables === e.id}
                  onClick={() => {
                    if (window.confirm(`Supprimer « ${e.title} » du calendrier ?`))
                      remove.mutate(e.id);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Supprimer
                </Button>
              )
            : undefined
        }
      />
      {q.isPending ? <LoadingBlock /> : null}
      <Sheet open={adding} onClose={() => setAdding(false)} title="Nouvel événement">
        {adding ? <EventForm onDone={() => setAdding(false)} /> : null}
      </Sheet>
    </>
  );
}
