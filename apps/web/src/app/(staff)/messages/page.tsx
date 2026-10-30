'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PenSquare, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ThreadList } from '@/components/messaging/chat';
import { StudentPicker, type PickedStudent } from '@/components/students/student-picker';
import { Button, ButtonLink } from '@/components/ui/button';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  MESSAGES_REFRESH_MS,
  RELATION_LABELS,
  type ThreadDetail,
  type ThreadSummary,
} from '@/lib/communication';

interface GuardianContact {
  guardianId: string;
  firstName: string;
  lastName: string;
  relationship: keyof typeof RELATION_LABELS;
  isPrimary: boolean;
  portalActive: boolean;
}

function NewConversation({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [student, setStudent] = useState<PickedStudent[]>([]);
  const studentId = student[0]?.id;
  const guardians = useQuery({
    queryKey: ['message-contacts', studentId],
    queryFn: () => api<GuardianContact[]>(`/messages/contacts?studentId=${studentId}`),
    enabled: !!studentId,
  });
  const start = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ThreadDetail>('/messages/threads', { method: 'POST', body }),
    onSuccess: (thread) => {
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
      onClose();
      router.push(`/messages/${thread.id}`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <form
      className="flex flex-col gap-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start.mutate({ studentId, guardianId: fd.get('guardianId'), body: fd.get('body') });
      }}
    >
      <StudentPicker value={student} onChange={setStudent} label="Au sujet de l’élève" />
      {studentId ? (
        <>
          <SelectField label="Parent destinataire" name="guardianId" required>
            {(guardians.data ?? []).map((g) => (
              <option key={g.guardianId} value={g.guardianId}>
                {g.firstName} {g.lastName} ({RELATION_LABELS[g.relationship].toLowerCase()})
                {g.portalActive ? '' : ' · notifié par SMS'}
              </option>
            ))}
          </SelectField>
          <TextareaField label="Message" name="body" required maxLength={2000} />
          <Button type="submit" loading={start.isPending} disabled={!guardians.data?.length}>
            Envoyer
          </Button>
        </>
      ) : null}
    </form>
  );
}

export default function MessagesPage() {
  const { can } = useAuth();
  const [composing, setComposing] = useState(false);
  const threads = useQuery({
    queryKey: ['messages'],
    queryFn: () => api<ThreadSummary[]>('/messages/threads'),
    refetchInterval: MESSAGES_REFRESH_MS,
  });
  return (
    <>
      <PageHeader
        title="Messages"
        subtitle="Échanges avec les parents, au sujet d’un élève. Les parents sont prévenus par SMS ou e-mail."
        actions={
          <>
            {can('messaging.oversee') ? (
              <ButtonLink href="/messages/supervision" variant="secondary">
                <ShieldCheck className="size-4" aria-hidden />
                Supervision
              </ButtonLink>
            ) : null}
            <Button onClick={() => setComposing(true)}>
              <PenSquare className="size-4" aria-hidden />
              Nouveau message
            </Button>
          </>
        }
      />
      {threads.isPending ? (
        <LoadingBlock />
      ) : threads.isError ? (
        <ErrorBlock error={threads.error} onRetry={() => threads.refetch()} />
      ) : threads.data.length === 0 ? (
        <EmptyState title="Aucune conversation">
          Écrivez aux parents d’un de vos élèves avec « Nouveau message ».
        </EmptyState>
      ) : (
        <ThreadList threads={threads.data} viewer="STAFF" hrefFor={(id) => `/messages/${id}`} />
      )}
      <Sheet open={composing} onClose={() => setComposing(false)} title="Nouveau message">
        {composing ? <NewConversation onClose={() => setComposing(false)} /> : null}
      </Sheet>
    </>
  );
}
