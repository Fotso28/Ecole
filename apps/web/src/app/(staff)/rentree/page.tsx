'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COUNCIL_DECISION_LABELS,
  REENROLLMENT_LABELS,
  REENROLLMENT_DECISIONS,
  YEAR_END_DECISION_LABELS,
  type ReenrollmentDecision,
} from '@ecole/shared';
import { CheckCheck, Copy, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { plural } from '@/lib/format';
import type { YearStructure } from '@/lib/queries';
import { cn } from '@/lib/utils';

interface Year {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}
interface Cycle {
  id: string;
  name: string;
  levels: { id: string; name: string }[];
}
interface PreviewStudent {
  id: string;
  firstName: string;
  lastName: string;
  matricule: string;
  status: 'ENROLLED' | 'REPEATING';
  councilDecision: string | null;
  councilComment: string | null;
  suggestion: ReenrollmentDecision | null;
  reenrolled: { classId: string; status: string } | null;
}
interface PreviewClass {
  id: string;
  name: string;
  levelName: string;
  promotionClassId: string | null;
  repeatClassId: string | null;
  students: PreviewStudent[];
}
interface Preview {
  fromYear: { id: string; name: string };
  toYear: { id: string; name: string };
  targetClasses: { id: string; name: string; levelName: string; capacity: number | null }[];
  classes: PreviewClass[];
}
interface ApplyResult {
  promoted: number;
  repeating: number;
  left: number;
  skipped: { studentId: string; reason: string }[];
}

/** Décisions de fin d'année et mentions trimestrielles connues ; toute autre valeur est affichée telle quelle. */
const COUNCIL_LABELS: Record<string, string> = {
  ...COUNCIL_DECISION_LABELS,
  NONE: 'Aucune distinction',
  ...YEAR_END_DECISION_LABELS,
};
const councilLabel = (d: string) =>
  COUNCIL_LABELS[d] ?? d.charAt(0) + d.slice(1).toLowerCase().replace(/_/g, ' ');

const DECISION_STYLE: Record<ReenrollmentDecision, string> = {
  PROMOTED: 'bg-primary text-white',
  REPEATING: 'bg-saffron text-ink',
  LEFT: 'bg-night text-white',
};

const iso = (d: string) => d.slice(0, 10);
const plusOneYear = (d: string) => `${Number(d.slice(0, 4)) + 1}${d.slice(4, 10)}`;

function YearCreator({ from, onCreated }: { from: Year; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [y1, y2] = from.name.split('-').map(Number);
  const [form, setForm] = useState({
    name: y1 && y2 ? `${y1 + 1}-${y2 + 1}` : '',
    startDate: plusOneYear(iso(from.startDate)),
    endDate: plusOneYear(iso(from.endDate)),
  });
  const create = useMutation({
    mutationFn: () => api<Year>('/academic/years', { method: 'POST', body: form }),
    onSuccess: (y) => {
      toast(`Année ${y.name} créée`);
      onCreated(y.id);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-dashed border-line-strong p-3">
      <p className="text-sm font-semibold">Créer la nouvelle année scolaire</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <InputField
          label="Nom"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="2027-2028"
        />
        <InputField
          label="Rentrée"
          type="date"
          value={form.startDate}
          onChange={(e) => setForm({ ...form, startDate: e.target.value })}
        />
        <InputField
          label="Fin d’année"
          type="date"
          value={form.endDate}
          onChange={(e) => setForm({ ...form, endDate: e.target.value })}
        />
      </div>
      <Button className="self-start" onClick={() => create.mutate()} loading={create.isPending}>
        <Plus className="size-4" aria-hidden />
        Créer l’année {form.name}
      </Button>
    </div>
  );
}

function StructureStep({ from, to }: { from: Year; to: Year }) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const structure = useQuery({
    queryKey: ['structure', to.id],
    queryFn: () => api<YearStructure>(`/academic/years/${to.id}/structure`),
  });
  const cycles = useQuery({
    queryKey: ['cycles'],
    queryFn: () => api<Cycle[]>('/academic/cycles'),
    enabled: can('academic.write'),
  });
  const [cls, setCls] = useState({ levelId: '', name: '' });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['structure', to.id] });
    void queryClient.invalidateQueries({ queryKey: ['reenrollment'] });
  };
  const rollover = useMutation({
    mutationFn: () =>
      api<{ classes: number; subjects: number; feeItems: number }>(
        `/academic/years/${to.id}/rollover`,
        { method: 'POST', body: { fromYearId: from.id } },
      ),
    onSuccess: (r) => {
      toast(
        `Structure copiée : ${plural(r.classes, 'classe', 'classes')}, ${plural(r.subjects, 'matière', 'matières')}, ${plural(r.feeItems, 'frais', 'frais')}`,
      );
      refresh();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const addClass = useMutation({
    mutationFn: () =>
      api('/academic/classes', {
        method: 'POST',
        body: { academicYearId: to.id, levelId: cls.levelId, name: cls.name.trim() },
      }),
    onSuccess: () => {
      toast(`Classe ${cls.name.trim()} ajoutée`);
      setCls({ levelId: cls.levelId, name: '' });
      refresh();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  return (
    <Card>
      <CardHeader
        title="2. Structure de la nouvelle année"
        subtitle={`Classes, matières, coefficients, enseignants et frais repris de ${from.name}, puis ajustés.`}
      />
      {structure.isPending ? (
        <LoadingBlock />
      ) : structure.isError ? (
        <ErrorBlock error={structure.error} onRetry={() => structure.refetch()} />
      ) : structure.data.classes.length === 0 ? (
        can('academic.write') ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              L’année {to.name} ne contient encore aucune classe. Copiez la structure de {from.name}{' '}
              pour gagner du temps : vous pourrez ensuite ajouter des classes.
            </p>
            <Button
              className="self-start"
              onClick={() => rollover.mutate()}
              loading={rollover.isPending}
            >
              <Copy className="size-4" aria-hidden />
              Copier la structure de {from.name}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted">
            L’année {to.name} ne contient encore aucune classe : la direction ou le censeur doit
            d’abord copier la structure.
          </p>
        )
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-wrap gap-2" aria-label={`Classes de ${to.name}`}>
            {structure.data.classes.map((c) => (
              <li
                key={c.id}
                className="flex min-h-11 items-center gap-2 rounded-full border border-line-strong bg-white px-3 text-sm"
              >
                <strong>{c.name}</strong>
                <span className="text-muted tabular">
                  {plural(c._count.enrollments, 'élève', 'élèves')}
                </span>
              </li>
            ))}
          </ul>
          {can('academic.write') ? (
            <form
              className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                addClass.mutate();
              }}
            >
              <SelectField
                label="Niveau de la classe à ajouter"
                value={cls.levelId}
                onChange={(e) => setCls({ ...cls, levelId: e.target.value })}
              >
                <option value="">Choisir…</option>
                {cycles.data?.flatMap((cy) =>
                  cy.levels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} · {cy.name}
                    </option>
                  )),
                )}
              </SelectField>
              <InputField
                label="Nom de la classe"
                value={cls.name}
                maxLength={20}
                onChange={(e) => setCls({ ...cls, name: e.target.value })}
                placeholder="4e C"
              />
              <Button
                type="submit"
                variant="secondary"
                loading={addClass.isPending}
                disabled={!cls.levelId || !cls.name.trim()}
              >
                <Plus className="size-4" aria-hidden />
                Ajouter
              </Button>
            </form>
          ) : null}
          <p className="text-[13px] text-muted">
            Matières, coefficients et enseignants se règlent ensuite dans{' '}
            <Link href="/structure" className="font-semibold text-primary underline">
              Structure académique
            </Link>{' '}
            une fois {to.name} définie comme année en cours.
          </p>
        </div>
      )}
    </Card>
  );
}

function ClassReenrollment({
  preview,
  source,
  onDone,
}: {
  preview: Preview;
  source: PreviewClass;
  onDone: () => void;
}) {
  const toast = useToast();
  const [promotionClassId, setPromotionClassId] = useState(source.promotionClassId ?? '');
  const [repeatClassId, setRepeatClassId] = useState(source.repeatClassId ?? '');
  const pending = useMemo(() => source.students.filter((s) => !s.reenrolled), [source]);
  const [decisions, setDecisions] = useState<Record<string, ReenrollmentDecision | null>>({});
  const [result, setResult] = useState<ApplyResult | null>(null);
  useEffect(() => {
    setPromotionClassId(source.promotionClassId ?? '');
    setRepeatClassId(source.repeatClassId ?? '');
    setDecisions(Object.fromEntries(pending.map((s) => [s.id, s.suggestion])));
  }, [source, pending]);
  useEffect(() => setResult(null), [source.id]);

  const counts = { PROMOTED: 0, REPEATING: 0, LEFT: 0, none: 0 };
  for (const s of pending) counts[decisions[s.id] ?? 'none']++;
  const decided = pending.filter((s) => decisions[s.id]);
  const missingClass =
    (counts.PROMOTED > 0 && !promotionClassId) || (counts.REPEATING > 0 && !repeatClassId);
  const className = (id: string) => preview.targetClasses.find((c) => c.id === id)?.name ?? '—';

  const apply = useMutation({
    mutationFn: () =>
      api<ApplyResult>(`/reenrollment/${preview.toYear.id}`, {
        method: 'POST',
        body: {
          fromYearId: preview.fromYear.id,
          items: decided.map((s) => {
            const decision = decisions[s.id] as ReenrollmentDecision;
            return {
              studentId: s.id,
              decision,
              classId:
                decision === 'PROMOTED'
                  ? promotionClassId
                  : decision === 'REPEATING'
                    ? repeatClassId
                    : undefined,
            };
          }),
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      toast(
        `${source.name} : ${plural(r.promoted + r.repeating, 'élève réinscrit', 'élèves réinscrits')}`,
      );
      onDone();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  return (
    <Card aria-labelledby={`class-${source.id}`}>
      <div className="mb-3 flex flex-col gap-0.5">
        <h3 id={`class-${source.id}`} className="text-base font-bold lg:text-[17px]">
          {source.name} · {preview.fromYear.name}
        </h3>
        <p className="text-[13px] text-muted">
          {plural(source.students.length, 'élève', 'élèves')} ·{' '}
          {plural(source.students.length - pending.length, 'déjà réinscrit', 'déjà réinscrits')}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Classe d’arrivée des admis"
          value={promotionClassId}
          onChange={(e) => setPromotionClassId(e.target.value)}
          error={
            counts.PROMOTED > 0 && !promotionClassId ? 'Choisissez la classe des admis' : undefined
          }
        >
          <option value="">Choisir…</option>
          {preview.targetClasses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Classe des redoublants"
          value={repeatClassId}
          onChange={(e) => setRepeatClassId(e.target.value)}
          error={
            counts.REPEATING > 0 && !repeatClassId
              ? 'Choisissez la classe des redoublants'
              : undefined
          }
        >
          <option value="">Choisir…</option>
          {preview.targetClasses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
      </div>

      {result ? (
        <div
          role="status"
          className="mt-4 flex flex-col gap-1 rounded-[12px] bg-primary-soft p-3 text-sm"
        >
          <strong className="text-primary">Réinscriptions enregistrées</strong>
          <span>
            {plural(result.promoted, 'admis', 'admis')} ·{' '}
            {plural(result.repeating, 'redoublant', 'redoublants')} ·{' '}
            {plural(result.left, 'sortant', 'sortants')}
          </span>
          {result.skipped.length > 0 ? (
            <span className="text-warn">
              {plural(result.skipped.length, 'élève ignoré', 'élèves ignorés')} :{' '}
              {result.skipped.map((s) => s.reason).join(', ')}
            </span>
          ) : null}
        </div>
      ) : null}

      {source.students.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Aucun élève inscrit dans cette classe.</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-4 gap-2 text-center text-[13px] font-semibold">
            <div className="rounded-[10px] bg-primary-soft px-2 py-2 text-primary">
              <strong className="block text-xl tabular">{counts.PROMOTED}</strong>Admis
            </div>
            <div className="rounded-[10px] bg-warn-soft px-2 py-2 text-warn">
              <strong className="block text-xl tabular">{counts.REPEATING}</strong>Redoublants
            </div>
            <div className="rounded-[10px] bg-neutral-soft px-2 py-2 text-muted">
              <strong className="block text-xl text-ink tabular">{counts.LEFT}</strong>Sortants
            </div>
            <div className="rounded-[10px] border border-line bg-white px-2 py-2 text-muted">
              <strong className="block text-xl text-ink tabular">{counts.none}</strong>À décider
            </div>
          </div>
          {counts.none > 0 ? (
            <Button
              variant="secondary"
              className="mt-3"
              onClick={() =>
                setDecisions((d) =>
                  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v ?? 'PROMOTED'])),
                )
              }
            >
              <CheckCheck className="size-4" aria-hidden />
              Marquer les autres admis
            </Button>
          ) : null}
          <ul className="mt-3 grid gap-2 lg:grid-cols-2">
            {source.students.map((s) => {
              const cur = decisions[s.id] ?? null;
              return (
                <li
                  key={s.id}
                  className={cn(
                    'flex flex-col gap-2 rounded-[14px] border bg-white p-3',
                    s.reenrolled
                      ? 'border-line bg-paper'
                      : cur === null
                        ? 'border-2 border-dashed border-[#b9b6aa]'
                        : 'border-line',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[15px] font-semibold">
                        {s.lastName} {s.firstName}
                      </span>
                      <span className="text-[13px] text-muted tabular">
                        {s.matricule}
                        {s.status === 'REPEATING' ? ' · redoublant cette année' : ''}
                      </span>
                      {s.councilDecision ? (
                        <span className="text-[13px] text-muted">
                          Conseil : {councilLabel(s.councilDecision)}
                          {s.suggestion ? '' : ' (à confirmer)'}
                        </span>
                      ) : null}
                    </div>
                    {s.reenrolled ? (
                      <Badge tone="success">Réinscrit en {className(s.reenrolled.classId)}</Badge>
                    ) : null}
                  </div>
                  {s.reenrolled ? null : (
                    <div
                      role="radiogroup"
                      aria-label={`Décision pour ${s.lastName} ${s.firstName}`}
                      className="grid grid-cols-3 gap-1"
                    >
                      {REENROLLMENT_DECISIONS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          role="radio"
                          aria-checked={cur === d}
                          onClick={() => setDecisions((prev) => ({ ...prev, [s.id]: d }))}
                          className={cn(
                            'min-h-11 rounded-[10px] px-2 text-sm font-semibold',
                            cur === d ? DECISION_STYLE[d] : 'bg-[#f1f0ea] text-muted',
                          )}
                        >
                          {REENROLLMENT_LABELS[d]}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {pending.length > 0 ? (
            <div className="sticky bottom-20 z-20 -mx-4 mt-4 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:mx-0 lg:rounded-[12px] lg:border lg:px-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <p className="flex-1 text-[13px] text-muted">
                  Admis vers {promotionClassId ? className(promotionClassId) : '—'}, redoublants
                  vers {repeatClassId ? className(repeatClassId) : '—'}. Les sortants ne sont pas
                  réinscrits ; les élèves « à décider » restent en attente.
                </p>
                <Button
                  size="lg"
                  onClick={() => apply.mutate()}
                  loading={apply.isPending}
                  disabled={decided.length === 0 || missingClass}
                >
                  Valider {plural(decided.length, 'décision', 'décisions')}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function ReenrollmentStep({ from, to }: { from: Year; to: Year }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['reenrollment', to.id, from.id],
    queryFn: () => api<Preview>(`/reenrollment/${to.id}?fromYearId=${from.id}`),
  });
  const [classId, setClassId] = useState('');
  const source = q.data?.classes.find((c) => c.id === classId) ?? null;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="step-3">
      <Card>
        <CardHeader
          title={<span id="step-3">3. Réinscriptions</span>}
          subtitle="Pour chaque classe, choisissez la classe d’arrivée puis marquez chaque élève admis, redoublant ou sortant. Les décisions du conseil préremplissent les choix."
        />
        {q.isPending ? (
          <LoadingBlock />
        ) : q.isError ? (
          <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
        ) : q.data.targetClasses.length === 0 ? (
          <p className="text-sm text-muted">Créez d’abord les classes de {to.name} (étape 2).</p>
        ) : q.data.classes.length === 0 ? (
          <p className="text-sm text-muted">Aucune classe en {from.name}.</p>
        ) : (
          <ul
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
            aria-label="Classes de départ"
          >
            {q.data.classes.map((c) => {
              const done = c.students.filter((s) => s.reenrolled).length;
              const on = c.id === classId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setClassId(c.id)}
                    className={cn(
                      'flex min-h-14 w-full flex-col items-start justify-center rounded-[12px] border px-3 py-2 text-left',
                      on
                        ? 'border-2 border-primary bg-primary-soft'
                        : 'border-line-strong bg-white',
                    )}
                  >
                    <strong>{c.name}</strong>
                    <span className="text-[13px] text-muted tabular">
                      {done} / {plural(c.students.length, 'élève', 'élèves')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {q.data && source ? (
        <ClassReenrollment
          preview={q.data}
          source={source}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: ['reenrollment'] });
            void queryClient.invalidateQueries({ queryKey: ['structure', to.id] });
          }}
        />
      ) : q.data && q.data.classes.length > 0 && q.data.targetClasses.length > 0 ? (
        <EmptyState title="Choisissez une classe de départ">
          Les élèves de la classe s’afficheront avec la décision proposée.
        </EmptyState>
      ) : null}
    </section>
  );
}

export default function RentreePage() {
  const { can, me } = useAuth();
  const queryClient = useQueryClient();
  const years = useQuery({ queryKey: ['years'], queryFn: () => api<Year[]>('/academic/years') });
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const currentId = me?.activeSchool?.currentYear?.id ?? '';
  useEffect(() => {
    if (!years.data) return;
    const from = fromId || currentId || years.data[0]?.id || '';
    if (!fromId && from) setFromId(from);
    const fromYear = years.data.find((y) => y.id === from);
    if (!toId && fromYear) {
      const next = years.data
        .filter((y) => y.startDate > fromYear.startDate)
        .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
      if (next) setToId(next.id);
    }
  }, [years.data, currentId, fromId, toId]);
  const from = years.data?.find((y) => y.id === fromId);
  const to = years.data?.find((y) => y.id === toId);
  const others = years.data?.filter((y) => y.id !== fromId) ?? [];

  return (
    <>
      <PageHeader
        title="Assistant de rentrée"
        subtitle="Préparez la nouvelle année : structure reprise de l’année précédente, puis réinscription des élèves classe par classe."
      />
      {years.isPending ? (
        <LoadingBlock />
      ) : years.isError ? (
        <ErrorBlock error={years.error} onRetry={() => years.refetch()} />
      ) : (
        <>
          <Card>
            <CardHeader title="1. Années scolaires" />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Année qui se termine"
                value={fromId}
                onChange={(e) => {
                  setFromId(e.target.value);
                  if (e.target.value === toId) setToId('');
                }}
              >
                {years.data.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                    {y.isCurrent ? ' (en cours)' : ''}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Nouvelle année"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
              >
                <option value="">Choisir…</option>
                {others.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                  </option>
                ))}
              </SelectField>
            </div>
            {from && !to && can('academic.write') ? (
              <div className="mt-4">
                <YearCreator
                  from={from}
                  onCreated={(id) => {
                    setToId(id);
                    void queryClient.invalidateQueries({ queryKey: ['years'] });
                  }}
                />
              </div>
            ) : from && !to ? (
              <p className="mt-3 text-sm text-muted">
                La nouvelle année n’existe pas encore : la direction doit la créer.
              </p>
            ) : null}
          </Card>
          {from && to ? (
            <>
              <StructureStep from={from} to={to} />
              <ReenrollmentStep from={from} to={to} />
            </>
          ) : null}
        </>
      )}
    </>
  );
}
