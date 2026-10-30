'use client';

import {
  suggestYearEndDecision,
  YEAR_END_DECISION_LABELS,
  YEAR_END_DECISIONS,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Lock, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, openPdf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatGrade, plural } from '@/lib/format';
import { useClasses, useCurrentStructure } from '@/lib/queries';

interface CardRow {
  id: string;
  studentId: string;
  student: string;
  matricule: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  generalAverageCenti: number | null;
  rank: number | null;
  rankLabel: string;
  classSize: number;
  publishedAt: string | null;
  needsRepublish: boolean;
  republishReason: string | null;
  decision: string | null;
  annualAverageCenti: number | null;
  annualRankLabel: string | null;
  yearEndDecision: string | null;
}

const DECISIONS = [
  ['HONOR_ROLL', 'Tableau d’honneur'],
  ['ENCOURAGEMENT', 'Encouragements'],
  ['WARNING', 'Avertissement'],
  ['BLAME', 'Blâme'],
  ['NONE', 'Aucune mention'],
] as const;

export default function ReportCardsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const classes = useClasses();
  const structure = useCurrentStructure();
  const [classId, setClassId] = useState('');
  const [termId, setTermId] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [decisionFor, setDecisionFor] = useState<CardRow | null>(null);

  useEffect(() => {
    if (!termId && structure.data?.terms[0]) setTermId(structure.data.terms[0].id);
  }, [structure.data, termId]);

  const key = ['report-cards', classId, termId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api<CardRow[]>(`/report-cards?classId=${classId}&termId=${termId}`),
    enabled: !!classId && !!termId,
  });
  const completeness = useQuery({
    queryKey: ['report-cards-completeness', classId, termId],
    queryFn: () =>
      api<{ issues: string[]; annual: boolean }>(
        `/report-cards/completeness?classId=${classId}&termId=${termId}`,
      ),
    enabled: !!classId && !!termId,
  });
  const issues = completeness.data?.issues ?? [];
  const annual = completeness.data?.annual ?? false;
  const generate = useMutation({
    mutationFn: () =>
      api<{ generated: number }>('/report-cards/generate', {
        method: 'POST',
        body: { classId, termId },
      }),
    onSuccess: (r) => {
      toast(`${plural(r.generated, 'bulletin préparé', 'bulletins préparés')} en brouillon`);
      void queryClient.invalidateQueries({ queryKey: key });
      void completeness.refetch();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const publish = useMutation({
    mutationFn: () =>
      api<{ published: number }>('/report-cards/publish', {
        method: 'POST',
        body: { classId, termId, overrideReason: issues.length > 0 ? overrideReason : undefined },
      }),
    onSuccess: (r) => {
      setConfirmOpen(false);
      setOverrideReason('');
      toast(
        `${plural(r.published, 'bulletin publié', 'bulletins publiés')} · parents prévenus par SMS`,
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const decide = useMutation({
    mutationFn: (body: { decision: string; comment?: string; yearEndDecision?: string | null }) =>
      api('/report-cards/decisions', {
        method: 'PUT',
        body: { ...body, studentId: decisionFor?.studentId, termId },
      }),
    onSuccess: () => {
      setDecisionFor(null);
      toast('Décision enregistrée. Préparez à nouveau les bulletins pour l’y faire figurer.');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  const drafts = list.data?.filter((c) => c.status === 'DRAFT').length ?? 0;
  const pdf = (id: string) =>
    openPdf(`/report-cards/${id}/pdf`).catch((e) =>
      toast(e instanceof Error ? e.message : 'Erreur', 'error'),
    );

  return (
    <>
      <PageHeader
        title="Bulletins"
        subtitle="Préparez, vérifiez puis publiez. Un bulletin publié est figé ; toute correction crée une nouvelle version."
      />
      {classId && termId && annual ? (
        <p className="rounded-[12px] border border-line bg-primary-soft px-4 py-3 text-sm">
          <strong>Bulletin de fin d’année.</strong> Il ajoute les moyennes et le rang annuels
          (moyenne des trois trimestres) et la décision de fin d’année du conseil. Les saisies de
          toute l’année sont contrôlées.
        </p>
      ) : null}
      <Card className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Classe" value={classId} onChange={(e) => setClassId(e.target.value)}>
          <option value="">Choisir…</option>
          {classes.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Trimestre" value={termId} onChange={(e) => setTermId(e.target.value)}>
          {structure.data?.terms.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
      </Card>

      {classId && termId ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          {can('reportcards.generate') ? (
            <Button
              variant="secondary"
              onClick={() => generate.mutate()}
              loading={generate.isPending}
            >
              Préparer les bulletins
            </Button>
          ) : null}
          {can('reportcards.publish') ? (
            <Button onClick={() => setConfirmOpen(true)} disabled={drafts === 0}>
              <Lock className="size-4" aria-hidden />
              Publier {drafts > 0 ? plural(drafts, 'bulletin', 'bulletins') : ''}
            </Button>
          ) : null}
        </div>
      ) : null}

      {classId && termId && issues.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-[16px] border border-[#f1d99a] bg-warn-soft p-4">
          <div className="flex gap-2.5">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
            <div>
              <h2 className="font-bold">
                {plural(issues.length, 'saisie manquante', 'saisies manquantes')}
              </h2>
              <p className="text-sm text-muted">
                Les matières concernées ne comptent pas dans la moyenne générale.
              </p>
            </div>
          </div>
          <ul className="flex list-disc flex-col gap-1 pl-12 text-sm">
            {issues.slice(0, 8).map((issue) => (
              <li key={issue} className="[overflow-wrap:anywhere]">
                {issue}
              </li>
            ))}
            {issues.length > 8 ? <li>et {issues.length - 8} autre(s)</li> : null}
          </ul>
        </section>
      ) : null}

      {!classId ? (
        <EmptyState title="Choisissez une classe" />
      ) : list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState title="Aucun bulletin pour ce trimestre">
          Les notes doivent être soumises avant de préparer les bulletins.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.data.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-3 rounded-[14px] border border-line bg-white p-3"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-paper font-display text-lg font-bold tabular">
                {c.rank ?? '—'}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <strong className="truncate">{c.student}</strong>
                <span className="text-[13px] text-muted tabular">
                  Moyenne {formatGrade(c.generalAverageCenti)} · {c.rankLabel} sur {c.classSize}
                  {c.decision ? ` · ${c.decision}` : ''}
                </span>
                {annual ? (
                  <span className="text-[13px] text-muted tabular">
                    Année {formatGrade(c.annualAverageCenti)}
                    {c.annualRankLabel ? ` · ${c.annualRankLabel}` : ''}
                    {' · '}
                    <span className={c.yearEndDecision ? 'font-semibold text-ink' : ''}>
                      {c.yearEndDecision ?? 'décision de fin d’année à saisir'}
                    </span>
                  </span>
                ) : null}
              </div>
              <Badge
                tone={
                  c.status === 'PUBLISHED' && c.needsRepublish
                    ? 'danger'
                    : c.status === 'PUBLISHED'
                      ? 'night'
                      : c.status === 'DRAFT'
                        ? 'warn'
                        : 'neutral'
                }
                title={c.needsRepublish ? (c.republishReason ?? undefined) : undefined}
              >
                {c.status === 'PUBLISHED' && c.needsRepublish
                  ? `À republier · v${c.version}`
                  : c.status === 'PUBLISHED'
                    ? `Publié · v${c.version}`
                    : c.status === 'DRAFT'
                      ? `Brouillon · v${c.version}`
                      : 'Remplacé'}
              </Badge>
              <div className="flex w-full gap-2 sm:w-auto">
                {can('reportcards.generate') ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 sm:flex-none"
                    onClick={() => setDecisionFor(c)}
                  >
                    Décision
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  onClick={() => void pdf(c.id)}
                >
                  <FileText className="size-4" aria-hidden />
                  PDF
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Publier les bulletins ?"
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Annuler
            </Button>
            <Button
              onClick={() => publish.mutate()}
              loading={publish.isPending}
              disabled={issues.length > 0 && overrideReason.trim().length < 10}
            >
              Publier
            </Button>
          </div>
        }
      >
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>
            {plural(drafts, 'bulletin sera publié', 'bulletins seront publiés')} et deviendra
            consultable par les parents.
          </li>
          <li>Les parents reçoivent un SMS avec la moyenne générale.</li>
          <li>
            Un bulletin publié ne peut plus être modifié : une correction produit une nouvelle
            version numérotée.
          </li>
        </ul>
        {issues.length > 0 ? (
          <TextareaField
            containerClassName="mt-4"
            label="Motif de publication malgré les saisies manquantes"
            hint={`${plural(issues.length, 'saisie manquante', 'saisies manquantes')} · motif journalisé, 10 caractères minimum`}
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            minLength={10}
            maxLength={300}
            required
          />
        ) : null}
      </Sheet>

      <Sheet
        open={!!decisionFor}
        onClose={() => setDecisionFor(null)}
        title={`Décision du conseil · ${decisionFor?.student ?? ''}`}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            decide.mutate({
              decision: String(fd.get('decision')),
              comment: String(fd.get('comment') || '') || undefined,
              ...(annual
                ? { yearEndDecision: String(fd.get('yearEndDecision') || '') || null }
                : {}),
            });
          }}
        >
          <SelectField label="Décision" name="decision" defaultValue="NONE">
            {DECISIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </SelectField>
          {annual ? (
            <SelectField
              key={decisionFor?.id}
              label="Décision de fin d’année"
              name="yearEndDecision"
              hint={
                decisionFor?.annualAverageCenti != null
                  ? `Moyenne annuelle ${formatGrade(decisionFor.annualAverageCenti)} · proposition : ${
                      YEAR_END_DECISION_LABELS[
                        suggestYearEndDecision(decisionFor.annualAverageCenti) ?? 'REPEAT'
                      ]
                    }`
                  : 'Aucune moyenne annuelle'
              }
              defaultValue={suggestYearEndDecision(decisionFor?.annualAverageCenti ?? null) ?? ''}
            >
              <option value="">Non décidée</option>
              {YEAR_END_DECISIONS.map((d) => (
                <option key={d} value={d}>
                  {YEAR_END_DECISION_LABELS[d]}
                </option>
              ))}
            </SelectField>
          ) : null}
          <TextareaField label="Appréciation du conseil" name="comment" maxLength={300} optional />
          <Button type="submit" loading={decide.isPending}>
            Enregistrer
          </Button>
        </form>
      </Sheet>
    </>
  );
}
