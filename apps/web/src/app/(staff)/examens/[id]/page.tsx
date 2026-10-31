'use client';

import { formatAnonymityCode } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  EyeOff,
  Lock,
  Plus,
  Printer,
  Shuffle,
  Trash2,
  TriangleAlert,
  UserCheck,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { Checkbox, InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, openPdf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  useExamSession,
  type ExamPaperDetail,
  type ExamResults,
  type ExamSessionDetail,
  type Seating,
  type SeatingCandidate,
} from '@/lib/exams';
import { formatGrade, formatShortDate, formatWeekday, plural } from '@/lib/format';
import { useCurrentStructure } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Tab = 'calendar' | 'rooms' | 'supervisors' | 'results' | 'documents';
const TABS: { id: Tab; label: string }[] = [
  { id: 'calendar', label: 'Calendrier' },
  { id: 'rooms', label: 'Salles et places' },
  { id: 'supervisors', label: 'Surveillants' },
  { id: 'results', label: 'Résultats' },
  { id: 'documents', label: 'Documents' },
];

/** Message de l'API, ou le premier motif précis d'une saisie refusée. */
const errorMessage = (e: unknown) =>
  e instanceof ApiError && e.fieldErrors[0]
    ? e.fieldErrors[0].message
    : e instanceof Error
      ? e.message
      : 'Erreur';

export default function ExamSessionPage() {
  const { id } = useParams<{ id: string }>();
  const q = useExamSession(id);
  const [tab, setTab] = useState<Tab>('calendar');
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  // Volets refusés (enseignant non surveillant, résultats non publiés) : non proposés.
  const tabs = TABS.filter(
    (t) =>
      (t.id !== 'rooms' || s.access?.seating !== false) &&
      (t.id !== 'results' || s.access?.results !== false),
  );
  const current = tabs.some((t) => t.id === tab) ? tab : 'calendar';
  return (
    <>
      <div className="flex flex-col gap-2">
        <Link
          href="/examens"
          className="flex min-h-11 items-center gap-1.5 self-start text-sm font-semibold text-primary"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Toutes les sessions
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-[26px] leading-tight font-bold tracking-tight lg:text-3xl">
            {s.name}
          </h1>
          <Badge tone={s.published ? 'night' : 'warn'}>
            {s.published ? 'Résultats publiés' : 'En préparation'}
          </Badge>
        </div>
        <p className="text-sm text-muted [overflow-wrap:anywhere]">
          {s.kindLabel} · du {formatShortDate(s.startDate)} au {formatShortDate(s.endDate)} ·{' '}
          {s.classes.map((c) => c.name).join(', ')}
          {s.sequence ? ` · ${s.sequence.name}` : ''}
        </p>
      </div>

      {s.conflicts.length > 0 ? (
        <section
          role="alert"
          className="flex gap-2.5 rounded-[16px] border border-[#f1d99a] bg-warn-soft p-4"
        >
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <div className="flex flex-col gap-1">
            <h2 className="font-bold">{plural(s.conflicts.length, 'conflit', 'conflits')}</h2>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {s.conflicts.map((c) => (
                <li key={c.message} className="[overflow-wrap:anywhere]">
                  {c.message}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <div
        role="tablist"
        aria-label="Volets de la session"
        className="-mx-4 flex gap-2 overflow-x-auto px-4"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={current === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              'min-h-11 shrink-0 rounded-full border px-4 text-sm font-semibold',
              current === t.id
                ? 'border-primary bg-primary text-white'
                : 'border-line-strong bg-white',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`panel-${current}`}
        aria-labelledby={`tab-${current}`}
        className="flex flex-col gap-4"
      >
        {current === 'calendar' ? <CalendarTab session={s} /> : null}
        {current === 'rooms' ? <RoomsTab session={s} /> : null}
        {current === 'supervisors' ? <SupervisorsTab session={s} /> : null}
        {current === 'results' ? <ResultsTab session={s} /> : null}
        {current === 'documents' ? <DocumentsTab session={s} /> : null}
      </div>
    </>
  );
}

function useRefresh(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['exam-session', id] });
    void queryClient.invalidateQueries({ queryKey: ['exam-seating', id] });
    void queryClient.invalidateQueries({ queryKey: ['exam-results', id] });
    void queryClient.invalidateQueries({ queryKey: ['exam-staff'] });
  };
}

function editable(s: ExamSessionDetail, can: (p: 'exams.manage') => boolean) {
  return can('exams.manage') && !s.published;
}

// ---------------------------------------------------------------------------
// Calendrier
// ---------------------------------------------------------------------------

function CalendarTab({ session: s }: { session: ExamSessionDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const refresh = useRefresh(s.id);
  const structure = useCurrentStructure();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subjects = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of structure.data?.classes ?? []) {
      if (!s.classes.some((x) => x.id === c.id)) continue;
      for (const cs of c.subjects) map.set(cs.subject.id, cs.subject.name);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  }, [structure.data, s.classes]);
  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/exams/sessions/${s.id}/papers`, { method: 'POST', body }),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      toast('Épreuve ajoutée');
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (paperId: string) => api(`/exams/papers/${paperId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Épreuve retirée');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const days = [...new Set(s.papers.map((p) => p.date))];

  return (
    <>
      {editable(s, can) ? (
        <Button className="self-start" onClick={() => setOpen(true)}>
          <Plus className="size-4" aria-hidden />
          Ajouter une épreuve
        </Button>
      ) : null}
      {s.papers.length === 0 ? (
        <EmptyState title="Aucune épreuve planifiée" />
      ) : (
        days.map((day) => (
          <Card key={day}>
            <CardHeader title={formatWeekday(day).replace(/^./, (c) => c.toUpperCase())} />
            <ul className="flex flex-col">
              {s.papers
                .filter((p) => p.date === day)
                .map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0"
                  >
                    <CalendarClock className="size-5 shrink-0 text-primary" aria-hidden />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <strong className="tabular">
                        {p.startTime}–{p.endTime} · {p.subjectName}
                      </strong>
                      <span className="text-[13px] text-muted [overflow-wrap:anywhere]">
                        {p.classes.map((c) => c.name).join(', ')} · sur {p.maxScore} · {p.scores}/
                        {p.expected} notes saisies
                      </span>
                    </div>
                    {editable(s, can) && p.scores === 0 ? (
                      <button
                        type="button"
                        aria-label={`Retirer l’épreuve ${p.subjectName}`}
                        className="flex size-11 items-center justify-center rounded-[10px] text-muted hover:bg-paper"
                        onClick={() => remove.mutate(p.id)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    ) : null}
                  </li>
                ))}
            </ul>
          </Card>
        ))
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Ajouter une épreuve">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const classIds = fd.getAll('classIds');
            add.mutate({
              subjectId: fd.get('subjectId'),
              date: fd.get('date'),
              startTime: fd.get('startTime'),
              durationMinutes: Number(fd.get('durationMinutes')),
              maxScore: Number(fd.get('maxScore')),
              classIds: classIds.length ? classIds : undefined,
            });
          }}
        >
          {error ? (
            <p role="alert" className="rounded-[10px] bg-danger-soft p-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <SelectField label="Matière" name="subjectId" required>
            {subjects.map(([sid, name]) => (
              <option key={sid} value={sid}>
                {name}
              </option>
            ))}
          </SelectField>
          <InputField
            label="Date"
            name="date"
            type="date"
            min={s.startDate}
            max={s.endDate}
            defaultValue={s.startDate}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <InputField label="Début" name="startTime" type="time" defaultValue="08:00" required />
            <SelectField label="Durée" name="durationMinutes" defaultValue="120">
              {[60, 90, 120, 150, 180, 240].map((m) => (
                <option key={m} value={m}>
                  {m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h 30`}
                </option>
              ))}
            </SelectField>
          </div>
          <InputField
            label="Barème"
            name="maxScore"
            type="number"
            min={1}
            max={100}
            defaultValue={20}
            required
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-semibold lg:text-[13px]">
              Classes{' '}
              <span className="font-medium text-muted">
                (facultatif : par défaut, toutes celles qui étudient la matière)
              </span>
            </legend>
            <div className="grid grid-cols-2 gap-x-3">
              {s.classes.map((c) => (
                <Checkbox key={c.id} name="classIds" value={c.id} label={c.name} />
              ))}
            </div>
          </fieldset>
          <Button type="submit" loading={add.isPending}>
            Ajouter
          </Button>
        </form>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// Salles et places
// ---------------------------------------------------------------------------

function RoomsTab({ session: s }: { session: ExamSessionDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const refresh = useRefresh(s.id);
  const [roomOpen, setRoomOpen] = useState(false);
  const [moving, setMoving] = useState<SeatingCandidate | null>(null);
  const [mix, setMix] = useState(s.mixClasses);
  const rooms = useQuery({
    queryKey: ['exam-rooms'],
    queryFn: () => api<{ id: string; name: string; capacity: number | null }[]>('/exams/rooms'),
  });
  const seating = useQuery({
    queryKey: ['exam-seating', s.id],
    queryFn: () => api<Seating>(`/exams/sessions/${s.id}/seating`),
  });
  const addRoom = useMutation({
    mutationFn: async (body: { roomId?: string; name?: string; capacity?: number }) => {
      let roomId = body.roomId;
      if (!roomId && body.name) {
        roomId = (
          await api<{ id: string }>('/exams/rooms', {
            method: 'POST',
            body: { name: body.name, capacity: body.capacity },
          })
        ).id;
      }
      return api(`/exams/sessions/${s.id}/rooms`, {
        method: 'POST',
        body: { roomId, capacity: body.capacity },
      });
    },
    onSuccess: () => {
      setRoomOpen(false);
      toast('Salle ajoutée');
      void rooms.refetch();
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const removeRoom = useMutation({
    mutationFn: (roomId: string) =>
      api(`/exams/sessions/${s.id}/rooms/${roomId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const seat = useMutation({
    mutationFn: () =>
      api<{ candidates: number }>(`/exams/sessions/${s.id}/seating`, {
        method: 'POST',
        body: { mixClasses: mix },
      }),
    onSuccess: (r) => {
      toast(`${plural(r.candidates, 'candidat placé', 'candidats placés')}`);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const move = useMutation({
    mutationFn: (body: { roomId: string; seat: number }) =>
      api<{ swapped: boolean }>(`/exams/candidates/${moving?.id}/seat`, { method: 'PUT', body }),
    onSuccess: (r) => {
      setMoving(null);
      toast(r.swapped ? 'Places échangées' : 'Candidat déplacé');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const capacity = s.rooms.reduce((n, r) => n + r.capacity, 0);
  const canEdit = editable(s, can);
  const available = rooms.data?.filter((r) => !s.rooms.some((x) => x.id === r.id)) ?? [];

  return (
    <>
      <Card>
        <CardHeader
          title="Salles de la session"
          subtitle={
            s.candidates > 0
              ? `${plural(capacity, 'place', 'places')} pour ${plural(s.candidates, 'candidat', 'candidats')}`
              : plural(capacity, 'place', 'places')
          }
          action={
            canEdit ? (
              <Button size="sm" variant="secondary" onClick={() => setRoomOpen(true)}>
                <Plus className="size-4" aria-hidden />
                Salle
              </Button>
            ) : undefined
          }
        />
        {s.rooms.length === 0 ? (
          <p className="text-sm text-muted">Aucune salle : ajoutez les salles d’examen.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {s.rooms.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 rounded-[12px] border border-line p-3"
              >
                <span className="flex flex-1 flex-col">
                  <strong>{r.name}</strong>
                  <span className="text-[13px] text-muted tabular">
                    {r.seated}/{r.capacity} places occupées
                  </span>
                </span>
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={`Retirer la salle ${r.name}`}
                    className="flex size-11 items-center justify-center rounded-[10px] text-muted hover:bg-paper"
                    onClick={() => removeRoom.mutate(r.id)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit && s.rooms.length > 0 ? (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Checkbox
              checked={mix}
              onChange={(e) => setMix(e.target.checked)}
              label="Mélanger les classes"
            />
            <Button onClick={() => seat.mutate()} loading={seat.isPending} className="sm:ml-auto">
              <Shuffle className="size-4" aria-hidden />
              Répartir les candidats
            </Button>
          </div>
        ) : null}
      </Card>

      {seating.isPending ? (
        <LoadingBlock />
      ) : seating.isError ? (
        <ErrorBlock error={seating.error} />
      ) : seating.data.rooms.every((r) => r.candidates.length === 0) ? (
        <EmptyState title="Candidats non répartis">
          La répartition inscrit les élèves des classes et leur attribue une place.
        </EmptyState>
      ) : (
        seating.data.rooms
          .filter((r) => r.candidates.length > 0)
          .map((r) => (
            <Card key={r.id}>
              <CardHeader
                title={`Salle ${r.name}`}
                subtitle={`${r.candidates.length}/${r.capacity} places`}
              />
              <ul className="flex flex-col lg:hidden">
                {r.candidates.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 border-t border-line py-2 first:border-t-0"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-paper font-bold tabular">
                      {c.seat}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <strong className="truncate text-[15px]">{c.name}</strong>
                      <span className="text-[13px] text-muted">{c.className}</span>
                    </span>
                    {canEdit ? (
                      <Button size="sm" variant="secondary" onClick={() => setMoving(c)}>
                        Déplacer
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <table className="hidden w-full text-sm lg:table">
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Place
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Élève
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Matricule
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Classe
                    </th>
                    {canEdit ? (
                      <th scope="col" className="py-2 font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {r.candidates.map((c) => (
                    <tr key={c.id} className="border-b border-line last:border-0">
                      <td className="py-1.5 pr-3 tabular">{c.seat}</td>
                      <td className="py-1.5 pr-3 font-semibold">{c.name}</td>
                      <td className="py-1.5 pr-3 text-muted">{c.matricule}</td>
                      <td className="py-1.5 pr-3">{c.className}</td>
                      {canEdit ? (
                        <td className="py-1.5 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setMoving(c)}
                            aria-label={`Déplacer ${c.name}`}
                          >
                            Déplacer
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))
      )}

      <AddRoomSheet
        open={roomOpen}
        onClose={() => setRoomOpen(false)}
        rooms={available}
        pending={addRoom.isPending}
        onSubmit={(body) => addRoom.mutate(body)}
      />

      <Sheet
        open={!!moving}
        onClose={() => setMoving(null)}
        title={`Déplacer · ${moving?.name ?? ''}`}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            move.mutate({ roomId: String(fd.get('roomId')), seat: Number(fd.get('seat')) });
          }}
        >
          <SelectField
            label="Salle"
            name="roomId"
            defaultValue={
              seating.data?.rooms.find((r) => r.candidates.some((c) => c.id === moving?.id))?.id
            }
          >
            {s.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </SelectField>
          <InputField
            label="Place n°"
            name="seat"
            type="number"
            min={1}
            defaultValue={moving?.seat ?? 1}
            hint="Si la place est occupée, les deux candidats échangent leurs places."
            required
          />
          <Button type="submit" loading={move.isPending}>
            Déplacer
          </Button>
        </form>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// Surveillants
// ---------------------------------------------------------------------------

function SupervisorsTab({ session: s }: { session: ExamSessionDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const refresh = useRefresh(s.id);
  const canEdit = editable(s, can);
  const staff = useQuery({
    queryKey: ['exam-staff'],
    queryFn: () =>
      api<{ id: string; name: string; loadMinutes: number; supervisions: number }[]>(
        '/exams/staff',
      ),
    enabled: can('exams.manage'),
  });
  const auto = useMutation({
    mutationFn: () =>
      api<{ assigned: number; unfilled: number }>(`/exams/sessions/${s.id}/supervisors/auto`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      toast(
        r.unfilled > 0
          ? `${plural(r.assigned, 'surveillance attribuée', 'surveillances attribuées')} · ${r.unfilled} poste(s) sans surveillant disponible`
          : `${plural(r.assigned, 'surveillance attribuée', 'surveillances attribuées')}`,
        r.unfilled > 0 ? 'error' : undefined,
      );
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const add = useMutation({
    mutationFn: (body: { paperId: string; roomId: string; userId: string }) =>
      api('/exams/supervisions', { method: 'POST', body }),
    onSuccess: () => {
      toast('Surveillant ajouté');
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/exams/supervisions/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <>
      {canEdit ? (
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            La répartition automatique complète{' '}
            {plural(s.supervisorsPerRoom, 'surveillant', 'surveillants')} par salle et par épreuve,
            en confiant d’abord les surveillances aux enseignants les moins chargés et en évitant
            l’enseignant de la matière.
          </p>
          <Button className="self-start" onClick={() => auto.mutate()} loading={auto.isPending}>
            <UserCheck className="size-4" aria-hidden />
            Répartir les surveillants
          </Button>
        </Card>
      ) : null}
      {s.papers.every((p) => p.rooms.length === 0) ? (
        <EmptyState title="Aucune salle occupée">Répartissez d’abord les candidats.</EmptyState>
      ) : (
        s.papers.map((p) => (
          <Card key={p.id}>
            <CardHeader
              title={`${p.subjectName} · ${formatShortDate(p.date)}`}
              subtitle={`${p.startTime}–${p.endTime}`}
            />
            <ul className="flex flex-col">
              {p.rooms.map((r) => (
                <SupervisionRow
                  key={r.id}
                  paper={p}
                  room={r}
                  canEdit={canEdit}
                  staff={staff.data ?? []}
                  onAdd={(userId) => add.mutate({ paperId: p.id, roomId: r.id, userId })}
                  onRemove={(id) => remove.mutate(id)}
                />
              ))}
            </ul>
          </Card>
        ))
      )}
      {staff.data && staff.data.length > 0 ? (
        <Card>
          <CardHeader
            title="Charge des enseignants"
            subtitle="Total des surveillances de l’année"
          />
          <ul className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            {staff.data.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 border-t border-line py-2 text-sm"
              >
                <span>{t.name}</span>
                <span className="text-muted tabular">
                  {Math.round(t.loadMinutes / 6) / 10} h · {t.supervisions}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function SupervisionRow({
  paper,
  room,
  canEdit,
  staff,
  onAdd,
  onRemove,
}: {
  paper: ExamPaperDetail;
  room: ExamPaperDetail['rooms'][number];
  canEdit: boolean;
  staff: { id: string; name: string }[];
  onAdd: (userId: string) => void;
  onRemove: (id: string) => void;
}) {
  const [userId, setUserId] = useState('');
  return (
    <li className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="min-w-20">Salle {room.name}</strong>
        {room.supervisors.length === 0 ? (
          <Badge tone="danger">Sans surveillant</Badge>
        ) : (
          room.supervisors.map((sup) => (
            <span
              key={sup.id}
              className="inline-flex min-h-9 items-center gap-1 rounded-full bg-primary-soft pr-1 pl-3 text-sm font-semibold text-primary"
            >
              {sup.name}
              {canEdit ? (
                <button
                  type="button"
                  aria-label={`Retirer ${sup.name} de la salle ${room.name}`}
                  onClick={() => onRemove(sup.id)}
                  className="flex size-8 items-center justify-center rounded-full hover:bg-white/70"
                >
                  <X className="size-4" aria-hidden />
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>
      {canEdit ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <SelectField
            label={`Ajouter un surveillant · ${paper.subjectName}, salle ${room.name}`}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            containerClassName="sm:max-w-sm sm:flex-1"
          >
            <option value="">Choisir…</option>
            {staff
              .filter((t) => !room.supervisors.some((x) => x.userId === t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </SelectField>
          <Button
            variant="secondary"
            disabled={!userId}
            onClick={() => {
              onAdd(userId);
              setUserId('');
            }}
          >
            Ajouter
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Résultats
// ---------------------------------------------------------------------------

function ResultsTab({ session: s }: { session: ExamSessionDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const refresh = useRefresh(s.id);
  const [publishOpen, setPublishOpen] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [transferWeight, setTransferWeight] = useState('1');
  const [transfer, setTransfer] = useState(!!s.sequence);
  const [reason, setReason] = useState('');
  const results = useQuery({
    queryKey: ['exam-results', s.id],
    queryFn: () => api<ExamResults>(`/exams/sessions/${s.id}/results`),
  });
  const publish = useMutation({
    mutationFn: () =>
      api<{ transfer: { created: unknown[]; skipped: { reason: string }[] } | null }>(
        `/exams/sessions/${s.id}/publish`,
        {
          method: 'POST',
          body: { transferToSequence: transfer && !!s.sequence, weight: Number(transferWeight) },
        },
      ),
    onSuccess: (r) => {
      setPublishOpen(false);
      toast(
        r.transfer
          ? `Résultats publiés · ${plural(r.transfer.created.length, 'évaluation reportée', 'évaluations reportées')} dans la séquence`
          : 'Résultats publiés · parents prévenus par SMS',
      );
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const transferNow = useMutation({
    mutationFn: () =>
      api<{ created: unknown[]; skipped: unknown[] }>(`/exams/sessions/${s.id}/transfer`, {
        method: 'POST',
        body: { weight: Number(transferWeight) },
      }),
    onSuccess: (r) => {
      toast(`${plural(r.created.length, 'évaluation reportée', 'évaluations reportées')}`);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const reveal = useMutation({
    mutationFn: () =>
      api<{ code: string; name: string; matricule: string; className: string }[]>(
        `/exams/sessions/${s.id}/anonymity/reveal`,
        { method: 'POST', body: { reason } },
      ),
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {can('exams.manage') && !s.published && results.data ? (
          <Button
            onClick={() => setPublishOpen(true)}
            disabled={results.data.missing > 0 || results.data.rows.length === 0}
          >
            <Lock className="size-4" aria-hidden />
            Publier les résultats
          </Button>
        ) : null}
        {can('exams.manage') && s.published && s.sequence ? (
          <Button
            variant="secondary"
            onClick={() => transferNow.mutate()}
            loading={transferNow.isPending}
          >
            Reporter dans la séquence
          </Button>
        ) : null}
        {can('exams.anonymity.reveal') ? (
          <Button
            variant="secondary"
            onClick={() => {
              reveal.reset();
              setReason('');
              setRevealOpen(true);
            }}
          >
            <EyeOff className="size-4" aria-hidden />
            Lever l’anonymat
          </Button>
        ) : null}
      </div>
      {results.isPending ? (
        <LoadingBlock />
      ) : results.isError ? (
        <ErrorBlock error={results.error} />
      ) : results.data.rows.length === 0 ? (
        <EmptyState title="Aucun candidat" />
      ) : (
        <ResultsList data={results.data} />
      )}

      <Sheet
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title="Publier les résultats ?"
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setPublishOpen(false)}>
              Annuler
            </Button>
            <Button onClick={() => publish.mutate()} loading={publish.isPending}>
              Publier
            </Button>
          </div>
        }
      >
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>
            Les résultats deviennent visibles des parents dans le portail ; ils reçoivent un SMS.
          </li>
          <li>Les noms des candidats apparaissent dans les résultats.</li>
          <li>Les notes et le calendrier sont ensuite figés.</li>
        </ul>
        {s.sequence ? (
          <div className="mt-4 flex flex-col gap-3">
            <Checkbox
              checked={transfer}
              onChange={(e) => setTransfer(e.target.checked)}
              label={`Reporter les notes dans « ${s.sequence.name} » (évaluations en brouillon, à soumettre puis valider)`}
            />
            {transfer ? (
              <SelectField
                label="Poids de l’évaluation dans la séquence"
                value={transferWeight}
                onChange={(e) => setTransferWeight(e.target.value)}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </SelectField>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <Sheet open={revealOpen} onClose={() => setRevealOpen(false)} title="Lever l’anonymat">
        {reveal.data ? (
          <ul className="flex flex-col">
            {reveal.data.map((r) => (
              <li
                key={r.code}
                className="flex items-center gap-3 border-t border-line py-2 first:border-t-0"
              >
                <code className="w-24 shrink-0 font-bold tabular">
                  {formatAnonymityCode(r.code)}
                </code>
                <span className="flex min-w-0 flex-col">
                  <strong className="truncate text-[15px]">{r.name}</strong>
                  <span className="text-[13px] text-muted">
                    {r.className} · {r.matricule}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              reveal.mutate();
            }}
          >
            <p className="text-sm text-muted">
              La correspondance entre numéros d’anonymat et élèves est réservée à la direction et au
              censeur. Chaque consultation est inscrite au journal d’audit avec son motif.
            </p>
            <TextareaField
              label="Motif"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={5}
              maxLength={300}
              required
            />
            <Button type="submit" loading={reveal.isPending} disabled={reason.trim().length < 5}>
              Afficher la correspondance
            </Button>
          </form>
        )}
      </Sheet>
    </>
  );
}

function ResultsList({ data }: { data: ExamResults }) {
  const label = (r: ExamResults['rows'][number]) =>
    r.name ?? (r.code ? `N° ${formatAnonymityCode(r.code)}` : '—');
  const head = (children: ReactNode, key?: string) => (
    <th key={key} scope="col" className="py-2 pr-3 font-semibold">
      {children}
    </th>
  );
  return (
    <>
      {!data.published ? (
        <p className="rounded-[12px] border border-line bg-info-soft px-4 py-3 text-sm">
          Avant publication, les candidats sont désignés par leur numéro d’anonymat
          {data.missing > 0
            ? ` · ${plural(data.missing, 'candidat incomplet', 'candidats incomplets')}`
            : ''}
          .
        </p>
      ) : null}
      <ul className="flex flex-col gap-2 lg:hidden">
        {data.rows.map((r) => (
          <li
            key={r.candidateId ?? r.code}
            className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-paper text-sm font-bold tabular">
                {r.rank ?? '—'}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="truncate">{label(r)}</strong>
                <span className="text-[13px] text-muted">{r.className}</span>
              </span>
              <strong className="text-lg tabular">{formatGrade(r.averageCenti)}</strong>
            </div>
            <p className="text-[13px] text-muted [overflow-wrap:anywhere]">
              {r.scores
                .map((sc) => {
                  const p = data.papers.find((x) => x.id === sc.paperId);
                  return `${p?.subjectName ?? ''} ${sc.value || '—'}/${p?.maxScore ?? 20}`;
                })
                .join(' · ')}
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-[14px] border border-line bg-white p-4 lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              {head('Rang')}
              {head(data.published ? 'Élève' : 'Numéro')}
              {head('Classe')}
              {data.papers.map((p) => head(`${p.subjectName} /${p.maxScore}`, p.id))}
              {head('Moyenne')}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.candidateId ?? r.code} className="border-b border-line last:border-0">
                <td className="py-1.5 pr-3 tabular">{r.rank ?? '—'}</td>
                <td className="py-1.5 pr-3 font-semibold">{label(r)}</td>
                <td className="py-1.5 pr-3">{r.className}</td>
                {data.papers.map((p) => (
                  <td key={p.id} className="py-1.5 pr-3 tabular">
                    {p.classIds.includes(r.classId)
                      ? r.scores.find((x) => x.paperId === p.id)?.value || '—'
                      : ''}
                  </td>
                ))}
                <td className="py-1.5 pr-3 font-bold tabular">{formatGrade(r.averageCenti)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function DocumentsTab({ session: s }: { session: ExamSessionDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const open = (path: string) => openPdf(path).catch((e) => toast(errorMessage(e), 'error'));
  const admin = can('exams.manage') || !can('exams.grade');
  return (
    <>
      {admin ? (
        <Card>
          <CardHeader
            title="Convocations"
            subtitle="Salle, place et calendrier de chaque élève · deux convocations par page A4"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void open(`/exams/sessions/${s.id}/convocations.pdf`)}
            >
              <Printer className="size-4" aria-hidden />
              Toute la session
            </Button>
            {s.classes.map((c) => (
              <Button
                key={c.id}
                variant="secondary"
                onClick={() =>
                  void open(`/exams/sessions/${s.id}/convocations.pdf?classId=${c.id}`)
                }
              >
                <Printer className="size-4" aria-hidden />
                {c.name}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Listes d’émargement" subtitle="Une liste par salle et par épreuve" />
        {s.papers.length === 0 ? (
          <p className="text-sm text-muted">Aucune épreuve planifiée.</p>
        ) : (
          <ul className="flex flex-col">
            {s.papers.map((p) => (
              <li
                key={p.id}
                className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0"
              >
                <strong className="text-[15px]">
                  {p.subjectName} · {formatShortDate(p.date)} · {p.startTime}
                </strong>
                <div className="flex flex-wrap gap-2">
                  {admin ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void open(`/exams/sessions/${s.id}/attendance-sheet.pdf?paperId=${p.id}`)
                      }
                    >
                      <Printer className="size-4" aria-hidden />
                      Toutes les salles
                    </Button>
                  ) : null}
                  {p.rooms
                    .filter(
                      (r) =>
                        !s.access?.attendanceRooms ||
                        s.access.attendanceRooms.some(
                          (a) => a.paperId === p.id && a.roomId === r.id,
                        ),
                    )
                    .map((r) => (
                      <Button
                        key={r.id}
                        size="sm"
                        variant="secondary"
                        aria-label={`Émargement ${p.subjectName}, salle ${r.name}`}
                        onClick={() =>
                          void open(
                            `/exams/sessions/${s.id}/attendance-sheet.pdf?paperId=${p.id}&roomId=${r.id}`,
                          )
                        }
                      >
                        Salle {r.name}
                      </Button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/**
 * Ajout d'une salle à la session : une salle existante, ou une nouvelle salle à nommer. La capacité
 * n'est facultative que si la salle choisie en a une d'enregistrée.
 */
function AddRoomSheet({
  open,
  onClose,
  rooms,
  pending,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  rooms: { id: string; name: string; capacity: number | null }[];
  pending: boolean;
  onSubmit: (body: { roomId?: string; name?: string; capacity?: number }) => void;
}) {
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [errors, setErrors] = useState<{ room?: string; capacity?: string }>({});
  const chosen = rooms.find((r) => r.id === roomId);
  const known = chosen?.capacity ?? null;
  const reset = () => {
    setRoomId('');
    setName('');
    setCapacity('');
    setErrors({});
  };
  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Ajouter une salle"
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const places = Number(capacity) || undefined;
          const next: typeof errors = {};
          if (!roomId && !name.trim())
            next.room = 'Choisissez une salle existante ou donnez le nom de la nouvelle salle.';
          if (!places && known === null)
            next.capacity = 'Indiquez le nombre de places pour l’examen.';
          else if (places !== undefined && (places < 1 || places > 500))
            next.capacity = 'Entre 1 et 500 places.';
          setErrors(next);
          if (next.room || next.capacity) return;
          onSubmit(roomId ? { roomId, capacity: places } : { name: name.trim(), capacity: places });
        }}
      >
        <SelectField
          label="Salle"
          value={roomId}
          onChange={(e) => {
            setRoomId(e.target.value);
            setErrors({});
          }}
        >
          <option value="">Nouvelle salle…</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {r.capacity ? ` (${r.capacity} places)` : ''}
            </option>
          ))}
        </SelectField>
        {roomId ? null : (
          <InputField
            label="Nom de la nouvelle salle"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, room: undefined }));
            }}
            maxLength={40}
            required
            aria-required
            error={errors.room}
            hint="Ou choisissez une salle existante dans la liste ci-dessus."
          />
        )}
        <InputField
          label="Places en configuration d’examen"
          type="number"
          min={1}
          max={500}
          value={capacity}
          onChange={(e) => {
            setCapacity(e.target.value);
            setErrors((x) => ({ ...x, capacity: undefined }));
          }}
          optional={known !== null}
          required={known === null}
          error={errors.capacity}
          hint={
            known !== null
              ? `Laissez vide pour garder la capacité enregistrée de la salle : ${known} places.`
              : chosen
                ? 'Cette salle n’a pas de capacité enregistrée : indiquez le nombre de places.'
                : 'Nombre de candidats que la salle peut accueillir pendant l’examen.'
          }
        />
        <Button type="submit" loading={pending}>
          Ajouter
        </Button>
      </form>
    </Sheet>
  );
}
