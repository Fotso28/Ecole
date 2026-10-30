'use client';

import { formatFileSize } from '@ecole/shared';
import { FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { openFile } from '@/lib/api';
import { formatShortDate, formatWeekday, todayIso } from '@/lib/format';
import { useChildHomework, type PortalMaterial } from '@/lib/portal';

function MaterialButton({ m }: { m: PortalMaterial }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        openFile(`/portal/materials/${m.id}/file`).catch(() =>
          toast('Support indisponible', 'error'),
        )
      }
      className="flex min-h-14 w-full items-center gap-3 border-t border-line text-left first:border-t-0"
    >
      <FileText className="size-5 shrink-0 text-primary" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="truncate text-[15px]">{m.title}</strong>
        <span className="text-[13px] text-muted">
          {m.subjectName ?? ''}
          {m.file ? ` · ${formatFileSize(m.file.size)}` : ''} · {formatShortDate(m.createdAt)}
        </span>
      </span>
    </button>
  );
}

function dueLabel(due: string, today: string): string {
  if (due === today) return 'Pour aujourd’hui';
  return `Pour ${formatWeekday(due)}`;
}

export default function PortalHomework() {
  const { selected } = useChildren();
  const q = useChildHomework(selected?.id);
  if (!selected || q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} />;
  const today = todayIso();
  return (
    <>
      <ChildSwitcher />
      <Card>
        <CardHeader
          title="Devoirs à faire"
          subtitle={q.data.className ? `Cahier de texte de la ${q.data.className}` : undefined}
        />
        {q.data.homework.length === 0 ? (
          <p className="text-sm text-muted">Aucun devoir à faire pour l’instant.</p>
        ) : (
          <ul className="flex flex-col">
            {q.data.homework.map((h) => (
              <li
                key={h.id}
                className="flex flex-col gap-1.5 border-t border-line py-3 first:border-t-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-[15px]">{h.subjectName}</strong>
                  {h.homeworkDueDate ? (
                    <Badge tone={h.homeworkDueDate === today ? 'warn' : 'info'}>
                      {dueLabel(h.homeworkDueDate, today)}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-[15px] whitespace-pre-line">{h.homework}</p>
                <p className="text-[13px] text-muted">
                  Séance du {formatShortDate(h.date)} : {h.content}
                </p>
                {h.materials.length > 0 ? (
                  <div className="rounded-[10px] bg-paper px-3">
                    {h.materials.map((m) => (
                      <MaterialButton key={m.id} m={m} />
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Supports de cours" />
        {q.data.materials.length === 0 ? (
          <p className="text-sm text-muted">Aucun support de cours partagé.</p>
        ) : (
          <div className="flex flex-col">
            {q.data.materials.map((m) => (
              <MaterialButton key={m.id} m={m} />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
