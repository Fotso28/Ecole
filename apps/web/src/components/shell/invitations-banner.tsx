'use client';

import { useMutation } from '@tanstack/react-query';
import { MailPlus } from 'lucide-react';
import { ROLE_LABELS } from '@ecole/shared';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Invitations à rejoindre le personnel d'une autre école : acceptées ou refusées à la connexion. */
export function InvitationsBanner() {
  const { me, reload, switchSchool } = useAuth();
  const toast = useToast();
  const respond = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      api<{ schoolId: string }>(`/auth/invitations/${id}/${accept ? 'accept' : 'decline'}`, {
        method: 'POST',
      }),
    onSuccess: async (r, { accept }) => {
      toast(
        accept
          ? 'Invitation acceptée : l’établissement est ajouté à vos accès'
          : 'Invitation refusée',
      );
      if (accept && !me?.activeSchool) await switchSchool(r.schoolId);
      else await reload();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const invitations = me?.invitations ?? [];
  if (invitations.length === 0) return null;
  return (
    <section
      aria-label="Invitations reçues"
      className="flex flex-col gap-2 bg-info-soft px-4 py-3 lg:px-8"
    >
      {invitations.map((i) => (
        <div key={i.id} className="flex flex-wrap items-center gap-3 text-sm">
          <MailPlus className="size-5 shrink-0 text-info" aria-hidden />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <strong>{i.school.name}</strong> ({i.school.city}) vous invite à rejoindre son personnel
            : {i.roles.map((r) => ROLE_LABELS[r]).join(', ')}.
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => respond.mutate({ id: i.id, accept: true })}
              loading={
                respond.isPending && respond.variables?.id === i.id && respond.variables.accept
              }
            >
              Accepter
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => respond.mutate({ id: i.id, accept: false })}
            >
              Refuser
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
