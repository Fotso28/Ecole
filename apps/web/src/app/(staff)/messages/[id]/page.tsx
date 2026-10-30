'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { ChatView } from '@/components/messaging/chat';
import { ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { MESSAGES_REFRESH_MS, RELATION_LABELS, type ThreadDetail } from '@/lib/communication';

export default function StaffThreadPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['message-thread', id],
    queryFn: () => api<ThreadDetail>(`/messages/threads/${id}`),
    refetchInterval: MESSAGES_REFRESH_MS,
  });
  const send = useMutation({
    mutationFn: (body: string) =>
      api<ThreadDetail>(`/messages/threads/${id}/messages`, { method: 'POST', body: { body } }),
    onSuccess: (thread) => {
      queryClient.setQueryData(['message-thread', id], thread);
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  // La lecture du fil met à jour le compteur de non-lus.
  useEffect(() => {
    if (q.dataUpdatedAt) void queryClient.invalidateQueries({ queryKey: ['messages-unread'] });
  }, [q.dataUpdatedAt, queryClient]);
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const t = q.data;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col">
      <ChatView
        backHref="/messages"
        title={`${t.guardian.firstName} ${t.guardian.lastName}`}
        subtitle={`${t.guardian.relationship ? `${RELATION_LABELS[t.guardian.relationship]} de ` : ''}${t.student.firstName} ${t.student.lastName}${t.student.className ? ` · ${t.student.className}` : ''}`}
        messages={t.messages}
        sending={send.isPending}
        onSend={(body) => send.mutateAsync(body)}
      />
    </div>
  );
}
