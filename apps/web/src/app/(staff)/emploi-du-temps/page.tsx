'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCurrentStructure } from '@/lib/queries';
import { cn } from '@/lib/utils';

interface Entry {
  id: string;
  classId: string;
  classSubjectId: string;
  teacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

const DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const GROUP_TONE: Record<string, string> = {
  LITERARY: 'bg-info-soft',
  SCIENTIFIC: 'bg-primary-soft',
  OTHER: 'bg-neutral-soft',
};
const CONFLICT: Record<string, string> = {
  teacher: 'l’enseignant a déjà cours',
  room: 'la salle est occupée',
  class: 'la classe a déjà cours',
};

export default function TimetablePage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const structure = useCurrentStructure();
  const [classId, setClassId] = useState('');
  const today = ((new Date().getDay() + 6) % 7) + 1;
  const [day, setDay] = useState(today > 6 ? 1 : today);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!classId && structure.data?.classes[0]) setClassId(structure.data.classes[0].id);
  }, [structure.data, classId]);

  const entries = useQuery({
    queryKey: ['timetable', classId],
    queryFn: () => api<Entry[]>(`/timetable/entries?classId=${classId}`),
    enabled: !!classId,
  });
  const rooms = useQuery({
    queryKey: ['rooms'],
    queryFn: () => api<{ id: string; name: string }[]>('/timetable/rooms'),
  });
  const cls = structure.data?.classes.find((c) => c.id === classId);
  const subjectOf = useMemo(() => new Map(cls?.subjects.map((s) => [s.id, s]) ?? []), [cls]);

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/timetable/entries', { method: 'POST', body }),
    onSuccess: () => {
      setAddOpen(false);
      setError(null);
      toast('Cours ajouté');
      void queryClient.invalidateQueries({ queryKey: ['timetable'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && Array.isArray(e.body.conflicts)) {
        setError(
          `Conflit : ${(e.body.conflicts as { kind: string }[]).map((c) => CONFLICT[c.kind] ?? c.kind).join(', ')} sur ce créneau.`,
        );
      } else setError(e instanceof Error ? e.message : 'Erreur');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/timetable/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['timetable'] }),
  });

  const byDay = (d: number) =>
    (entries.data ?? [])
      .filter((e) => e.dayOfWeek === d)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const lesson = (e: Entry) => {
    const s = subjectOf.get(e.classSubjectId);
    return (
      <div
        key={e.id}
        className={cn(
          'flex items-start gap-2 rounded-[10px] p-2.5',
          GROUP_TONE[s?.subject.group ?? 'OTHER'],
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <strong className="text-sm">{s?.subject.name ?? 'Matière'}</strong>
          <span className="text-xs text-muted tabular">
            {e.startTime}–{e.endTime}
            {e.roomId ? ` · ${rooms.data?.find((r) => r.id === e.roomId)?.name ?? ''}` : ''}
          </span>
        </div>
        {can('academic.write') ? (
          <button
            type="button"
            aria-label="Retirer ce cours"
            className="flex size-9 items-center justify-center rounded-[8px] text-muted hover:bg-white/60"
            onClick={() => remove.mutate(e.id)}
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Emploi du temps"
        subtitle="Les conflits d’enseignant, de salle et de classe sont refusés à l’enregistrement."
        actions={
          can('academic.write') && classId ? (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Ajouter un cours
            </Button>
          ) : undefined
        }
      />
      <SelectField
        label="Classe"
        value={classId}
        onChange={(e) => setClassId(e.target.value)}
        containerClassName="sm:max-w-xs"
      >
        {structure.data?.classes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      {entries.isPending ? (
        <LoadingBlock />
      ) : entries.isError ? (
        <ErrorBlock error={entries.error} />
      ) : entries.data.length === 0 ? (
        <EmptyState title="Aucun cours pour cette classe" />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:hidden">
            <div role="tablist" className="-mx-4 flex gap-2 overflow-x-auto px-4">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={day === i + 1}
                  onClick={() => setDay(i + 1)}
                  className={cn(
                    'min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold',
                    day === i + 1
                      ? 'border-primary bg-primary text-white'
                      : 'border-line-strong bg-white',
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
            <Card className="flex flex-col gap-2">
              {byDay(day).length ? (
                byDay(day).map(lesson)
              ) : (
                <p className="text-sm text-muted">Pas de cours ce jour-là.</p>
              )}
            </Card>
          </div>
          <div className="hidden grid-cols-6 gap-3 lg:grid">
            {DAYS.map((d, i) => (
              <div key={d} className="flex flex-col gap-2">
                <h2 className="text-center text-sm font-bold">{d}</h2>
                {byDay(i + 1).map(lesson)}
              </div>
            ))}
          </div>
        </>
      )}

      <Sheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={`Ajouter un cours · ${cls?.name ?? ''}`}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            add.mutate({
              classSubjectId: fd.get('classSubjectId'),
              dayOfWeek: Number(fd.get('dayOfWeek')),
              startTime: fd.get('startTime'),
              endTime: fd.get('endTime'),
              roomId: fd.get('roomId') || undefined,
            });
          }}
        >
          {error ? (
            <p role="alert" className="rounded-[10px] bg-danger-soft p-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <SelectField label="Matière" name="classSubjectId" required>
            {cls?.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.subject.name}
              </option>
            ))}
          </SelectField>
          <SelectField label="Jour" name="dayOfWeek" defaultValue={String(day)}>
            {DAYS.map((d, i) => (
              <option key={d} value={i + 1}>
                {d}
              </option>
            ))}
          </SelectField>
          <div className="grid grid-cols-2 gap-3">
            <InputField label="Début" name="startTime" type="time" defaultValue="07:30" required />
            <InputField label="Fin" name="endTime" type="time" defaultValue="08:25" required />
          </div>
          <SelectField label="Salle" name="roomId" optional>
            <option value="">Aucune</option>
            {rooms.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </SelectField>
          <Button type="submit" loading={add.isPending}>
            Ajouter
          </Button>
        </form>
      </Sheet>
    </>
  );
}
