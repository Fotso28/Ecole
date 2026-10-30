'use client';

import { FileText, GraduationCap, ScrollText } from 'lucide-react';
import { Card, CardHeader, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { openPdf } from '@/lib/api';
import { useChildExams } from '@/lib/exams';
import { formatGrade, formatShortDate } from '@/lib/format';
import { useChildOverview } from '@/lib/portal';

export default function PortalGrades() {
  const { selected } = useChildren();
  const toast = useToast();
  const q = useChildOverview(selected?.id);
  const exams = useChildExams(selected?.id);
  if (!selected || q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} />;
  const tr = q.data.transcripts;
  const transcriptLinks = [
    ...tr.sequences.map((sq) => ({
      key: sq.id,
      label: sq.name,
      query: `scope=sequence&periodId=${sq.id}`,
    })),
    ...tr.terms.map((tm) => ({
      key: tm.id,
      label: tm.name,
      query: `scope=term&periodId=${tm.id}`,
    })),
    ...(tr.year
      ? [{ key: 'year', label: 'Année complète', query: `scope=year&periodId=${tr.year.id}` }]
      : []),
  ];
  return (
    <>
      <ChildSwitcher />
      <Card>
        <CardHeader title="Bulletins" />
        {q.data.reportCards.length === 0 ? (
          <p className="text-sm text-muted">Aucun bulletin publié pour l’instant.</p>
        ) : (
          <ul className="flex flex-col">
            {q.data.reportCards.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() =>
                    openPdf(`/portal/report-cards/${r.id}/pdf`).catch(() =>
                      toast('Bulletin indisponible', 'error'),
                    )
                  }
                  className="flex min-h-14 w-full items-center gap-3 border-t border-line text-left first:border-t-0"
                >
                  <FileText className="size-5 text-primary" aria-hidden />
                  <span className="flex flex-1 flex-col">
                    <strong className="text-[15px]">{r.term}</strong>
                    <span className="text-[13px] text-muted">
                      Moyenne {formatGrade(r.generalAverageCenti)} · rang {r.rank ?? '—'}/
                      {r.classSize} · publié le {formatShortDate(r.publishedAt)}
                    </span>
                    {r.annualAverageCenti !== null || r.yearEndDecision ? (
                      <span className="text-[13px] text-muted">
                        Moyenne annuelle {formatGrade(r.annualAverageCenti)}
                        {r.annualRankLabel ? ` · rang ${r.annualRankLabel}` : ''}
                        {r.yearEndDecision ? (
                          <strong className="text-ink"> · {r.yearEndDecision}</strong>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {exams.data && exams.data.length > 0 ? (
        <Card>
          <CardHeader title="Résultats d’examens" />
          <ul className="flex flex-col gap-3">
            {exams.data.map((x) => (
              <li
                key={x.sessionId}
                className="border-t border-line pt-3 first:border-t-0 first:pt-0"
              >
                <div className="flex items-start gap-3">
                  <GraduationCap className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                  <span className="flex flex-1 flex-col">
                    <strong className="text-[15px]">{x.name}</strong>
                    <span className="text-[13px] text-muted">
                      {x.kindLabel} · moyenne {formatGrade(x.averageCenti)}
                      {x.rank ? ` · rang ${x.rank}` : ''}
                      {x.appreciation ? ` · ${x.appreciation}` : ''}
                    </span>
                  </span>
                </div>
                <ul className="mt-2 flex flex-col pl-8">
                  {x.papers.map((p) => (
                    <li
                      key={p.paperId}
                      className="flex items-center justify-between gap-3 py-1 text-sm"
                    >
                      <span>{p.subjectName}</span>
                      <strong className="tabular">
                        {p.value}
                        <span className="text-[13px] font-medium text-muted"> /{p.maxScore}</span>
                      </strong>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card>
        <CardHeader
          title="Relevés de notes"
          subtitle="Trimestre et année disponibles après la publication du bulletin"
        />
        {transcriptLinks.length === 0 ? (
          <p className="text-sm text-muted">Aucun relevé disponible pour l’instant.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {transcriptLinks.map((l) => (
              <li key={l.key}>
                <button
                  type="button"
                  onClick={() =>
                    openPdf(`/portal/children/${selected.id}/transcript.pdf?${l.query}`).catch(() =>
                      toast('Relevé indisponible', 'error'),
                    )
                  }
                  className="flex min-h-12 w-full items-center gap-3 rounded-[12px] border border-line px-3 text-left"
                >
                  <ScrollText className="size-5 shrink-0 text-primary" aria-hidden />
                  <span className="flex-1 text-[15px] font-semibold">Relevé · {l.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Notes récentes" />
        {q.data.grades.length === 0 ? (
          <p className="text-sm text-muted">Aucune note soumise pour l’instant.</p>
        ) : (
          <ul className="flex flex-col">
            {q.data.grades.map((g) => (
              <li
                key={g.id}
                className="flex items-center justify-between gap-3 border-t border-line py-2.5 first:border-t-0"
              >
                <span className="flex flex-col">
                  <strong className="text-[15px]">{g.subject}</strong>
                  <span className="text-[13px] text-muted">
                    {g.evaluation} · {g.sequence}
                  </span>
                </span>
                <strong className="text-lg tabular">
                  {g.value}
                  <span className="text-[13px] font-medium text-muted"> /{g.maxScore}</span>
                </strong>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
