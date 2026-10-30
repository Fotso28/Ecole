'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatFileSize } from '@ecole/shared';
import { Paperclip } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { api, openFile } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatShortDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Justification {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  reason: string;
  createdAt: string;
  attachment: { id: string; name: string; mimeType: string; size: number } | null;
  hasAttachment: boolean;
  student: { id: string; firstName: string; lastName: string; matricule: string } | null;
  records: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    status: 'ABSENT' | 'LATE';
  }[];
}

const TABS = [
  ['PENDING', 'À traiter'],
  ['ACCEPTED', 'Acceptés'],
  ['REJECTED', 'Refusés'],
] as const;

export default function JustificationsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Justification['status']>('PENDING');
  const q = useQuery({
    queryKey: ['justifications', status],
    queryFn: () => api<Justification[]>(`/attendance/justifications?status=${status}`),
  });
  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'ACCEPTED' | 'REJECTED' }) =>
      api(`/attendance/justifications/${id}`, { method: 'PATCH', body: { decision } }),
    onSuccess: (_d, v) => {
      toast(v.decision === 'ACCEPTED' ? 'Absence justifiée' : 'Justificatif refusé');
      void queryClient.invalidateQueries({ queryKey: ['justifications'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  return (
    <>
      <PageHeader
        title="Justificatifs d’absence"
        subtitle="Déposés par les parents depuis le portail ou saisis par la vie scolaire."
      />
      <div role="tablist" className="flex gap-2">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={status === value}
            onClick={() => setStatus(value)}
            className={cn(
              'min-h-11 rounded-full border px-4 text-sm font-semibold lg:min-h-9',
              status === value
                ? 'border-primary bg-primary text-white'
                : 'border-line-strong bg-white',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Aucun justificatif" />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {q.data.map((j) => (
            <li key={j.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <strong>
                      {j.student?.lastName} {j.student?.firstName}
                    </strong>
                    <p className="text-xs text-muted">Déposé le {formatDateTime(j.createdAt)}</p>
                  </div>
                  <Badge
                    tone={
                      j.status === 'PENDING'
                        ? 'warn'
                        : j.status === 'ACCEPTED'
                          ? 'success'
                          : 'danger'
                    }
                  >
                    {j.status === 'PENDING'
                      ? 'À traiter'
                      : j.status === 'ACCEPTED'
                        ? 'Accepté'
                        : 'Refusé'}
                  </Badge>
                </div>
                <p className="rounded-[10px] bg-paper p-3 text-sm">« {j.reason} »</p>
                <ul className="flex flex-col gap-1 text-sm">
                  {j.records.map((r) => (
                    <li key={r.id}>
                      {r.status === 'ABSENT' ? 'Absence' : 'Retard'} du {formatShortDate(r.date)},{' '}
                      {r.startTime}–{r.endTime}
                    </li>
                  ))}
                </ul>
                {j.hasAttachment ? (
                  j.attachment ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      aria-label={`Voir la pièce jointe de ${j.student?.firstName ?? 'l’élève'} (${formatFileSize(j.attachment.size)})`}
                      onClick={() =>
                        openFile(`/attendance/justifications/${j.id}/attachment`).catch((e) =>
                          toast(e instanceof Error ? e.message : 'Erreur', 'error'),
                        )
                      }
                    >
                      <Paperclip className="size-4" aria-hidden />
                      Voir la pièce jointe · {formatFileSize(j.attachment.size)}
                    </Button>
                  ) : (
                    <p className="flex items-center gap-1.5 text-sm text-muted">
                      <Paperclip className="size-4" aria-hidden />
                      Pièce jointe fournie
                    </p>
                  )
                ) : null}
                {j.status === 'PENDING' && can('attendance.justify') ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => review.mutate({ id: j.id, decision: 'REJECTED' })}
                      disabled={review.isPending}
                    >
                      Refuser
                    </Button>
                    <Button
                      onClick={() => review.mutate({ id: j.id, decision: 'ACCEPTED' })}
                      loading={review.isPending && review.variables?.id === j.id}
                    >
                      Accepter
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
