'use client';

import { FileText } from 'lucide-react';
import { Card, CardHeader, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { openPdf } from '@/lib/api';
import { formatGrade, formatShortDate } from '@/lib/format';
import { useChildOverview } from '@/lib/portal';

export default function PortalGrades() {
  const { selected } = useChildren();
  const toast = useToast();
  const q = useChildOverview(selected?.id);
  if (!selected || q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} />;
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
                  </span>
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
