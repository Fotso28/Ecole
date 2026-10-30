'use client';

import { useQuery } from '@tanstack/react-query';
import { TRIP_DIRECTION_LABELS, TRIP_DIRECTIONS, type TripDirection } from '@ecole/shared';
import { CloudOff, Check, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { PillTabs } from '@/components/ui/pill-tabs';
import { api, ApiError } from '@/lib/api';
import { todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';

interface MyLine {
  id: string;
  name: string;
  vehicle: { plate: string; capacity: number } | null;
}
interface TripStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  stop: { id: string; name: string; time: string | null };
  boarded: boolean | null;
  alighted: boolean | null;
}
interface TripSheet {
  line: { id: string; name: string; plate: string | null };
  students: TripStudent[];
}
interface Mark {
  boarded: boolean | null;
  alighted: boolean | null;
}
interface Pending {
  lineId: string;
  date: string;
  direction: TripDirection;
  records: ({ studentId: string } & Mark)[];
}

const STORAGE_KEY = 'ecole.transport.pending';
const keyOf = (p: { lineId: string; date: string; direction: TripDirection }) =>
  `${p.lineId}|${p.date}|${p.direction}`;

/** File locale des appels non encore reçus par le serveur (réseau lent ou coupé). */
function readQueue(): Record<string, Pending> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Pending>;
  } catch {
    return {};
  }
}
function writeQueue(queue: Record<string, Pending>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Stockage indisponible : l'appel reste en mémoire jusqu'au prochain envoi.
  }
}

/** Envoie les appels en attente ; l'API accepte le même appel plusieurs fois sans effet de bord. */
async function flushQueue(): Promise<number> {
  const queue = readQueue();
  for (const [k, p] of Object.entries(queue)) {
    try {
      await api('/transport/trips', { method: 'PUT', body: p });
      const current = readQueue();
      if (JSON.stringify(current[k]) === JSON.stringify(p)) {
        delete current[k];
        writeQueue(current);
      }
    } catch (e) {
      // Refus définitif (appel trop ancien, élève désabonné) : inutile de réessayer.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        const current = readQueue();
        delete current[k];
        writeQueue(current);
      }
    }
  }
  return Object.keys(readQueue()).length;
}

function defaultDirection(): TripDirection {
  return new Date().getHours() < 12 ? 'OUTBOUND' : 'RETURN';
}

export default function BusRollCallPage() {
  const date = todayIso();
  const [lineId, setLineId] = useState('');
  const [direction, setDirection] = useState<TripDirection>(defaultDirection);
  const [step, setStep] = useState<'board' | 'alight'>('board');
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [pending, setPending] = useState(0);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lines = useQuery({
    queryKey: ['transport', 'my-lines'],
    queryFn: () => api<MyLine[]>('/transport/my-lines'),
  });
  useEffect(() => {
    if (!lineId && lines.data?.[0]) setLineId(lines.data[0].id);
  }, [lines.data, lineId]);

  const sheet = useQuery({
    queryKey: ['transport', 'trip', lineId, date, direction],
    queryFn: () =>
      api<TripSheet>(`/transport/trips?lineId=${lineId}&date=${date}&direction=${direction}`),
    enabled: !!lineId,
    staleTime: Infinity,
  });

  // Pointages du serveur, complétés par l'appel local non encore envoyé.
  useEffect(() => {
    if (!sheet.data) return;
    const local = readQueue()[keyOf({ lineId, date, direction })];
    const next: Record<string, Mark> = {};
    for (const s of sheet.data.students)
      next[s.studentId] = { boarded: s.boarded, alighted: s.alighted };
    for (const r of local?.records ?? [])
      next[r.studentId] = { boarded: r.boarded, alighted: r.alighted };
    setMarks(next);
    setPending(Object.keys(readQueue()).length);
  }, [sheet.data, lineId, date, direction]);

  const flush = useCallback(async () => {
    setSaving(true);
    setPending(await flushQueue());
    setSaving(false);
  }, []);

  // Renvoi automatique : au retour du réseau et toutes les 15 secondes.
  useEffect(() => {
    void flush();
    const onOnline = () => void flush();
    window.addEventListener('online', onOnline);
    const interval = setInterval(() => {
      if (Object.keys(readQueue()).length > 0) void flush();
    }, 15_000);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(interval);
    };
  }, [flush]);

  const mark = (studentId: string, patch: Partial<Mark>) => {
    const next = {
      ...marks,
      [studentId]: { ...(marks[studentId] ?? { boarded: null, alighted: null }), ...patch },
    };
    setMarks(next);
    const payload: Pending = {
      lineId,
      date,
      direction,
      records: Object.entries(next).map(([id, m]) => ({ studentId: id, ...m })),
    };
    // L'appel est d'abord gardé sur le téléphone, puis envoyé (regroupé après une courte pause).
    writeQueue({ ...readQueue(), [keyOf(payload)]: payload });
    setPending(Object.keys(readQueue()).length);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 800);
  };

  const students = useMemo(() => sheet.data?.students ?? [], [sheet.data]);
  const counts = useMemo(() => {
    const values = students.map((s) => marks[s.studentId] ?? { boarded: null, alighted: null });
    return {
      boarded: values.filter((m) => m.boarded === true).length,
      missed: values.filter((m) => m.boarded === false).length,
      todo: values.filter((m) => m.boarded === null).length,
      alighted: values.filter((m) => m.alighted === true).length,
    };
  }, [students, marks]);

  return (
    <>
      <PageHeader
        title="Appel du car"
        subtitle="Pointez chaque élève à la montée puis à la descente. L’appel est gardé sur le téléphone si le réseau coupe."
      />
      {lines.isPending ? (
        <LoadingBlock />
      ) : lines.isError ? (
        <ErrorBlock error={lines.error} onRetry={() => lines.refetch()} />
      ) : lines.data.length === 0 ? (
        <EmptyState title="Aucune ligne ne vous est affectée">
          Demandez au secrétariat de vous affecter à une ligne.
        </EmptyState>
      ) : (
        <>
          <Card className="grid gap-3 sm:grid-cols-2">
            <SelectField label="Ligne" value={lineId} onChange={(e) => setLineId(e.target.value)}>
              {lines.data.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.vehicle ? ` · ${l.vehicle.plate}` : ''}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Trajet"
              value={direction}
              onChange={(e) => setDirection(e.target.value as TripDirection)}
            >
              {TRIP_DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {TRIP_DIRECTION_LABELS[d]}
                </option>
              ))}
            </SelectField>
          </Card>

          <div
            role="status"
            aria-live="polite"
            className={cn(
              'flex items-center gap-2 rounded-[14px] p-3 text-sm font-semibold',
              pending > 0 ? 'bg-warn-soft text-ink' : 'bg-primary-soft text-ink',
            )}
          >
            {pending > 0 ? (
              <>
                <CloudOff className="size-4 shrink-0" aria-hidden />
                {saving
                  ? 'Envoi de l’appel…'
                  : 'Appel gardé sur le téléphone, envoi automatique dès que le réseau revient'}
              </>
            ) : (
              <>
                <Check className="size-4 shrink-0" aria-hidden />
                Appel enregistré
              </>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-[14px] border border-line bg-white p-3">
              <strong className="block font-display text-2xl tabular">{counts.boarded}</strong>
              <span className="text-[13px] text-muted">Montés</span>
            </div>
            <div className="rounded-[14px] border border-line bg-white p-3">
              <strong className="block font-display text-2xl text-danger tabular">
                {counts.missed}
              </strong>
              <span className="text-[13px] text-muted">Absents</span>
            </div>
            <div className="rounded-[14px] border border-line bg-white p-3">
              <strong className="block font-display text-2xl tabular">
                {step === 'board' ? counts.todo : counts.alighted}
              </strong>
              <span className="text-[13px] text-muted">
                {step === 'board' ? 'À pointer' : 'Descendus'}
              </span>
            </div>
          </div>

          <PillTabs
            label="Étape de l’appel"
            tabs={[
              ['board', 'Montée'],
              ['alight', 'Descente'],
            ]}
            value={step}
            onChange={setStep}
          />

          {sheet.isPending ? (
            <LoadingBlock />
          ) : sheet.isError ? (
            <ErrorBlock error={sheet.error} onRetry={() => sheet.refetch()} />
          ) : students.length === 0 ? (
            <EmptyState title="Aucun élève abonné à ce trajet" />
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Élèves du trajet">
              {students.map((s) => {
                const m = marks[s.studentId] ?? { boarded: null, alighted: null };
                const name = `${s.firstName} ${s.lastName}`;
                return (
                  <li
                    key={s.studentId}
                    className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col">
                      <strong className="truncate text-[15px]">{name}</strong>
                      <span className="text-[13px] text-muted">
                        {s.stop.name}
                        {s.stop.time ? ` · ${s.stop.time}` : ''}
                      </span>
                    </div>
                    {step === 'board' ? (
                      <div className="grid grid-cols-2 gap-2 sm:flex">
                        <button
                          type="button"
                          aria-pressed={m.boarded === true}
                          aria-label={`${name} : monté`}
                          onClick={() => mark(s.studentId, { boarded: true })}
                          className={cn(
                            'flex min-h-12 items-center justify-center gap-1.5 rounded-[10px] border px-4 text-sm font-semibold',
                            m.boarded === true
                              ? 'border-primary bg-primary text-white'
                              : 'border-line-strong bg-white',
                          )}
                        >
                          <Check className="size-4" aria-hidden />
                          Monté
                        </button>
                        <button
                          type="button"
                          aria-pressed={m.boarded === false}
                          aria-label={`${name} : absent`}
                          onClick={() => mark(s.studentId, { boarded: false, alighted: null })}
                          className={cn(
                            'flex min-h-12 items-center justify-center gap-1.5 rounded-[10px] border px-4 text-sm font-semibold',
                            m.boarded === false
                              ? 'border-danger bg-danger text-white'
                              : 'border-line-strong bg-white',
                          )}
                        >
                          <X className="size-4" aria-hidden />
                          Absent
                        </button>
                      </div>
                    ) : m.boarded === true ? (
                      <button
                        type="button"
                        aria-pressed={m.alighted === true}
                        aria-label={`${name} : descendu`}
                        onClick={() =>
                          mark(s.studentId, { alighted: m.alighted === true ? null : true })
                        }
                        className={cn(
                          'flex min-h-12 items-center justify-center gap-1.5 rounded-[10px] border px-4 text-sm font-semibold',
                          m.alighted === true
                            ? 'border-primary bg-primary text-white'
                            : 'border-line-strong bg-white',
                        )}
                      >
                        <Check className="size-4" aria-hidden />
                        Descendu
                      </button>
                    ) : (
                      <Badge tone={m.boarded === false ? 'danger' : 'neutral'}>
                        {m.boarded === false ? 'Absent' : 'Non pointé à la montée'}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>
  );
}
