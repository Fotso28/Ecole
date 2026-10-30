'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Lock } from 'lucide-react';
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
  decision: string | null;
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
  const generate = useMutation({
    mutationFn: () =>
      api<{ generated: number }>('/report-cards/generate', {
        method: 'POST',
        body: { classId, termId },
      }),
    onSuccess: (r) => {
      toast(`${plural(r.generated, 'bulletin préparé', 'bulletins préparés')} en brouillon`);
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const publish = useMutation({
    mutationFn: () =>
      api<{ published: number }>('/report-cards/publish', {
        method: 'POST',
        body: { classId, termId },
      }),
    onSuccess: (r) => {
      setConfirmOpen(false);
      toast(
        `${plural(r.published, 'bulletin publié', 'bulletins publiés')} · parents prévenus par SMS`,
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const decide = useMutation({
    mutationFn: (body: { decision: string; comment?: string }) =>
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
              </div>
              <Badge
                tone={
                  c.status === 'PUBLISHED' ? 'night' : c.status === 'DRAFT' ? 'warn' : 'neutral'
                }
              >
                {c.status === 'PUBLISHED'
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
            <Button onClick={() => publish.mutate()} loading={publish.isPending}>
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
          <TextareaField label="Appréciation du conseil" name="comment" maxLength={300} optional />
          <Button type="submit" loading={decide.isPending}>
            Enregistrer
          </Button>
        </form>
      </Sheet>
    </>
  );
}
