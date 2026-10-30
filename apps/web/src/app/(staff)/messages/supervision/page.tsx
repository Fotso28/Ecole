'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Eye, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { ChatView } from '@/components/messaging/chat';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import type { ThreadDetail, ThreadSummary } from '@/lib/communication';
import { formatDateTime, plural } from '@/lib/format';

type OversightRow = Omit<ThreadSummary, 'lastMessage' | 'unread'> & { messageCount: number };

export default function SupervisionPage() {
  const toast = useToast();
  const [target, setTarget] = useState<OversightRow | null>(null);
  const [opened, setOpened] = useState<ThreadDetail | null>(null);
  const list = useQuery({
    queryKey: ['messages-oversight'],
    queryFn: () => api<OversightRow[]>('/messages/oversight'),
  });
  const consult = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      api<ThreadDetail>(`/messages/threads/${v.id}/consult`, {
        method: 'POST',
        body: { reason: v.reason },
      }),
    onSuccess: (thread) => {
      setTarget(null);
      setOpened(thread);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const reasonError =
    consult.error instanceof ApiError ? consult.error.fieldErrors[0]?.message : undefined;

  if (opened)
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col">
        <ChatView
          backHref="/messages/supervision"
          title={`${opened.staff.firstName} ${opened.staff.lastName} · ${opened.guardian.firstName} ${opened.guardian.lastName}`}
          subtitle={`Au sujet de ${opened.student.firstName} ${opened.student.lastName}`}
          messages={opened.messages}
          notice={
            <p className="flex items-center gap-2 rounded-[12px] bg-warn-soft p-3 text-sm">
              <ShieldAlert className="size-5 shrink-0 text-warn" aria-hidden />
              Consultation en lecture seule, inscrite au journal d’audit avec votre motif.
            </p>
          }
        />
        <Button variant="secondary" className="mt-3 self-start" onClick={() => setOpened(null)}>
          Fermer le fil
        </Button>
      </div>
    );

  return (
    <>
      <PageHeader
        title="Supervision des messages"
        subtitle="Les fils sont privés. Leur lecture exige un motif, conservé dans le journal d’audit."
      />
      {list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState title="Aucune conversation dans l’établissement" />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Conversations de l’établissement">
          {list.data.map((t) => (
            <li key={t.id}>
              <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <strong className="text-[15px]">
                    {t.staff.firstName} {t.staff.lastName} ↔ {t.guardian.firstName}{' '}
                    {t.guardian.lastName}
                  </strong>
                  <span className="text-[13px] text-muted">
                    {t.student.firstName} {t.student.lastName}
                    {t.student.className ? ` · ${t.student.className}` : ''} ·{' '}
                    {plural(t.messageCount, 'message', 'messages')} · dernier le{' '}
                    {formatDateTime(t.lastMessageAt)}
                  </span>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setTarget(t)}>
                  <Eye className="size-4" aria-hidden />
                  Consulter
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={!!target} onClose={() => setTarget(null)} title="Motif de la consultation">
        {target ? (
          <form
            className="flex flex-col gap-4 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
              consult.mutate({ id: target.id, reason });
            }}
          >
            <p className="text-sm text-muted">
              Fil entre {target.staff.firstName} {target.staff.lastName} et{' '}
              {target.guardian.firstName} {target.guardian.lastName}.
            </p>
            <TextareaField
              label="Motif"
              name="reason"
              required
              minLength={10}
              maxLength={300}
              error={reasonError}
              hint="Exemple : plainte d’un parent reçue le 30 octobre."
            />
            <Button type="submit" loading={consult.isPending}>
              Consulter le fil
            </Button>
          </form>
        ) : null}
      </Sheet>
    </>
  );
}
