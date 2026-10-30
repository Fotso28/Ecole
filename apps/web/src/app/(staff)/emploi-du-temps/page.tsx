'use client';

import { checkMove, gridStartTimes, type MoveConflict } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Move, Plus, Trash2 } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
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

interface Planning {
  entries: Entry[];
  maxWeeklyMinutes: Record<string, number>;
}

interface Target {
  dayOfWeek: number;
  startTime: string;
}

/** Cours en cours de glissement : position du doigt ou de la souris et créneau survolé. */
interface DragState {
  entry: Entry;
  x: number;
  y: number;
  target: Target | null;
  conflicts: MoveConflict[];
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
  load: 'la charge horaire de l’enseignant est dépassée',
};
/** Déplacement minimal (px) avant de considérer un appui comme un glisser. */
const DRAG_THRESHOLD = 6;

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
  const [moving, setMoving] = useState<Entry | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<{ entry: Entry; x: number; y: number; pointerId: number } | null>(null);
  // Dernier état du glisser, lu au relâchement sans dépendre du rendu en cours.
  const dragRef = useRef<DragState | null>(null);
  const editable = can('academic.write');

  useEffect(() => {
    if (!classId && structure.data?.classes[0]) setClassId(structure.data.classes[0].id);
  }, [structure.data, classId]);

  const planning = useQuery({
    queryKey: ['timetable', 'planning'],
    queryFn: () => api<Planning>('/timetable/planning'),
  });
  const rooms = useQuery({
    queryKey: ['rooms'],
    queryFn: () => api<{ id: string; name: string }[]>('/timetable/rooms'),
  });
  const cls = structure.data?.classes.find((c) => c.id === classId);
  const subjectOf = useMemo(
    () => new Map(structure.data?.classes.flatMap((c) => c.subjects.map((s) => [s.id, s])) ?? []),
    [structure.data],
  );
  const classNameOf = useMemo(
    () => new Map(structure.data?.classes.map((c) => [c.id, c.name]) ?? []),
    [structure.data],
  );
  const all = useMemo(() => planning.data?.entries ?? [], [planning.data]);
  const entries = useMemo(() => all.filter((e) => e.classId === classId), [all, classId]);
  const rows = useMemo(() => gridStartTimes(entries), [entries]);

  const conflictText = (conflicts: { kind: string; entryId?: string; slotId?: string }[]) =>
    conflicts
      .map((c) => {
        const other = all.find((e) => e.id === (c.slotId ?? c.entryId));
        const where =
          other && other.classId !== classId ? ` (${classNameOf.get(other.classId)})` : '';
        return `${CONFLICT[c.kind] ?? c.kind}${where}`;
      })
      .join(', ');

  const check = (entry: Entry, target: Target): MoveConflict[] => {
    try {
      return checkMove(all, entry.id, target, planning.data?.maxWeeklyMinutes).conflicts;
    } catch {
      return [{ kind: 'class' }];
    }
  };

  const onApiConflict = (e: unknown) =>
    e instanceof ApiError && Array.isArray(e.body.conflicts)
      ? `Conflit : ${conflictText(e.body.conflicts as { kind: string; entryId?: string }[])}.`
      : e instanceof Error
        ? e.message
        : 'Erreur';

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/timetable/entries', { method: 'POST', body }),
    onSuccess: () => {
      setAddOpen(false);
      setError(null);
      toast('Cours ajouté');
      void queryClient.invalidateQueries({ queryKey: ['timetable'] });
    },
    onError: (e) => setError(onApiConflict(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/timetable/entries/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['timetable'] }),
  });
  const move = useMutation({
    mutationFn: ({ id, target }: { id: string; target: Target }) =>
      api<Entry>(`/timetable/entries/${id}`, { method: 'PATCH', body: target }),
    onSuccess: (entry) => {
      setMoving(null);
      toast(`Cours déplacé au ${DAYS[entry.dayOfWeek - 1]?.toLowerCase()} à ${entry.startTime}`);
      queryClient.setQueryData<Planning>(['timetable', 'planning'], (old) =>
        old ? { ...old, entries: old.entries.map((e) => (e.id === entry.id ? entry : e)) } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ['timetable'] });
    },
    onError: (e) => toast(`Déplacement impossible. ${onApiConflict(e)}`, 'error'),
  });

  // ------------------------------------------------------------- Glisser-déposer (souris et doigt)

  const targetAt = (x: number, y: number, entry: Entry): Target | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-day]');
    if (!el) return null;
    return {
      dayOfWeek: Number(el.dataset.dropDay),
      // Onglet de jour (téléphone) : même heure, autre jour.
      startTime: el.dataset.dropStart || entry.startTime,
    };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, entry: Entry) => {
    if (!editable || move.isPending || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pending.current = { entry, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const start = pending.current;
    if (!start || start.pointerId !== e.pointerId) return;
    if (!dragRef.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD)
      return;
    e.preventDefault();
    const target = targetAt(e.clientX, e.clientY, start.entry);
    const same =
      target?.dayOfWeek === start.entry.dayOfWeek && target.startTime === start.entry.startTime;
    const next: DragState = {
      entry: start.entry,
      x: e.clientX,
      y: e.clientY,
      target: target && !same ? target : null,
      conflicts: target && !same ? check(start.entry, target) : [],
    };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const start = pending.current;
    if (!start || start.pointerId !== e.pointerId) return;
    pending.current = null;
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (cancelled || !current?.target) return;
    if (current.conflicts.length > 0) {
      toast(`Déplacement impossible : ${conflictText(current.conflicts)}.`, 'error');
      return;
    }
    move.mutate({ id: current.entry.id, target: current.target });
  };

  const dropState = (dayOfWeek: number, startTime?: string) => {
    if (!drag?.target || drag.target.dayOfWeek !== dayOfWeek) return null;
    if (startTime !== undefined && drag.target.startTime !== startTime) return null;
    return drag.conflicts.length ? 'conflict' : 'ok';
  };
  const dropClass = (state: 'ok' | 'conflict' | null) =>
    state === 'ok'
      ? 'outline-2 outline-primary bg-primary-soft/60'
      : state === 'conflict'
        ? 'outline-2 outline-danger bg-danger-soft'
        : '';

  // ------------------------------------------------------------- Affichage

  const lesson = (e: Entry) => {
    const s = subjectOf.get(e.classSubjectId);
    const name = s?.subject.name ?? 'Matière';
    const dragging = drag?.entry.id === e.id;
    return (
      <div
        key={e.id}
        data-lesson={e.id}
        className={cn(
          'flex items-center gap-1 rounded-[10px] p-1.5',
          GROUP_TONE[s?.subject.group ?? 'OTHER'],
          dragging && 'opacity-40',
        )}
      >
        {editable ? (
          <span
            aria-hidden
            data-drag-handle
            title="Glisser pour déplacer"
            onPointerDown={(ev) => onPointerDown(ev, e)}
            onPointerMove={onPointerMove}
            onPointerUp={(ev) => endDrag(ev)}
            onPointerCancel={(ev) => endDrag(ev, true)}
            className="flex min-h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-[8px] text-muted hover:bg-white/60 active:cursor-grabbing"
          >
            <GripVertical className="size-4" />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col py-1 pl-1">
          <strong className="truncate text-sm">{name}</strong>
          <span className="truncate text-xs text-muted tabular">
            {e.startTime}–{e.endTime}
            {e.roomId ? ` · ${rooms.data?.find((r) => r.id === e.roomId)?.name ?? ''}` : ''}
          </span>
        </div>
        {editable ? (
          <>
            <button
              type="button"
              aria-label={`Déplacer ${name} du ${DAYS[e.dayOfWeek - 1]?.toLowerCase()} ${e.startTime}`}
              title="Déplacer"
              className="flex size-11 shrink-0 items-center justify-center rounded-[8px] text-muted hover:bg-white/60"
              onClick={() => setMoving(e)}
            >
              <Move className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Retirer ${name} du ${DAYS[e.dayOfWeek - 1]?.toLowerCase()} ${e.startTime}`}
              className="flex size-11 shrink-0 items-center justify-center rounded-[8px] text-muted hover:bg-white/60"
              onClick={() => remove.mutate(e.id)}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </>
        ) : null}
      </div>
    );
  };

  const at = (d: number, time: string) =>
    entries.filter((e) => e.dayOfWeek === d && e.startTime === time);

  return (
    <>
      <PageHeader
        title="Emploi du temps"
        subtitle={
          editable
            ? 'Glissez un cours vers un autre créneau, ou utilisez « Déplacer ». Les conflits sont signalés et refusés.'
            : 'Les conflits d’enseignant, de salle et de classe sont refusés à l’enregistrement.'
        }
        actions={
          editable && classId ? (
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
      {planning.isPending ? (
        <LoadingBlock />
      ) : planning.isError ? (
        <ErrorBlock error={planning.error} />
      ) : entries.length === 0 ? (
        <EmptyState title="Aucun cours pour cette classe" />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:hidden">
            <div role="tablist" aria-label="Jour" className="-mx-4 flex gap-2 overflow-x-auto px-4">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={day === i + 1}
                  data-drop-day={i + 1}
                  data-drop-start=""
                  onClick={() => setDay(i + 1)}
                  className={cn(
                    'min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold',
                    day === i + 1
                      ? 'border-primary bg-primary text-white'
                      : 'border-line-strong bg-white',
                    drag && drag.target?.dayOfWeek === i + 1 && dropClass(dropState(i + 1)),
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
            <ol
              aria-label={`Créneaux du ${DAYS[day - 1]?.toLowerCase()}`}
              className="flex flex-col gap-1.5"
            >
              {rows.map((time) => (
                <li
                  key={time}
                  data-drop-day={day}
                  data-drop-start={time}
                  className={cn(
                    'flex min-h-12 gap-2 rounded-[12px] border border-line bg-white p-1.5',
                    dropClass(dropState(day, time)),
                  )}
                >
                  <span className="w-11 shrink-0 pt-2 text-xs font-semibold text-muted tabular">
                    {time}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {at(day, time).map(lesson)}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="hidden lg:block">
            <table className="w-full table-fixed border-separate border-spacing-1.5 text-sm">
              <caption className="sr-only">
                Emploi du temps de la classe {cls?.name}, par jour et heure de début
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="w-16 text-left text-xs font-semibold text-muted">
                    Heure
                  </th>
                  {DAYS.map((d) => (
                    <th key={d} scope="col" className="text-center text-sm font-bold">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((time) => (
                  <tr key={time}>
                    <th
                      scope="row"
                      className="text-left align-top text-xs font-semibold text-muted tabular"
                    >
                      {time}
                    </th>
                    {DAYS.map((d, i) => (
                      <td
                        key={d}
                        data-drop-day={i + 1}
                        data-drop-start={time}
                        className={cn(
                          'h-14 rounded-[10px] border border-dashed border-line p-0 align-top',
                          dropClass(dropState(i + 1, time)),
                        )}
                      >
                        <div className="flex flex-col gap-1">{at(i + 1, time).map(lesson)}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {drag?.target
          ? drag.conflicts.length
            ? `Conflit : ${conflictText(drag.conflicts)}`
            : `${DAYS[drag.target.dayOfWeek - 1]} ${drag.target.startTime} : créneau libre`
          : ''}
      </p>

      {drag ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 flex max-w-64 flex-col gap-0.5 rounded-[10px] bg-night px-3 py-2 text-xs text-white shadow-lg"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          <strong className="text-sm">
            {subjectOf.get(drag.entry.classSubjectId)?.subject.name ?? 'Cours'}
          </strong>
          {drag.target ? (
            <span data-drag-status className={drag.conflicts.length ? 'text-[#ffb4a9]' : ''}>
              {DAYS[drag.target.dayOfWeek - 1]} {drag.target.startTime}
              {drag.conflicts.length ? ` · ${conflictText(drag.conflicts)}` : ' · libre'}
            </span>
          ) : (
            <span>Déposez sur un créneau</span>
          )}
        </div>
      ) : null}

      <MoveSheet
        entry={moving}
        name={moving ? (subjectOf.get(moving.classSubjectId)?.subject.name ?? 'Cours') : ''}
        rows={rows}
        check={check}
        conflictText={conflictText}
        pending={move.isPending}
        onClose={() => setMoving(null)}
        onMove={(target) => moving && move.mutate({ id: moving.id, target })}
      />

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

/** Alternative au glisser-déposer, au clavier et au lecteur d'écran : choix du jour et de l'heure. */
function MoveSheet({
  entry,
  name,
  rows,
  check,
  conflictText,
  pending,
  onClose,
  onMove,
}: {
  entry: Entry | null;
  name: string;
  rows: string[];
  check: (entry: Entry, target: Target) => MoveConflict[];
  conflictText: (conflicts: MoveConflict[]) => string;
  pending: boolean;
  onClose: () => void;
  onMove: (target: Target) => void;
}) {
  const [target, setTarget] = useState<Target>({ dayOfWeek: 1, startTime: '07:30' });
  useEffect(() => {
    if (entry) setTarget({ dayOfWeek: entry.dayOfWeek, startTime: entry.startTime });
  }, [entry]);
  const unchanged =
    !!entry && target.dayOfWeek === entry.dayOfWeek && target.startTime === entry.startTime;
  const conflicts = entry && !unchanged ? check(entry, target) : [];
  return (
    <Sheet
      open={!!entry}
      onClose={onClose}
      title={entry ? `Déplacer ${name} · ${DAYS[entry.dayOfWeek - 1]} ${entry.startTime}` : ''}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!unchanged && conflicts.length === 0) onMove(target);
        }}
      >
        <SelectField
          label="Nouveau jour"
          value={String(target.dayOfWeek)}
          onChange={(e) => setTarget({ ...target, dayOfWeek: Number(e.target.value) })}
        >
          {DAYS.map((d, i) => (
            <option key={d} value={i + 1}>
              {d}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Nouvelle heure de début"
          value={target.startTime}
          onChange={(e) => setTarget({ ...target, startTime: e.target.value })}
        >
          {rows.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </SelectField>
        <p
          role="status"
          aria-live="polite"
          className={cn(
            'rounded-[10px] p-3 text-sm',
            unchanged
              ? 'bg-paper text-muted'
              : conflicts.length
                ? 'bg-danger-soft text-danger'
                : 'bg-primary-soft text-primary',
          )}
        >
          {unchanged
            ? 'Choisissez un autre créneau.'
            : conflicts.length
              ? `Conflit : ${conflictText(conflicts)}.`
              : 'Créneau libre : aucun conflit.'}
        </p>
        <Button type="submit" loading={pending} disabled={unchanged || conflicts.length > 0}>
          Déplacer ici
        </Button>
      </form>
    </Sheet>
  );
}
