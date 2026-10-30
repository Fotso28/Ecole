'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/card';
import { Checkbox, InputField, SelectField, TextareaField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDateTime, plural } from '@/lib/format';
import { useClasses } from '@/lib/queries';

interface Announcement {
  id: string;
  title: string;
  body: string;
  scope: 'SCHOOL' | 'CYCLE' | 'LEVEL' | 'CLASS';
  publishedAt: string;
}
interface Cycle {
  id: string;
  name: string;
  levels: { id: string; name: string }[];
}

export default function AnnouncementsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const classes = useClasses();
  const cycles = useQuery({
    queryKey: ['cycles'],
    queryFn: () => api<Cycle[]>('/academic/cycles'),
  });
  const list = useQuery({
    queryKey: ['announcements'],
    queryFn: () => api<Announcement[]>('/announcements'),
  });
  const [scope, setScope] = useState<Announcement['scope']>('SCHOOL');
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ sms: number }>('/announcements', { method: 'POST', body }),
    onSuccess: (r) => {
      toast(
        r.sms
          ? `Annonce publiée · ${plural(r.sms, 'SMS envoyé', 'SMS envoyés')}`
          : 'Annonce publiée sur le portail',
      );
      void queryClient.invalidateQueries({ queryKey: ['announcements'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const targets =
    scope === 'CLASS'
      ? (classes.data ?? []).map((c) => ({ id: c.id, name: c.name }))
      : scope === 'LEVEL'
        ? (cycles.data ?? []).flatMap((c) => c.levels)
        : scope === 'CYCLE'
          ? (cycles.data ?? []).map((c) => ({ id: c.id, name: c.name }))
          : [];

  return (
    <>
      <PageHeader
        title="Annonces"
        subtitle="Visibles sur le portail des parents, avec envoi SMS facultatif au parent principal."
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_3fr] lg:items-start">
        <Card>
          <CardHeader title="Nouvelle annonce" />
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const fd = new FormData(form);
              create.mutate(
                {
                  title: fd.get('title'),
                  body: fd.get('body'),
                  scope,
                  targetId: fd.get('targetId') || undefined,
                  sendSms: fd.get('sendSms') === 'on',
                },
                { onSuccess: () => form.reset() },
              );
            }}
          >
            <InputField label="Titre" name="title" required minLength={3} maxLength={120} />
            <TextareaField label="Message" name="body" required minLength={3} />
            <SelectField
              label="Destinataires"
              value={scope}
              onChange={(e) => setScope(e.target.value as Announcement['scope'])}
            >
              <option value="SCHOOL">Toute l’école</option>
              <option value="CYCLE">Un cycle</option>
              <option value="LEVEL">Un niveau</option>
              <option value="CLASS">Une classe</option>
            </SelectField>
            {scope !== 'SCHOOL' ? (
              <SelectField label="Cible" name="targetId" required>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </SelectField>
            ) : null}
            <Checkbox
              name="sendSms"
              label="Envoyer aussi un SMS au parent principal de chaque élève concerné"
            />
            <Button type="submit" loading={create.isPending}>
              Publier
            </Button>
          </form>
        </Card>
        <div className="flex flex-col gap-3">
          {list.data?.length === 0 ? <EmptyState title="Aucune annonce" /> : null}
          {list.data?.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-col gap-1">
                <strong>{a.title}</strong>
                <span className="text-xs text-muted">{formatDateTime(a.publishedAt)}</span>
                <p className="mt-1 text-sm whitespace-pre-line">{a.body}</p>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
