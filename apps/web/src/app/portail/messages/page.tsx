'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PenSquare } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ThreadList } from '@/components/messaging/chat';
import { useChildren } from '@/components/shell/parent-shell';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { MESSAGES_REFRESH_MS, type ThreadDetail, type ThreadSummary } from '@/lib/communication';
import { cn } from '@/lib/utils';

interface StaffContact {
  userId: string;
  firstName: string;
  lastName: string;
  labels: string[];
}

function NewMessage({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { children, selected } = useChildren();
  const [childId, setChildId] = useState(selected?.id ?? children[0]?.id ?? '');
  const [staffId, setStaffId] = useState<string | null>(null);
  const contacts = useQuery({
    queryKey: ['portal-contacts', childId],
    queryFn: () => api<StaffContact[]>(`/portal/children/${childId}/contacts`),
    enabled: !!childId,
  });
  const start = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ThreadDetail>('/portal/messages/threads', { method: 'POST', body }),
    onSuccess: (thread) => {
      void queryClient.invalidateQueries({ queryKey: ['portal-threads'] });
      onClose();
      router.push(`/portail/messages/${thread.id}`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <form
      className="flex flex-col gap-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const body = new FormData(e.currentTarget).get('body');
        start.mutate({ studentId: childId, staffUserId: staffId, body });
      }}
    >
      {children.length > 1 ? (
        <SelectField
          label="Au sujet de"
          value={childId}
          onChange={(e) => {
            setChildId(e.target.value);
            setStaffId(null);
          }}
        >
          {children.map((c) => (
            <option key={c.id} value={c.id}>
              {c.firstName} · {c.className ?? '—'}
            </option>
          ))}
        </SelectField>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-semibold">Destinataire</legend>
        {contacts.isPending ? (
          <LoadingBlock />
        ) : (contacts.data ?? []).length === 0 ? (
          <p className="text-sm text-muted">Aucun interlocuteur disponible pour cette classe.</p>
        ) : (
          contacts.data?.map((c) => (
            <label
              key={c.userId}
              className={cn(
                'flex min-h-14 cursor-pointer items-center gap-3 rounded-[12px] border bg-white p-3',
                staffId === c.userId ? 'border-2 border-primary' : 'border-line',
              )}
            >
              <input
                type="radio"
                name="staff"
                value={c.userId}
                checked={staffId === c.userId}
                onChange={() => setStaffId(c.userId)}
                className="size-5 accent-primary"
              />
              <span className="flex min-w-0 flex-col">
                <strong className="text-[15px]">
                  {c.firstName} {c.lastName}
                </strong>
                <span className="text-[13px] text-muted">{c.labels.join(' · ')}</span>
              </span>
            </label>
          ))
        )}
      </fieldset>
      <TextareaField label="Message" name="body" required maxLength={2000} />
      <Button type="submit" loading={start.isPending} disabled={!staffId}>
        Envoyer
      </Button>
    </form>
  );
}

export default function PortalMessages() {
  const { children } = useChildren();
  const [composing, setComposing] = useState(false);
  const threads = useQuery({
    queryKey: ['portal-threads'],
    queryFn: () => api<ThreadSummary[]>('/portal/messages/threads'),
    refetchInterval: MESSAGES_REFRESH_MS,
  });
  return (
    <>
      <Card>
        <CardHeader
          title="Messages"
          subtitle="Écrivez aux enseignants, au professeur principal ou à la vie scolaire."
        />
        <Button block onClick={() => setComposing(true)} disabled={children.length === 0}>
          <PenSquare className="size-4" aria-hidden />
          Nouveau message
        </Button>
      </Card>
      {threads.isPending ? (
        <LoadingBlock />
      ) : threads.isError ? (
        <ErrorBlock error={threads.error} onRetry={() => threads.refetch()} />
      ) : threads.data.length === 0 ? (
        <EmptyState title="Aucune conversation">
          Les messages de l’école au sujet de vos enfants apparaîtront ici.
        </EmptyState>
      ) : (
        <ThreadList
          threads={threads.data}
          viewer="PARENT"
          hrefFor={(id) => `/portail/messages/${id}`}
        />
      )}
      <Sheet open={composing} onClose={() => setComposing(false)} title="Nouveau message">
        {composing ? <NewMessage onClose={() => setComposing(false)} /> : null}
      </Sheet>
    </>
  );
}
