'use client';

import { parseGradeInput } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Lock, Plus, Trash2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatGrade, plural } from '@/lib/format';
import { useOfflineStatus } from '@/lib/offline';
import { useMyClassSubjects } from '@/lib/queries';
import { cn } from '@/lib/utils';

interface GradeSheet {
  classSubject: {
    id: string;
    coefficient: number;
    className: string;
    classId: string;
    subjectName: string;
  };
  sequence: { id: string; name: string; termName: string };
  status: 'DRAFT' | 'SUBMITTED' | 'LOCKED' | 'MIXED';
  /** Bulletins publiés sur ces notes (grille validée). */
  published?: boolean;
  evaluations: {
    id: string;
    name: string;
    type: 'QUIZ' | 'HOMEWORK' | 'EXAM';
    weight: number;
    maxScore: number;
    status: 'DRAFT' | 'SUBMITTED' | 'LOCKED';
  }[];
  rows: {
    student: { id: string; firstName: string; lastName: string; matricule: string };
    cells: { evaluationId: string; value: string }[];
    averageCenti: number | null;
    incomplete: boolean;
    formula: string | null;
    rank: { rank: number; tied: boolean; label: string } | null;
    appreciation: string | null;
  }[];
  stats: {
    count: number;
    averageCenti: number | null;
    minCenti: number | null;
    maxCenti: number | null;
    passCount: number;
  };
  missing: number;
}

const TYPE_LABEL = { QUIZ: 'Interrogation', HOMEWORK: 'Devoir', EXAM: 'Composition' } as const;
const STATUS = {
  DRAFT: { tone: 'neutral', label: 'Brouillon' },
  MIXED: { tone: 'neutral', label: 'Brouillon' },
  SUBMITTED: { tone: 'warn', label: 'Soumis au censeur' },
  LOCKED: { tone: 'night', label: 'Validé' },
} as const;

type Values = Record<string, Record<string, string>>;
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function cellError(raw: string, maxScore: number): string | null {
  const p = parseGradeInput(raw, maxScore);
  return p.kind === 'invalid' ? `Entre 0 et ${maxScore}, deux décimales au plus` : null;
}

function NotesContent() {
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const mine = useMyClassSubjects();
  const csId = params.get('cs') ?? '';
  const seqId = params.get('seq') ?? mine.data?.sequences[0]?.id ?? '';
  const [mobileEval, setMobileEval] = useState<string>('');
  const [values, setValues] = useState<Values>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [newEvalOpen, setNewEvalOpen] = useState(false);
  // Intitulé de la nouvelle évaluation : suit le type tant qu'il n'a pas été personnalisé.
  const [newEvalName, setNewEvalName] = useState<string>(TYPE_LABEL.QUIZ);
  const [newEvalKey, setNewEvalKey] = useState(0);
  const [reopenOpen, setReopenOpen] = useState(false);
  const dirty = useRef<Map<string, Set<string>>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    next.set(k, v);
    router.replace(`/notes?${next.toString()}`, { scroll: false });
  };

  const sheetKey = ['sheet', csId, seqId];
  const sheet = useQuery({
    queryKey: sheetKey,
    queryFn: () => api<GradeSheet>(`/grades/sheet?classSubjectId=${csId}&sequenceId=${seqId}`),
    enabled: !!csId && !!seqId,
  });

  // Synchronise les valeurs locales avec le serveur, sans écraser une saisie en cours.
  useEffect(() => {
    if (!sheet.data) return;
    setValues((prev) => {
      const next: Values = {};
      for (const e of sheet.data.evaluations) {
        next[e.id] = {};
        const pending = dirty.current.get(e.id);
        for (const r of sheet.data.rows) {
          const server = r.cells.find((c) => c.evaluationId === e.id)?.value ?? '';
          next[e.id]![r.student.id] = pending?.has(r.student.id)
            ? (prev[e.id]?.[r.student.id] ?? server)
            : server;
        }
      }
      return next;
    });
    if (!sheet.data.evaluations.some((e) => e.id === mobileEval))
      setMobileEval(sheet.data.evaluations[0]?.id ?? '');
  }, [sheet.data, mobileEval]);

  const flush = useCallback(
    async (evaluationId: string) => {
      const ids = dirty.current.get(evaluationId);
      if (!ids || ids.size === 0) return;
      const maxScore = sheet.data?.evaluations.find((e) => e.id === evaluationId)?.maxScore ?? 20;
      const grades = [...ids]
        .map((studentId) => ({
          studentId,
          value: valuesRef.current[evaluationId]?.[studentId] ?? '',
        }))
        .filter((g) => !cellError(g.value, maxScore));
      if (grades.length === 0) return;
      dirty.current.set(
        evaluationId,
        new Set([...ids].filter((id) => !grades.some((g) => g.studentId === id))),
      );
      setSaveState('saving');
      try {
        await api(`/grades/evaluations/${evaluationId}/grades`, {
          method: 'PUT',
          body: { grades },
        });
        setServerErrors((e) => {
          const n = { ...e };
          for (const g of grades) delete n[`${evaluationId}:${g.studentId}`];
          return n;
        });
        setSaveState('saved');
        await queryClient.invalidateQueries({ queryKey: sheetKey });
      } catch (e) {
        setSaveState('error');
        const set = dirty.current.get(evaluationId) ?? new Set<string>();
        for (const g of grades) set.add(g.studentId);
        dirty.current.set(evaluationId, set);
        if (e instanceof ApiError && Array.isArray(e.body.errors)) {
          const errs = e.body.errors as { studentId: string; message: string }[];
          setServerErrors((prev) => ({
            ...prev,
            ...Object.fromEntries(errs.map((x) => [`${evaluationId}:${x.studentId}`, x.message])),
          }));
        }
        toast(e instanceof Error ? e.message : 'Enregistrement impossible', 'error');
      }
    },
    [sheet.data, queryClient, toast, csId, seqId],
  );

  const change = (evaluationId: string, studentId: string, value: string) => {
    setValues((v) => ({ ...v, [evaluationId]: { ...v[evaluationId], [studentId]: value } }));
    const set = dirty.current.get(evaluationId) ?? new Set<string>();
    set.add(studentId);
    dirty.current.set(evaluationId, set);
    const t = timers.current.get(evaluationId);
    if (t) clearTimeout(t);
    timers.current.set(
      evaluationId,
      setTimeout(() => void flush(evaluationId), 800),
    );
  };

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  const onKey = (e: KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    const move = (r: number, c: number) => {
      const el = document.querySelector<HTMLInputElement>(`[data-grade="${r}:${c}"]`);
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    };
    if (e.key === 'Enter' || e.key === 'ArrowDown') move(row + 1, col);
    else if (e.key === 'ArrowUp') move(row - 1, col);
  };

  const submit = useMutation({
    mutationFn: (action: 'submit' | 'validate') =>
      api(`/grades/sheet/${action}`, {
        method: 'POST',
        body: { classSubjectId: csId, sequenceId: seqId },
      }),
    onSuccess: (_d, action) => {
      toast(action === 'submit' ? 'Notes soumises au censeur' : 'Grille validée');
      void queryClient.invalidateQueries({ queryKey: sheetKey });
    },
    onError: (e) =>
      toast(
        e instanceof ApiError && Array.isArray(e.body.missing)
          ? `${e.message} : ${(e.body.missing as string[]).join(', ')}`
          : e instanceof Error
            ? e.message
            : 'Erreur',
        'error',
      ),
  });
  const reopen = useMutation({
    mutationFn: (reason: string) =>
      api('/grades/sheet/reopen', {
        method: 'POST',
        body: { classSubjectId: csId, sequenceId: seqId, reason },
      }),
    onSuccess: () => {
      setReopenOpen(false);
      toast('Grille rouverte');
      void queryClient.invalidateQueries({ queryKey: sheetKey });
    },
  });
  const createEval = useMutation({
    mutationFn: (body: { name: string; type: string; weight: number; maxScore: number }) =>
      api('/grades/evaluations', {
        method: 'POST',
        body: { ...body, classSubjectId: csId, sequenceId: seqId },
      }),
    onSuccess: () => {
      setNewEvalOpen(false);
      void queryClient.invalidateQueries({ queryKey: sheetKey });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const deleteEval = useMutation({
    mutationFn: (id: string) => api(`/grades/evaluations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: sheetKey }),
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  const data = sheet.data;
  // Hors connexion : la grille gardée sur l'appareil se consulte, la saisie attend le réseau.
  const { offline } = useOfflineStatus();
  const editable =
    !offline &&
    !!data &&
    (data.status === 'DRAFT' ||
      data.status === 'MIXED' ||
      (data.status === 'SUBMITTED' && can('grades.validate')));
  const liveMissing = useMemo(() => {
    if (!data) return 0;
    return data.evaluations.reduce(
      (n, e) =>
        n + data.rows.filter((r) => (values[e.id]?.[r.student.id] ?? '').trim() === '').length,
      0,
    );
  }, [data, values]);
  const selectedCs = mine.data?.classSubjects.find((c) => c.id === csId);

  return (
    <>
      <PageHeader
        title="Saisie des notes"
        subtitle={
          selectedCs
            ? `${selectedCs.className} · ${selectedCs.subjectName} · coefficient ${selectedCs.coefficient}`
            : 'Choisissez une classe et une séquence'
        }
      />

      <Card className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Classe et matière"
          value={csId}
          onChange={(e) => setParam('cs', e.target.value)}
        >
          <option value="">Choisir…</option>
          {mine.data?.classSubjects.map((c) => (
            <option key={c.id} value={c.id}>
              {c.className} · {c.subjectName}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Séquence"
          value={seqId}
          onChange={(e) => setParam('seq', e.target.value)}
        >
          {mine.data?.sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.termName}
            </option>
          ))}
        </SelectField>
      </Card>

      {!csId ? (
        <EmptyState title="Aucune matière choisie">
          Sélectionnez la classe et la matière à noter.
        </EmptyState>
      ) : sheet.isPending ? (
        <LoadingBlock />
      ) : sheet.isError ? (
        <ErrorBlock error={sheet.error} onRetry={() => sheet.refetch()} />
      ) : data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS[data.status].tone}>
              {data.status === 'LOCKED' ? <Lock className="size-3" aria-hidden /> : null}
              {STATUS[data.status].label}
            </Badge>
            <span className="flex items-center gap-1.5 text-[13px] text-muted" aria-live="polite">
              {offline ? (
                'Hors connexion : consultation seule, la saisie reprendra au retour du réseau'
              ) : !editable && saveState === 'idle' ? null : saveState === 'saving' ? (
                'Enregistrement…'
              ) : saveState === 'saved' ? (
                <>
                  <CheckCircle2 className="size-4 text-primary" aria-hidden /> Enregistré
                </>
              ) : saveState === 'error' ? (
                <>
                  <CircleAlert className="size-4 text-danger" aria-hidden /> Certaines notes ne sont
                  pas enregistrées
                </>
              ) : (
                'Enregistrement automatique'
              )}
            </span>
            <div className="ml-auto flex flex-wrap gap-2">
              {editable && data.status !== 'SUBMITTED' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setNewEvalName(TYPE_LABEL.QUIZ);
                    setNewEvalKey((k) => k + 1);
                    setNewEvalOpen(true);
                  }}
                >
                  <Plus className="size-4" aria-hidden />
                  Évaluation
                </Button>
              ) : null}
              {!offline &&
              (data.status === 'DRAFT' || data.status === 'MIXED') &&
              data.evaluations.length > 0 ? (
                <Button
                  size="sm"
                  onClick={() => submit.mutate('submit')}
                  loading={submit.isPending && submit.variables === 'submit'}
                  disabled={liveMissing > 0}
                >
                  {liveMissing > 0
                    ? `Soumettre (${plural(liveMissing, 'note manquante', 'notes manquantes')})`
                    : 'Soumettre au censeur'}
                </Button>
              ) : null}
              {data.status === 'SUBMITTED' && can('grades.validate') ? (
                <Button
                  size="sm"
                  onClick={() => submit.mutate('validate')}
                  loading={submit.isPending && submit.variables === 'validate'}
                >
                  Valider la grille
                </Button>
              ) : null}
              {(data.status === 'SUBMITTED' || data.status === 'LOCKED') &&
              can('grades.validate') ? (
                <Button variant="secondary" size="sm" onClick={() => setReopenOpen(true)}>
                  Rouvrir
                </Button>
              ) : null}
            </div>
          </div>

          {data.status === 'LOCKED' ? (
            <p
              role="status"
              className="flex items-start gap-2 rounded-[12px] border border-line bg-paper p-3 text-sm"
            >
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                {data.published
                  ? 'Notes validées : bulletin publié, les notes sont figées.'
                  : 'Notes validées par le censeur : elles sont figées.'}{' '}
                {can('grades.validate')
                  ? 'Pour une correction, rouvrez la grille (motif obligatoire).'
                  : 'Pour une correction, adressez-vous au censeur.'}
              </span>
            </p>
          ) : data.status === 'SUBMITTED' && !editable ? (
            <p role="status" className="rounded-[12px] border border-line bg-paper p-3 text-sm">
              Grille soumise au censeur : la saisie est fermée en attendant sa validation.
            </p>
          ) : null}

          {data.evaluations.length === 0 ? (
            <EmptyState title="Aucune évaluation pour cette séquence">
              Créez l’interrogation, le devoir ou la composition à noter.
            </EmptyState>
          ) : (
            <>
              {/* Téléphone : une évaluation à la fois, un élève par ligne. */}
              <div className="flex flex-col gap-3 md:hidden">
                <div
                  role="tablist"
                  aria-label="Évaluation"
                  className="-mx-4 flex gap-2 overflow-x-auto px-4"
                >
                  {data.evaluations.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      role="tab"
                      aria-selected={mobileEval === e.id}
                      onClick={() => setMobileEval(e.id)}
                      className={cn(
                        'flex min-h-12 shrink-0 flex-col items-start justify-center rounded-[12px] border px-3 text-left',
                        mobileEval === e.id
                          ? 'border-2 border-primary bg-primary-soft'
                          : 'border-line-strong bg-white',
                      )}
                    >
                      <strong className="text-sm">{e.name}</strong>
                      <span className="text-xs text-muted">
                        /{e.maxScore} · poids {e.weight}
                      </span>
                    </button>
                  ))}
                </div>
                <ul className="flex flex-col gap-2">
                  {data.rows.map((r, row) => {
                    const ev = data.evaluations.find((e) => e.id === mobileEval);
                    if (!ev) return null;
                    const col = data.evaluations.indexOf(ev);
                    const raw = values[ev.id]?.[r.student.id] ?? '';
                    const error =
                      cellError(raw, ev.maxScore) ?? serverErrors[`${ev.id}:${r.student.id}`];
                    return (
                      <li
                        key={r.student.id}
                        className={cn(
                          'flex flex-col gap-1 rounded-[14px] border bg-white p-2.5 pl-3',
                          error
                            ? 'border-2 border-danger'
                            : raw === ''
                              ? 'border-dashed border-[#b4bbd0]'
                              : 'border-line',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="w-6 text-[13px] text-muted tabular">{row + 1}</span>
                          <label htmlFor={`m-${ev.id}-${r.student.id}`} className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-semibold">
                              {r.student.lastName} {r.student.firstName}
                            </span>
                            <span className="block text-xs text-muted tabular">
                              Moyenne {formatGrade(r.averageCenti)}
                              {r.rank ? ` · ${r.rank.label}` : ''}
                            </span>
                          </label>
                          <button
                            type="button"
                            disabled={!editable}
                            aria-pressed={raw === 'abs'}
                            onClick={() => change(ev.id, r.student.id, raw === 'abs' ? '' : 'abs')}
                            className={cn(
                              'h-12 rounded-[10px] border px-2.5 text-[13px] font-bold',
                              raw === 'abs'
                                ? 'border-info bg-info text-white'
                                : 'border-line-strong text-muted',
                            )}
                          >
                            Abs
                          </button>
                          <input
                            id={`m-${ev.id}-${r.student.id}`}
                            data-grade={`${row}:${col}`}
                            type="text"
                            inputMode="decimal"
                            enterKeyHint="next"
                            autoComplete="off"
                            disabled={!editable}
                            value={raw === 'abs' || raw === 'disp' ? '' : raw}
                            placeholder={raw === 'abs' ? 'abs' : raw === 'disp' ? 'disp' : '—'}
                            onChange={(e) => change(ev.id, r.student.id, e.target.value)}
                            onBlur={() => void flush(ev.id)}
                            onKeyDown={(e) => onKey(e, row, col)}
                            aria-invalid={!!error || undefined}
                            className={cn(
                              'h-12 w-20 rounded-[10px] border bg-white px-2 text-right text-xl font-bold tabular disabled:bg-paper',
                              error ? 'border-2 border-danger' : 'border-line-strong',
                            )}
                          />
                        </div>
                        {error ? (
                          <span className="pl-8 text-[13px] font-semibold text-danger">
                            {error}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* Grand écran : grille type tableur. */}
              <div className="hidden overflow-x-auto rounded-[14px] border border-line bg-white md:block">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-paper">
                    <tr>
                      <th className="w-10 px-3 py-2.5 text-left text-xs font-semibold text-muted">
                        N°
                      </th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold tracking-[0.06em] text-muted uppercase">
                        Élève
                      </th>
                      {data.evaluations.map((e) => (
                        <th key={e.id} className="w-32 border-l border-line px-2 py-2 text-center">
                          <span className="block text-[13px] font-bold">{e.name}</span>
                          <span className="block text-xs font-medium text-muted">
                            /{e.maxScore} · poids {e.weight}
                          </span>
                          {e.status === 'DRAFT' && editable ? (
                            <button
                              type="button"
                              onClick={() => deleteEval.mutate(e.id)}
                              className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-danger"
                              aria-label={`Supprimer ${e.name}`}
                            >
                              <Trash2 className="size-3" aria-hidden />
                              Supprimer
                            </button>
                          ) : null}
                        </th>
                      ))}
                      <th className="w-24 border-l-2 border-line-strong bg-[#eef2fc] px-3 py-2.5 text-right text-xs font-bold tracking-[0.06em] text-primary uppercase">
                        Moyenne
                      </th>
                      <th className="w-20 bg-[#eef2fc] px-3 py-2.5 text-right text-xs font-bold tracking-[0.06em] text-primary uppercase">
                        Rang
                      </th>
                      <th className="w-28 bg-[#eef2fc] px-3 py-2.5 text-left text-xs font-bold tracking-[0.06em] text-primary uppercase">
                        Appréciation
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, row) => (
                      <tr key={r.student.id} className="border-t border-line">
                        <td className="px-3 py-1.5 text-muted tabular">{row + 1}</td>
                        <th
                          scope="row"
                          className="px-3 py-1.5 text-left font-semibold whitespace-nowrap"
                        >
                          {r.student.lastName} {r.student.firstName}
                        </th>
                        {data.evaluations.map((e, col) => {
                          const raw = values[e.id]?.[r.student.id] ?? '';
                          const error =
                            cellError(raw, e.maxScore) ?? serverErrors[`${e.id}:${r.student.id}`];
                          return (
                            <td key={e.id} className="border-l border-line px-2 py-1">
                              <input
                                data-grade={`${row}:${col}`}
                                type="text"
                                inputMode="decimal"
                                autoComplete="off"
                                aria-label={`${e.name}, ${r.student.lastName} ${r.student.firstName}`}
                                title={error ?? undefined}
                                aria-invalid={!!error || undefined}
                                disabled={!editable}
                                value={raw}
                                onChange={(ev) => change(e.id, r.student.id, ev.target.value)}
                                onBlur={() => void flush(e.id)}
                                onKeyDown={(ev) => onKey(ev, row, col)}
                                className={cn(
                                  'h-9 w-full rounded-[8px] border px-2.5 text-right text-sm font-semibold tabular disabled:bg-paper',
                                  error
                                    ? 'border-2 border-danger bg-danger-soft'
                                    : raw === ''
                                      ? 'border-dashed border-[#b4bbd0]'
                                      : raw === 'abs' || raw === 'disp'
                                        ? 'border-line bg-info-soft text-info'
                                        : 'border-line',
                                )}
                              />
                            </td>
                          );
                        })}
                        <td
                          title={r.formula ?? 'Moyenne non calculée : note manquante ou invalide'}
                          className={cn(
                            'border-l-2 border-line-strong bg-[#f6f8fd] px-3 py-1.5 text-right font-bold tabular',
                            r.averageCenti !== null && r.averageCenti < 1000 && 'text-danger',
                          )}
                        >
                          {formatGrade(r.averageCenti)}
                        </td>
                        <td className="bg-[#f6f8fd] px-3 py-1.5 text-right tabular">
                          {r.rank?.label ?? '—'}
                        </td>
                        <td className="bg-[#f6f8fd] px-3 py-1.5 text-[13px] text-muted">
                          {r.appreciation ?? (r.incomplete ? 'Note manquante' : '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-4 py-3 text-[13px] text-muted">
                  <span>
                    Moyenne de la classe{' '}
                    <strong className="text-ink tabular">
                      {formatGrade(data.stats.averageCenti)}
                    </strong>
                  </span>
                  <span>
                    Réussite (≥ 10){' '}
                    <strong className="text-ink tabular">{data.stats.passCount}</strong> sur{' '}
                    {data.stats.count}
                  </span>
                  <span>Entrée ou ↓ : élève suivant · « abs » : absent · « disp » : dispensé</span>
                  <span className="ml-auto">Survolez une moyenne pour voir son calcul.</span>
                </div>
              </div>
            </>
          )}
        </>
      ) : null}

      <Sheet open={newEvalOpen} onClose={() => setNewEvalOpen(false)} title="Nouvelle évaluation">
        <form
          key={newEvalKey}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            createEval.mutate({
              name: String(fd.get('name')),
              type: String(fd.get('type')),
              weight: Number(fd.get('weight')),
              maxScore: Number(fd.get('maxScore')),
            });
          }}
        >
          <SelectField
            label="Type"
            name="type"
            defaultValue="QUIZ"
            onChange={(e) => {
              const label = TYPE_LABEL[e.target.value as keyof typeof TYPE_LABEL];
              if (label && (Object.values(TYPE_LABEL) as string[]).includes(newEvalName.trim()))
                setNewEvalName(label);
            }}
          >
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </SelectField>
          <InputField
            label="Intitulé"
            name="name"
            value={newEvalName}
            onChange={(e) => setNewEvalName(e.target.value)}
            required
            maxLength={60}
          />
          <div className="grid grid-cols-2 gap-3">
            <InputField
              label="Poids"
              name="weight"
              type="number"
              min={1}
              max={10}
              defaultValue={1}
              inputMode="numeric"
              required
            />
            <InputField
              label="Barème"
              name="maxScore"
              type="number"
              min={1}
              max={100}
              defaultValue={20}
              inputMode="numeric"
              required
            />
          </div>
          <Button type="submit" loading={createEval.isPending}>
            Créer l’évaluation
          </Button>
        </form>
      </Sheet>

      <Sheet open={reopenOpen} onClose={() => setReopenOpen(false)} title="Rouvrir la grille">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            reopen.mutate(String(new FormData(e.currentTarget).get('reason')));
          }}
        >
          <p className="text-sm text-muted">
            L’enseignant pourra de nouveau modifier les notes. Le motif est conservé dans le journal
            d’audit.
          </p>
          <InputField label="Motif" name="reason" required minLength={5} />
          <Button type="submit" loading={reopen.isPending}>
            Rouvrir
          </Button>
        </form>
      </Sheet>
    </>
  );
}

export default function NotesPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <NotesContent />
    </Suspense>
  );
}
