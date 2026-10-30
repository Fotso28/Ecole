'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StudentPicker, type PickedStudent } from '@/components/students/student-picker';
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
  scope: 'SCHOOL' | 'CYCLE' | 'LEVEL' | 'CLASS' | 'STUDENTS';
  studentIds: string[];
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
  const [students, setStudents] = useState<PickedStudent[]>([]);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ sms: number; emails: number }>('/announcements', { method: 'POST', body }),
    onSuccess: (r) => {
      const sent = [
        r.sms ? plural(r.sms, 'SMS', 'SMS') : null,
        r.emails ? plural(r.emails, 'e-mail', 'e-mails') : null,
      ].filter(Boolean);
      toast(
        sent.length
          ? `Annonce publiée · ${sent.join(' et ')} en cours d’envoi`
          : 'Annonce publiée sur le portail',
      );
      setStudents([]);
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
        subtitle="Visibles sur le portail des parents, avec notification facultative (SMS ou e-mail) au parent principal."
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
                  studentIds: scope === 'STUDENTS' ? students.map((st) => st.id) : [],
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
              <option value="STUDENTS">Les parents d’élèves choisis</option>
            </SelectField>
            {scope === 'STUDENTS' ? (
              <StudentPicker multiple value={students} onChange={setStudents} label="Élèves" />
            ) : null}
            {scope !== 'SCHOOL' && scope !== 'STUDENTS' ? (
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
              label="Prévenir aussi le parent principal de chaque élève concerné (SMS ou e-mail)"
            />
            <Button
              type="submit"
              loading={create.isPending}
              disabled={scope === 'STUDENTS' && students.length === 0}
            >
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
                <span className="text-xs text-muted">
                  {formatDateTime(a.publishedAt)}
                  {a.scope === 'STUDENTS'
                    ? ` · ${plural(a.studentIds.length, 'élève visé', 'élèves visés')}`
                    : ''}
                </span>
                <p className="mt-1 text-sm whitespace-pre-line">{a.body}</p>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
