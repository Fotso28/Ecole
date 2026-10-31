'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { initials, plural, todayIso } from '@/lib/format';
import { useClasses } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Mark = 'PRESENT' | 'ABSENT' | 'LATE';

interface Roster {
  class: { id: string; name: string };
  absenceNotificationDelayMinutes?: number;
  session: { id: string; updatedAt: string } | null;
  students: {
    id: string;
    firstName: string;
    lastName: string;
    matricule: string;
    gender?: 'F' | 'M';
    status: Mark | null;
  }[];
}

interface TeacherDay {
  lessons: {
    id: string;
    startTime: string;
    endTime: string;
    classId: string;
    className: string;
    classSubjectId: string;
    subjectName: string;
    attendanceTaken: boolean;
  }[];
  classSubjects: { id: string; classId: string; className: string; subjectName: string }[];
}

const MARKS: { value: Mark; short: string; label: string; on: string }[] = [
  { value: 'PRESENT', short: 'P', label: 'Présent', on: 'bg-primary text-white' },
  { value: 'ABSENT', short: 'A', label: 'Absent', on: 'bg-danger text-white' },
  { value: 'LATE', short: 'R', label: 'Retard', on: 'bg-saffron text-ink' },
];

function AttendanceContent() {
  const { teacherOnly, me } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [classId, setClassId] = useState(params.get('classe') ?? '');
  const [date, setDate] = useState(params.get('date') ?? todayIso());
  const [startTime, setStartTime] = useState(params.get('debut') ?? '07:30');
  const [endTime, setEndTime] = useState(params.get('fin') ?? '09:20');
  const [classSubjectId, setClassSubjectId] = useState(params.get('cs') ?? '');
  const [marks, setMarks] = useState<Record<string, Mark | null>>({});

  const allClasses = useClasses();
  const teacherDay = useQuery({
    queryKey: ['teacher-today'],
    queryFn: () => api<TeacherDay>('/teacher/today'),
    enabled: !!me?.roles.includes('TEACHER'),
  });
  const classOptions = useMemo(() => {
    if (teacherOnly) {
      const seen = new Map<string, string>();
      for (const c of teacherDay.data?.classSubjects ?? []) seen.set(c.classId, c.className);
      return [...seen.entries()].map(([id, name]) => ({ id, name }));
    }
    return (allClasses.data ?? []).map((c) => ({ id: c.id, name: c.name }));
  }, [teacherOnly, teacherDay.data, allClasses.data]);

  const roster = useQuery({
    queryKey: ['roster', classId, date, startTime],
    queryFn: () =>
      api<Roster>(`/attendance/roster?classId=${classId}&date=${date}&startTime=${startTime}`),
    enabled: !!classId && /^\d{2}:\d{2}$/.test(startTime),
  });

  useEffect(() => {
    if (roster.data)
      setMarks(Object.fromEntries(roster.data.students.map((s) => [s.id, s.status])));
  }, [roster.data]);

  const submit = useMutation({
    mutationFn: () =>
      api<{ notified: number; alerts: { studentId: string; count: number }[] }>(
        '/attendance/sessions',
        {
          method: 'POST',
          body: {
            classId,
            classSubjectId: classSubjectId || undefined,
            date,
            startTime,
            endTime,
            records: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })),
          },
        },
      ),
    onSuccess: (r) => {
      toast(
        `Appel enregistré${r.notified ? ` · ${plural(r.notified, 'parent sera prévenu', 'parents seront prévenus')} par SMS` : ''}`,
      );
      if (r.alerts.length)
        toast(
          `${plural(r.alerts.length, 'élève dépasse', 'élèves dépassent')} le seuil d’absences`,
          'error',
        );
      void queryClient.invalidateQueries({ queryKey: ['roster'] });
      void queryClient.invalidateQueries({ queryKey: ['teacher-today'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  const counts = { PRESENT: 0, ABSENT: 0, LATE: 0, none: 0 };
  for (const v of Object.values(marks)) counts[v ?? 'none']++;
  const ready = roster.data && roster.data.students.length > 0 && counts.none === 0;

  return (
    <>
      <PageHeader
        title="Appel"
        subtitle={
          roster.data
            ? `${roster.data.class.name} · ${plural(roster.data.students.length, 'élève', 'élèves')}`
            : 'Choisissez la classe et le créneau'
        }
      />

      {teacherDay.data?.lessons.length ? (
        <div
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0"
          role="group"
          aria-label="Mes cours du jour"
        >
          {teacherDay.data.lessons.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => {
                setClassId(l.classId);
                setStartTime(l.startTime);
                setEndTime(l.endTime);
                setClassSubjectId(l.classSubjectId);
                setDate(todayIso());
                router.replace(
                  `/presences?classe=${l.classId}&debut=${l.startTime}&fin=${l.endTime}&cs=${l.classSubjectId}`,
                  { scroll: false },
                );
              }}
              className={cn(
                'flex min-h-14 shrink-0 flex-col items-start justify-center rounded-[12px] border px-3 text-left text-sm',
                classId === l.classId && startTime === l.startTime
                  ? 'border-2 border-primary bg-primary-soft'
                  : 'border-line-strong bg-white',
              )}
            >
              <strong className="tabular">
                {l.startTime}–{l.endTime} · {l.className}
              </strong>
              <span className="text-xs text-muted">
                {l.subjectName}
                {l.attendanceTaken ? ' · appel fait' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <Card className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SelectField
          label="Classe"
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          containerClassName="col-span-2 lg:col-span-1"
        >
          <option value="">Choisir…</option>
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <InputField
          label="Date"
          type="date"
          value={date}
          max={todayIso()}
          onChange={(e) => setDate(e.target.value)}
          containerClassName="col-span-2 lg:col-span-1"
        />
        <InputField
          label="Début"
          type="time"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
        />
        <InputField
          label="Fin"
          type="time"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
        />
      </Card>

      {!classId ? (
        <EmptyState title="Aucune classe choisie">
          Sélectionnez une classe pour afficher la liste d’appel.
        </EmptyState>
      ) : roster.isPending ? (
        <LoadingBlock />
      ) : roster.isError ? (
        <ErrorBlock error={roster.error} onRetry={() => roster.refetch()} />
      ) : roster.data.students.length === 0 ? (
        <EmptyState title="Aucun élève inscrit dans cette classe" />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 text-center text-[13px] font-semibold">
            <div className="rounded-[10px] bg-primary-soft px-2 py-2 text-primary">
              <strong className="block text-xl tabular">{counts.PRESENT}</strong>Présents
            </div>
            <div className="rounded-[10px] bg-danger-soft px-2 py-2 text-danger">
              <strong className="block text-xl tabular">{counts.ABSENT}</strong>Absents
            </div>
            <div className="rounded-[10px] bg-warn-soft px-2 py-2 text-warn">
              <strong className="block text-xl tabular">{counts.LATE}</strong>Retards
            </div>
            <div className="rounded-[10px] border border-line bg-white px-2 py-2 text-muted">
              <strong className="block text-xl text-ink tabular">{counts.none}</strong>À marquer
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              setMarks((m) =>
                Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v ?? 'PRESENT'])),
              )
            }
          >
            <CheckCheck className="size-4" aria-hidden />
            Marquer les autres présents
          </Button>
          <ul className="grid gap-2 md:grid-cols-2">
            {roster.data.students.map((s, i) => {
              const cur = marks[s.id] ?? null;
              return (
                <li
                  key={s.id}
                  className={cn(
                    'flex items-center gap-3 rounded-[14px] border bg-white p-2 pl-3',
                    cur === null
                      ? 'border-2 border-dashed border-[#b9b6aa]'
                      : cur === 'ABSENT'
                        ? 'border-[#f0c7c2]'
                        : 'border-line',
                  )}
                >
                  <span className="w-6 text-[13px] text-muted tabular">{i + 1}</span>
                  <span className="hidden size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary sm:flex">
                    {initials(`${s.lastName} ${s.firstName}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                    {s.lastName} {s.firstName}
                  </span>
                  <div
                    role="radiogroup"
                    aria-label={`Présence de ${s.lastName} ${s.firstName}`}
                    className="flex gap-1"
                  >
                    {MARKS.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        role="radio"
                        aria-checked={cur === m.value}
                        aria-label={
                          s.gender === 'F' && m.value !== 'LATE' ? `${m.label}e` : m.label
                        }
                        onClick={() => setMarks((prev) => ({ ...prev, [s.id]: m.value }))}
                        className={cn(
                          'h-12 w-12 rounded-[10px] text-[15px] font-bold',
                          cur === m.value ? m.on : 'bg-[#f1f0ea] text-muted',
                        )}
                      >
                        {m.short}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="sticky bottom-20 z-20 -mx-4 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:mx-0 lg:rounded-[12px] lg:border lg:px-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="flex-1 text-[13px] text-muted">
                {smsDelayText(roster.data.absenceNotificationDelayMinutes ?? 60)} L’appel reste
                modifiable d’ici là.
              </p>
              <Button
                size="lg"
                onClick={() => submit.mutate()}
                loading={submit.isPending}
                disabled={!ready}
              >
                {ready
                  ? roster.data.session
                    ? 'Mettre à jour l’appel'
                    : 'Valider l’appel'
                  : `Encore ${plural(counts.none, 'élève', 'élèves')} à marquer`}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function AttendancePage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <AttendanceContent />
    </Suspense>
  );
}

/** Moment du SMS d'absence : délai réglé par l'école après la fin du cours, ou après l'appel. */
function smsDelayText(minutes: number): string {
  const delay =
    minutes === 0
      ? null
      : minutes % 60 === 0
        ? plural(minutes / 60, 'heure', 'heures').replace(/^1 heure$/, 'une heure')
        : `${minutes} min`;
  return delay
    ? `Les parents des absents non justifiés reçoivent un SMS ${delay} après la fin du cours, ou après l’enregistrement de l’appel s’il est fait plus tard.`
    : 'Les parents des absents non justifiés reçoivent un SMS dès la fin du cours, ou dès l’enregistrement de l’appel s’il est fait plus tard.';
}
