'use client';

import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api, openPdf } from '@/lib/api';
import { formatGrade } from '@/lib/format';
import { useClasses, useCurrentStructure } from '@/lib/queries';
import type { Paged, StudentListItem } from '@/lib/types';

type Scope = 'sequence' | 'term' | 'year';

interface Transcript {
  period: string;
  className: string;
  columns: string[];
  groups: {
    label: string;
    subjects: {
      name: string;
      coefficient: number;
      evaluations: { name: string; weight: number; maxScore: number; value: string }[];
      columns: (number | null)[];
      averageCenti: number | null;
    }[];
  }[];
  columnGeneralAverages: (number | null)[];
  generalAverageCenti: number | null;
  totalCoefficient: number;
  publicationNotice: string | null;
}

const SCOPES: [Scope, string][] = [
  ['sequence', 'Séquence'],
  ['term', 'Trimestre'],
  ['year', 'Année'],
];

export default function TranscriptsPage() {
  const toast = useToast();
  const classes = useClasses();
  const structure = useCurrentStructure();
  const [classId, setClassId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [scope, setScope] = useState<Scope>('term');
  const [periodId, setPeriodId] = useState('');

  const sequences = structure.data?.terms.flatMap((t) => t.sequences) ?? [];
  const periods = scope === 'sequence' ? sequences : scope === 'term' ? structure.data?.terms : [];
  // Période retenue : celle choisie si elle appartient à la portée, sinon la première.
  const period = periods?.some((p) => p.id === periodId) ? periodId : (periods?.[0]?.id ?? '');

  const students = useQuery({
    queryKey: ['students', 'class', classId],
    queryFn: () =>
      api<Paged<StudentListItem>>(`/students?classId=${classId}&pageSize=100`).then((r) =>
        [...r.items].sort((a, b) =>
          `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'fr'),
        ),
      ),
    enabled: !!classId,
  });

  const query = `scope=${scope}${scope !== 'year' && period ? `&periodId=${period}` : ''}`;
  const ready = !!studentId && (scope === 'year' || !!period);
  const transcript = useQuery({
    queryKey: ['transcript', studentId, query],
    queryFn: () => api<Transcript>(`/transcripts/students/${studentId}?${query}`),
    enabled: ready,
  });
  const pdf = () =>
    openPdf(`/transcripts/students/${studentId}/pdf?${query}`).catch((e) =>
      toast(e instanceof Error ? e.message : 'Erreur', 'error'),
    );

  const t = transcript.data;
  const averageLabel = scope === 'year' ? 'Moy. annuelle' : 'Moyenne';
  return (
    <>
      <PageHeader
        title="Relevés de notes"
        subtitle="Notes et moyennes d’un élève pour une séquence, un trimestre ou l’année. Distinct du bulletin : ni rang ni décision du conseil."
      />
      <Card className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField
          label="Classe"
          value={classId}
          onChange={(e) => {
            setClassId(e.target.value);
            setStudentId('');
          }}
        >
          <option value="">Choisir…</option>
          {classes.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Élève"
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          disabled={!classId}
        >
          <option value="">{students.isFetching ? 'Chargement…' : 'Choisir…'}</option>
          {students.data?.map((st) => (
            <option key={st.id} value={st.id}>
              {st.lastName} {st.firstName}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Relevé"
          value={scope}
          onChange={(e) => setScope(e.target.value as Scope)}
        >
          {SCOPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </SelectField>
        {scope === 'year' ? (
          <SelectField label="Période" value="year" disabled>
            <option value="year">{structure.data?.name ?? 'Année en cours'}</option>
          </SelectField>
        ) : (
          <SelectField label="Période" value={period} onChange={(e) => setPeriodId(e.target.value)}>
            {periods?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
        )}
      </Card>

      {!ready ? (
        <EmptyState title="Choisissez une classe et un élève" />
      ) : transcript.isPending ? (
        <LoadingBlock />
      ) : transcript.isError ? (
        <ErrorBlock error={transcript.error} onRetry={() => transcript.refetch()} />
      ) : t ? (
        <Card>
          <CardHeader
            title={`${t.period} · ${t.className}`}
            subtitle={`Moyenne générale ${formatGrade(t.generalAverageCenti)} / 20 · ${t.totalCoefficient} coefficients notés`}
            action={
              <Button variant="secondary" size="sm" onClick={() => void pdf()}>
                <FileText className="size-4" aria-hidden />
                Relevé PDF
              </Button>
            }
          />
          {t.publicationNotice ? (
            <p
              role="status"
              className="mb-3 rounded-[12px] bg-warn-soft p-3 text-sm font-medium text-ink"
            >
              {t.publicationNotice}
            </p>
          ) : null}
          {/* Téléphone : cartes empilées. */}
          <ul className="flex flex-col gap-2 lg:hidden">
            {t.groups.flatMap((g) =>
              g.subjects.map((s) => (
                <li key={s.name} className="rounded-[12px] border border-line p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <strong className="min-w-0 [overflow-wrap:anywhere]">{s.name}</strong>
                    <span className="shrink-0 font-bold tabular">
                      {formatGrade(s.averageCenti)}
                    </span>
                  </div>
                  <p className="text-[13px] text-muted tabular">
                    Coef. {s.coefficient}
                    {t.columns.map((c, i) => ` · ${c} : ${formatGrade(s.columns[i] ?? null)}`)}
                  </p>
                  {s.evaluations.length ? (
                    <p className="text-[13px] text-muted [overflow-wrap:anywhere]">
                      {s.evaluations
                        .map(
                          (e) =>
                            `${e.name} : ${e.value}${/^\d/.test(e.value) ? `/${e.maxScore}` : ''}`,
                        )
                        .join(' · ')}
                    </p>
                  ) : null}
                </li>
              )),
            )}
          </ul>
          {/* Ordinateur : tableau. */}
          <table className="hidden w-full text-sm lg:table">
            <caption className="sr-only">Relevé de notes · {t.period}</caption>
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-2 font-semibold">
                  Matière
                </th>
                {scope === 'sequence' ? (
                  <th scope="col" className="py-2 font-semibold">
                    Évaluations
                  </th>
                ) : null}
                {t.columns.map((c) => (
                  <th key={c} scope="col" className="py-2 text-right font-semibold">
                    {c}
                  </th>
                ))}
                <th scope="col" className="py-2 text-right font-semibold">
                  {averageLabel}
                </th>
                <th scope="col" className="py-2 text-right font-semibold">
                  Coef.
                </th>
              </tr>
            </thead>
            <tbody>
              {t.groups.map((g) => [
                <tr key={g.label} className="border-t border-line bg-paper">
                  <th
                    scope="colgroup"
                    colSpan={t.columns.length + (scope === 'sequence' ? 4 : 3)}
                    className="py-1.5 text-left text-xs font-bold tracking-wide uppercase"
                  >
                    {g.label}
                  </th>
                </tr>,
                ...g.subjects.map((s) => (
                  <tr key={s.name} className="border-t border-line">
                    <th scope="row" className="py-2 text-left font-semibold">
                      {s.name}
                    </th>
                    {scope === 'sequence' ? (
                      <td className="py-2 text-muted">
                        {s.evaluations
                          .map(
                            (e) =>
                              `${e.name} : ${e.value}${/^\d/.test(e.value) ? `/${e.maxScore}` : ''}`,
                          )
                          .join(' · ') || 'Aucune évaluation soumise'}
                      </td>
                    ) : null}
                    {t.columns.map((c, i) => (
                      <td key={c} className="py-2 text-right tabular">
                        {formatGrade(s.columns[i] ?? null)}
                      </td>
                    ))}
                    <td className="py-2 text-right font-bold tabular">
                      {formatGrade(s.averageCenti)}
                    </td>
                    <td className="py-2 text-right tabular">{s.coefficient}</td>
                  </tr>
                )),
              ])}
              <tr className="border-t-2 border-line-strong font-bold">
                <th scope="row" className="py-2 text-left">
                  Moyenne générale
                </th>
                {scope === 'sequence' ? <td /> : null}
                {t.columnGeneralAverages.map((a, i) => (
                  <td key={t.columns[i]} className="py-2 text-right tabular">
                    {formatGrade(a)}
                  </td>
                ))}
                <td className="py-2 text-right tabular">{formatGrade(t.generalAverageCenti)}</td>
                <td className="py-2 text-right tabular">{t.totalCoefficient}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}
