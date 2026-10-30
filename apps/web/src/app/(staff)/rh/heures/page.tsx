'use client';

import { formatMinutes, formatPayrollMonth } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, Plus, Trash2, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Stat,
} from '@/components/ui/card';
import { Checkbox, InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatShortDate, formatWeekday, todayIso } from '@/lib/format';
import { currentMonth, monthOptions, type HoursMonth } from '@/lib/hr';

type Lesson = HoursMonth['lessons'][number];

function LessonStatus({ lesson }: { lesson: Lesson }) {
  if (lesson.status === 'DONE') return <Badge tone="success">Fait</Badge>;
  if (lesson.status === 'ABSENT')
    return (
      <Badge tone={lesson.justified ? 'info' : 'danger'}>
        {lesson.justified ? 'Absence justifiée' : 'Absence non justifiée'}
      </Badge>
    );
  return <Badge tone="neutral">À confirmer</Badge>;
}

export default function HoursPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [teacherId, setTeacherId] = useState('');
  const [month, setMonth] = useState(currentMonth());
  const [absent, setAbsent] = useState<Lesson | null>(null);
  const [reason, setReason] = useState('');
  const [justified, setJustified] = useState(false);
  const [overtimeOpen, setOvertimeOpen] = useState(false);
  const teachers = useQuery({
    queryKey: ['hr', 'teachers'],
    queryFn: () => api<{ id: string; firstName: string; lastName: string }[]>('/hr/hours/teachers'),
  });
  useEffect(() => {
    if (!teacherId && teachers.data?.[0]) setTeacherId(teachers.data[0].id);
  }, [teachers.data, teacherId]);
  const key = ['hr', 'hours', teacherId, month];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<HoursMonth>(`/hr/hours?teacherId=${teacherId}&month=${month}`),
    enabled: !!teacherId,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['hr', 'hours'] });
  const onError = (e: unknown) => toast(e instanceof Error ? e.message : 'Erreur', 'error');
  const mark = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/hr/hours/lessons', { method: 'POST', body }),
    onSuccess: () => {
      void refresh();
      setAbsent(null);
    },
    onError,
  });
  const confirm = useMutation({
    mutationFn: () =>
      api<{ count: number }>('/hr/hours/confirm', { method: 'POST', body: { teacherId, month } }),
    onSuccess: (r) => {
      toast(`${r.count} cours marqués comme faits`);
      void refresh();
    },
    onError,
  });
  const overtime = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/hr/hours/overtime', { method: 'POST', body }),
    onSuccess: () => {
      toast('Heures supplémentaires enregistrées');
      setOvertimeOpen(false);
      void refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/hr/hours/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
    onError,
  });
  const editable = can('hr.write') && !q.data?.locked;
  const today = todayIso();

  const actions = (l: Lesson) =>
    editable && l.date <= today ? (
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={l.status === 'DONE' ? 'primary' : 'secondary'}
          onClick={() =>
            mark.mutate({ timetableEntryId: l.timetableEntryId, date: l.date, status: 'DONE' })
          }
        >
          <Check className="size-4" aria-hidden />
          Fait<span className="sr-only"> le {formatShortDate(l.date)}</span>
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setReason(l.reason ?? '');
            setJustified(l.justified);
            setAbsent(l);
          }}
        >
          <UserX className="size-4" aria-hidden />
          Absent<span className="sr-only"> le {formatShortDate(l.date)}</span>
        </Button>
      </div>
    ) : null;

  return (
    <>
      <PageHeader
        title="Heures de cours"
        subtitle="Heures prévues par l’emploi du temps, cours faits ou manqués et heures supplémentaires. Les vacataires sont payés aux heures faites."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Enseignant"
          value={teacherId}
          onChange={(e) => setTeacherId(e.target.value)}
        >
          {(teachers.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.lastName} {t.firstName}
            </option>
          ))}
        </SelectField>
        <SelectField label="Mois" value={month} onChange={(e) => setMonth(e.target.value)}>
          {monthOptions().map((m) => (
            <option key={m} value={m}>
              {formatPayrollMonth(m)}
            </option>
          ))}
        </SelectField>
      </div>

      {!teacherId ? (
        teachers.isPending ? (
          <LoadingBlock />
        ) : (
          <EmptyState title="Aucun enseignant">Ajoutez des enseignants dans Personnel.</EmptyState>
        )
      ) : q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {q.data.locked ? (
            <p role="status" className="rounded-[12px] bg-info-soft p-3 text-sm text-info">
              La paie de {formatPayrollMonth(month)} est validée : les heures de ce mois sont
              figées.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Prévues" value={formatMinutes(q.data.totals.plannedMinutes)} />
            <Stat label="Faites" value={formatMinutes(q.data.totals.doneMinutes)} />
            <Stat
              label="Absences non justifiées"
              value={formatMinutes(q.data.totals.absentUnjustifiedMinutes)}
              tone={q.data.totals.absentUnjustifiedMinutes ? 'danger' : 'default'}
              hint={`Justifiées : ${formatMinutes(q.data.totals.absentJustifiedMinutes)}`}
            />
            <Stat
              label="Heures supplémentaires"
              value={formatMinutes(q.data.totals.overtimeMinutes)}
              hint={`À confirmer : ${formatMinutes(q.data.totals.unmarkedMinutes)}`}
            />
          </div>

          <Card>
            <CardHeader
              title="Cours prévus"
              action={
                editable && q.data.totals.unmarkedMinutes > 0 ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => confirm.mutate()}
                    loading={confirm.isPending}
                  >
                    <CheckCheck className="size-4" aria-hidden />
                    Cours passés faits
                  </Button>
                ) : undefined
              }
            />
            {q.data.lessons.length === 0 ? (
              <p className="text-sm text-muted">
                Aucun cours prévu ce mois-ci dans l’emploi du temps.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line" aria-label="Cours prévus">
                {q.data.lessons.map((l) => (
                  <li
                    key={`${l.timetableEntryId}-${l.date}`}
                    className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="font-semibold">
                        <span className="capitalize">{formatWeekday(l.date)}</span>{' '}
                        {formatShortDate(l.date)} · {l.startTime}–{l.endTime}
                      </span>
                      <span className="text-[13px] text-muted">
                        {l.className} · {l.subject} · {formatMinutes(l.minutes)}
                      </span>
                      {l.reason ? (
                        <span className="text-[13px] text-muted">Motif : {l.reason}</span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <LessonStatus lesson={l} />
                      {actions(l)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Heures supplémentaires"
              action={
                editable ? (
                  <Button size="sm" variant="secondary" onClick={() => setOvertimeOpen(true)}>
                    <Plus className="size-4" aria-hidden />
                    Ajouter
                  </Button>
                ) : undefined
              }
            />
            {q.data.overtime.length === 0 ? (
              <p className="text-sm text-muted">Aucune heure supplémentaire ce mois-ci.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {q.data.overtime.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0 text-sm">
                      <strong>{formatShortDate(o.date)}</strong> · {formatMinutes(o.minutes)} ·{' '}
                      {o.reason}
                    </span>
                    {editable ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Supprimer les heures du ${formatShortDate(o.date)}`}
                        onClick={() => remove.mutate(o.id)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <Sheet
        open={!!absent}
        onClose={() => setAbsent(null)}
        title="Cours non fait"
        footer={
          <Button
            block
            disabled={!reason.trim()}
            loading={mark.isPending}
            onClick={() =>
              absent &&
              mark.mutate({
                timetableEntryId: absent.timetableEntryId,
                date: absent.date,
                status: 'ABSENT',
                justified,
                reason,
              })
            }
          >
            Enregistrer l’absence
          </Button>
        }
      >
        {absent ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {absent.className} · {absent.subject} · {formatShortDate(absent.date)}
            </p>
            <TextareaField
              label="Motif de l’absence"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
            />
            <Checkbox
              label="Absence justifiée (pas de retenue sur salaire)"
              checked={justified}
              onChange={(e) => setJustified(e.target.checked)}
            />
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={overtimeOpen}
        onClose={() => setOvertimeOpen(false)}
        title="Heures supplémentaires"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            overtime.mutate({
              teacherId,
              date: fd.get('date'),
              minutes: Math.round(Number(fd.get('hours')) * 60),
              reason: fd.get('reason'),
            });
          }}
        >
          <InputField
            label="Date"
            name="date"
            type="date"
            required
            max={today}
            defaultValue={today}
          />
          <InputField
            label="Durée (heures)"
            name="hours"
            type="number"
            inputMode="decimal"
            min={0.25}
            max={10}
            step={0.25}
            required
            hint="Par exemple 1,5 pour 1 h 30."
          />
          <InputField label="Motif" name="reason" required maxLength={300} />
          <Button type="submit" loading={overtime.isPending}>
            Enregistrer
          </Button>
        </form>
      </Sheet>
    </>
  );
}
