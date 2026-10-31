'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StudentPicker, type PickedStudent } from '@/components/students/student-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/ui/card';
import { Checkbox, InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, plural } from '@/lib/format';
import { useClasses } from '@/lib/queries';

interface Announcement {
  id: string;
  title: string;
  body: string;
  scope: 'SCHOOL' | 'CYCLE' | 'LEVEL' | 'CLASS' | 'STUDENTS';
  studentIds: string[];
  publishedAt: string;
  /** Destinataires en clair (« Classe 4e A », « Toute l’école », noms des élèves choisis). */
  audience: string;
  withdrawnAt: string | null;
}
interface Cycle {
  id: string;
  name: string;
  levels: { id: string; name: string }[];
}

export default function AnnouncementsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
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
  const [targetId, setTargetId] = useState('');
  const [students, setStudents] = useState<PickedStudent[]>([]);
  const [withdrawing, setWithdrawing] = useState<Announcement | null>(null);
  const withdraw = useMutation({
    mutationFn: (id: string) => api(`/announcements/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Annonce retirée : elle n’est plus visible sur le portail des parents');
      setWithdrawing(null);
      void queryClient.invalidateQueries({ queryKey: ['announcements'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
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
      setTargetId('');
      void queryClient.invalidateQueries({ queryKey: ['announcements'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const needsTarget = scope !== 'SCHOOL' && scope !== 'STUDENTS';
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
                  targetId: needsTarget ? targetId : undefined,
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
              onChange={(e) => {
                setScope(e.target.value as Announcement['scope']);
                setTargetId('');
              }}
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
            {needsTarget ? (
              <SelectField
                label={scope === 'CLASS' ? 'Classe' : scope === 'LEVEL' ? 'Niveau' : 'Cycle'}
                name="targetId"
                required
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">Choisir…</option>
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
              disabled={
                (scope === 'STUDENTS' && students.length === 0) || (needsTarget && !targetId)
              }
            >
              Publier
            </Button>
          </form>
        </Card>
        <div className="flex flex-col gap-3">
          {list.data?.length === 0 ? <EmptyState title="Aucune annonce" /> : null}
          {list.data?.map((a) => (
            <Card key={a.id} className={a.withdrawnAt ? 'opacity-80' : undefined}>
              <article className="flex flex-col gap-1" aria-label={a.title}>
                <div className="flex items-start justify-between gap-2">
                  <strong className="[overflow-wrap:anywhere]">{a.title}</strong>
                  {a.withdrawnAt ? <Badge tone="neutral">Retirée</Badge> : null}
                </div>
                <span className="text-xs text-muted">
                  {formatDateTime(a.publishedAt)}
                  {a.withdrawnAt ? ` · retirée le ${formatDateTime(a.withdrawnAt)}` : ''}
                </span>
                <p className="text-sm">
                  <span className="font-semibold">Destinataires :</span>{' '}
                  {a.scope === 'STUDENTS'
                    ? `${plural(a.studentIds.length, 'élève visé', 'élèves visés')} (${a.audience})`
                    : a.audience}
                </p>
                <p className="mt-1 text-sm whitespace-pre-line">{a.body}</p>
                {!a.withdrawnAt && can('communication.write') ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2 self-start"
                    onClick={() => setWithdrawing(a)}
                  >
                    Retirer l’annonce
                  </Button>
                ) : null}
              </article>
            </Card>
          ))}
        </div>
      </div>
      <Sheet
        open={!!withdrawing}
        onClose={() => setWithdrawing(null)}
        title="Retirer l’annonce ?"
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setWithdrawing(null)}>
              Annuler
            </Button>
            <Button
              variant="danger"
              loading={withdraw.isPending}
              onClick={() => withdrawing && withdraw.mutate(withdrawing.id)}
            >
              Retirer
            </Button>
          </div>
        }
      >
        {withdrawing ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              <strong>{withdrawing.title}</strong> · {withdrawing.audience}
            </p>
            <p className="text-muted">
              Elle disparaît du portail des parents ; les SMS et e-mails pas encore partis sont
              annulés. Ceux déjà envoyés ne peuvent pas être rappelés. Le retrait est inscrit au
              journal d’audit.
            </p>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
