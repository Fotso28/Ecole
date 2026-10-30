'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bus, CircleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui/card';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { InputField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatCameroonPhone } from '@/lib/format';
import { formatFcfa, formatShortDate, formatWeekday } from '@/lib/format';
import { useChildOverview } from '@/lib/portal';

export default function PortalHome() {
  const { children, selected } = useChildren();
  const q = useChildOverview(selected?.id);
  if (!selected)
    return children.length === 0 ? (
      <EmptyState title="Aucun enfant rattaché à ce numéro">
        Contactez le secrétariat de l’école.
      </EmptyState>
    ) : (
      <LoadingBlock />
    );
  const unjustified =
    q.data?.absences.filter((a) => a.status === 'ABSENT' && !a.justification) ?? [];
  return (
    <>
      <ChildSwitcher />
      <section className="flex flex-col gap-3.5 rounded-[18px] bg-night p-4 text-white">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-night-text">
            {selected.firstName} · {selected.className ?? '—'}
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-bold text-ink ${selected.overdue > 0 ? 'bg-[#f6c7c2]' : 'bg-primary-soft'}`}
          >
            {selected.overdue > 0 ? 'En retard' : 'À jour'}
          </span>
        </div>
        <div>
          <span className="text-sm text-night-text">Reste à payer</span>
          <strong className="block font-display text-[34px] leading-tight tabular">
            {formatFcfa(selected.balance)}
          </strong>
        </div>
        {selected.nextDue ? (
          <span className="text-sm text-night-ink">
            Prochaine échéance : {formatFcfa(selected.nextDue.amount)} le{' '}
            {formatShortDate(selected.nextDue.dueDate)}
          </span>
        ) : null}
        {selected.balance > 0 ? (
          <ButtonLink href="/portail/paiement" variant="saffron" size="lg" block>
            Payer {selected.nextDue ? formatFcfa(selected.nextDue.amount) : ''}
          </ButtonLink>
        ) : null}
      </section>

      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {unjustified.length > 0 ? (
            <section className="flex gap-3 rounded-[16px] bg-danger-soft p-4">
              <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
              <div className="flex flex-1 flex-col gap-1.5">
                <strong className="text-[15px]">
                  {unjustified.length > 1
                    ? `${unjustified.length} absences non justifiées`
                    : 'Absence non justifiée'}
                </strong>
                <span className="text-sm text-muted">
                  {formatWeekday(unjustified[0]!.date).replace(/^./, (c) => c.toUpperCase())},{' '}
                  {unjustified[0]!.startTime}–{unjustified[0]!.endTime}
                </span>
                <Link
                  href="/portail/absences"
                  className="mt-1 flex min-h-11 items-center self-start rounded-[12px] border border-danger bg-white px-4 text-sm font-bold text-danger"
                >
                  Justifier
                </Link>
              </div>
            </section>
          ) : null}

          <Card>
            <CardHeader
              title="Dernières notes"
              action={
                <Link href="/portail/notes" className="text-sm font-semibold text-primary">
                  Tout voir
                </Link>
              }
            />
            {q.data.grades.length === 0 ? (
              <p className="text-sm text-muted">
                Les notes apparaissent ici dès que l’enseignant les a soumises.
              </p>
            ) : (
              <ul className="flex flex-col">
                {q.data.grades.slice(0, 4).map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center justify-between gap-3 border-t border-line py-2.5 first:border-t-0"
                  >
                    <span className="flex flex-col">
                      <strong className="text-[15px]">{g.subject}</strong>
                      <span className="text-[13px] text-muted">
                        {g.evaluation} · {g.sequence}
                      </span>
                    </span>
                    <strong className="text-lg tabular">
                      {g.value}
                      <span className="text-[13px] font-medium text-muted"> /{g.maxScore}</span>
                    </strong>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Link
            href="/portail/transport"
            className="flex min-h-14 items-center gap-3 rounded-[14px] border border-line bg-white px-4 py-3"
          >
            <Bus className="size-5 shrink-0 text-primary" aria-hidden />
            <span className="flex flex-1 flex-col">
              <strong className="text-[15px]">Transport scolaire</strong>
              <span className="text-[13px] text-muted">Ligne, arrêt et horaires du car</span>
            </span>
          </Link>

          {q.data.announcements.map((a) => (
            <Card key={a.id} className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
                Annonce de l’école
              </span>
              <strong className="text-[15px]">{a.title}</strong>
              <p className="text-sm text-muted">{a.body}</p>
            </Card>
          ))}
        </>
      )}
      <ContactCard />
    </>
  );
}

/** Coordonnées du parent : téléphone de connexion, e-mail facultatif pour les notifications. */
function ContactCard() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const q = useQuery({
    queryKey: ['portal-contact'],
    queryFn: () => api<{ phone: string | null; email: string | null }>('/portal/contact'),
  });
  const save = useMutation({
    mutationFn: (email: string | null) =>
      api('/portal/contact', { method: 'PATCH', body: { email } }),
    onSuccess: () => {
      toast('Coordonnées enregistrées');
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['portal-contact'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  if (!q.data) return null;
  return (
    <Card>
      <CardHeader
        title="Mes coordonnées"
        subtitle="L’école vous prévient par SMS ou par e-mail selon vos coordonnées."
      />
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Téléphone</dt>
          <dd className="font-semibold tabular">
            {q.data.phone ? formatCameroonPhone(q.data.phone) : '—'}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">E-mail</dt>
          <dd className="font-semibold [overflow-wrap:anywhere]">
            {q.data.email ?? 'Non renseigné'}
          </dd>
        </div>
      </dl>
      {editing ? (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = String(new FormData(e.currentTarget).get('email') ?? '').trim();
            save.mutate(value || null);
          }}
        >
          <InputField
            label="Adresse e-mail"
            name="email"
            type="email"
            inputMode="email"
            optional
            defaultValue={q.data.email ?? ''}
            hint="Laissez vide pour ne recevoir que des SMS."
          />
          <Button type="submit" loading={save.isPending} block>
            Enregistrer
          </Button>
        </form>
      ) : (
        <Button variant="secondary" block className="mt-3" onClick={() => setEditing(true)}>
          {q.data.email ? 'Modifier mon e-mail' : 'Ajouter mon e-mail'}
        </Button>
      )}
    </Card>
  );
}
