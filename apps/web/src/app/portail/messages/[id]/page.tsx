'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { ChatView } from '@/components/messaging/chat';
import { ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { MESSAGES_REFRESH_MS, type ThreadDetail } from '@/lib/communication';

export default function PortalThreadPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['portal-thread', id],
    queryFn: () => api<ThreadDetail>(`/portal/messages/threads/${id}`),
    refetchInterval: MESSAGES_REFRESH_MS,
  });
  const send = useMutation({
    mutationFn: (body: string) =>
      api<ThreadDetail>(`/portal/messages/threads/${id}/messages`, {
        method: 'POST',
        body: { body },
      }),
    onSuccess: (thread) => {
      queryClient.setQueryData(['portal-thread', id], thread);
      void queryClient.invalidateQueries({ queryKey: ['portal-threads'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  useEffect(() => {
    if (q.dataUpdatedAt)
      void queryClient.invalidateQueries({ queryKey: ['portal-messages-unread'] });
  }, [q.dataUpdatedAt, queryClient]);
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const t = q.data;
  return (
    <ChatView
      headingLevel={2}
      backHref="/portail/messages"
      title={`${t.staff.firstName} ${t.staff.lastName}`}
      subtitle={[t.staff.labels.join(', '), `au sujet de ${t.student.firstName}`]
        .filter(Boolean)
        .join(' · ')}
      messages={t.messages}
      sending={send.isPending}
      onSend={(body) => send.mutateAsync(body)}
    />
  );
}
