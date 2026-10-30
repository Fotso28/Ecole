'use client';

import { SUBSCRIPTION_PRICING_LABELS } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { StateBadge } from '@/components/billing';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { Checkbox, InputField, SelectField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { BillingWarning, Invoice, Plan } from '@/lib/billing';
import { formatDate, formatDateTime, formatFcfa } from '@/lib/format';

interface SchoolSettings {
  id: string;
  name: string;
  city: string;
  address: string | null;
  phone: string | null;
  matriculePrefix: string;
  modules: string[];
  settings: {
    absenceAlertThreshold?: number;
    absenceNotificationDelayMinutes?: number;
    reminderOffsets?: number[];
    mfaRequired?: boolean;
    preferredChannel?: 'SMS' | 'EMAIL';
  };
}
interface AuditPage {
  total: number;
  items: {
    id: string;
    action: string;
    entity: string;
    createdAt: string;
    reason: string | null;
    actor: { firstName: string; lastName: string } | null;
  }[];
}

interface Subscription {
  plan: Plan | null;
  invoices: Invoice[];
  warning: BillingWarning | null;
}

/** Abonnement de l'école : facture et statut, avertissement sans coupure de l'accès. */
function SubscriptionCard() {
  const q = useQuery({
    queryKey: ['subscription'],
    queryFn: () => api<Subscription>('/subscription'),
  });
  if (!q.data) return null;
  const { plan, invoices, warning } = q.data;
  return (
    <Card id="abonnement">
      <CardHeader
        title="Abonnement"
        subtitle={
          plan
            ? `Offre ${plan.name} · ${SUBSCRIPTION_PRICING_LABELS[plan.pricing].toLowerCase()}`
            : 'Aucune offre enregistrée par la plateforme.'
        }
      />
      {warning ? (
        <div
          role="status"
          className="mb-3 flex items-start gap-3 rounded-[12px] bg-warn-soft p-3 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <span>
            {warning.level === 'overdue'
              ? 'Votre facture d’abonnement est en retard'
              : 'Une facture d’abonnement est en attente de règlement'}{' '}
            : reste à payer <strong className="tabular">{formatFcfa(warning.due)}</strong>. Votre
            accès n’est pas interrompu ; merci de régulariser auprès de la plateforme.
          </span>
        </div>
      ) : null}
      {invoices.length === 0 ? (
        <p className="text-sm text-muted">Aucune facture pour l’instant.</p>
      ) : (
        <ul className="flex flex-col">
          {invoices.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-col gap-1 border-t border-line py-2.5 text-sm first:border-t-0 sm:flex-row sm:items-center sm:gap-3"
            >
              <span className="flex flex-1 flex-col">
                <strong className="font-semibold tabular">
                  {inv.number} · {inv.period}
                </strong>
                <span className="text-[13px] text-muted">
                  {inv.studentCount} élèves · échéance le {formatDate(inv.dueDate)}
                </span>
              </span>
              <span className="tabular">
                {formatFcfa(inv.amount)}
                {inv.due > 0 && inv.state !== 'CANCELLED' ? (
                  <span className="text-danger"> · reste {formatFcfa(inv.due)}</span>
                ) : null}
              </span>
              <StateBadge state={inv.state} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const MODULE_LABELS: Record<string, string> = {
  students: 'Élèves',
  attendance: 'Présences',
  grades: 'Notes et bulletins',
  finance: 'Scolarité',
  communication: 'Communication',
  portal: 'Portail parents',
  timetable: 'Emploi du temps',
  exams: 'Examens',
  documents: 'Documents',
  accounting: 'Comptabilité',
};

export default function SettingsPage() {
  const { can, reload } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<SchoolSettings>('/settings') });
  const audit = useQuery({
    queryKey: ['audit'],
    queryFn: () => api<AuditPage>('/audit-logs?pageSize=30'),
    enabled: can('audit.read'),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/settings', { method: 'PATCH', body }),
    onSuccess: () => {
      toast('Paramètres enregistrés');
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void reload();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} />;
  const s = q.data;
  return (
    <>
      <PageHeader
        title="Paramètres"
        subtitle={`${s.name} · préfixe des matricules ${s.matriculePrefix}`}
      />
      <Card>
        <CardHeader title="Établissement et règles" />
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            save.mutate({
              phone: String(fd.get('phone') ?? ''),
              address: String(fd.get('address') ?? ''),
              settings: {
                absenceAlertThreshold: Number(fd.get('absenceAlertThreshold')),
                absenceNotificationDelayMinutes: Number(fd.get('absenceNotificationDelayMinutes')),
                reminderOffsets: String(fd.get('reminderOffsets'))
                  .split(/[,; ]+/)
                  .map(Number)
                  .filter((n) => Number.isInteger(n) && n > 0),
                mfaRequired: fd.get('mfaRequired') === 'on',
                preferredChannel: fd.get('preferredChannel') === 'EMAIL' ? 'EMAIL' : 'SMS',
              },
            });
          }}
        >
          <InputField label="Téléphone" name="phone" defaultValue={s.phone ?? ''} />
          <InputField label="Adresse" name="address" defaultValue={s.address ?? ''} />
          <InputField
            label="Seuil d’alerte d’absences (sur 7 jours)"
            name="absenceAlertThreshold"
            type="number"
            min={1}
            max={30}
            defaultValue={s.settings.absenceAlertThreshold ?? 3}
          />
          <InputField
            label="Délai avant SMS d’absence (minutes)"
            name="absenceNotificationDelayMinutes"
            type="number"
            min={0}
            max={1440}
            defaultValue={s.settings.absenceNotificationDelayMinutes ?? 60}
          />
          <InputField
            label="Relances de scolarité (jours après l’échéance)"
            name="reminderOffsets"
            defaultValue={(s.settings.reminderOffsets ?? [5, 15, 30]).join(', ')}
            hint="Exemple : 5, 15, 30"
            containerClassName="sm:col-span-2"
          />
          <SelectField
            label="Canal des notifications aux familles"
            name="preferredChannel"
            defaultValue={s.settings.preferredChannel ?? 'SMS'}
            hint="Utilisé quand le parent a donné un téléphone et un e-mail ; sinon, le seul canal connu."
            containerClassName="sm:col-span-2"
          >
            <option value="SMS">SMS en priorité</option>
            <option value="EMAIL">E-mail en priorité</option>
          </SelectField>
          <Checkbox
            name="mfaRequired"
            defaultChecked={!!s.settings.mfaRequired}
            label="Exiger la double authentification pour la direction, le censeur, le secrétariat et la comptabilité"
            className="sm:col-span-2"
          />
          <Button
            type="submit"
            loading={save.isPending}
            className="sm:col-span-2 sm:justify-self-start"
          >
            Enregistrer
          </Button>
        </form>
      </Card>
      {can('subscription.read') ? <SubscriptionCard /> : null}
      <Card>
        <CardHeader
          title="Modules de l’abonnement"
          subtitle="L’activation des modules est gérée avec la plateforme."
        />
        <ul className="flex flex-wrap gap-2">
          {Object.entries(MODULE_LABELS).map(([k, v]) => (
            <li
              key={k}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${s.modules.includes(k) ? 'bg-primary-soft text-primary' : 'bg-neutral-soft text-muted line-through'}`}
            >
              {v}
            </li>
          ))}
        </ul>
      </Card>
      {can('audit.read') ? (
        <Card id="audit">
          <CardHeader
            title="Journal d’audit"
            subtitle={audit.data ? `${audit.data.total} actions enregistrées` : undefined}
          />
          <ol className="flex flex-col">
            {audit.data?.items.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-0.5 border-t border-line py-2 text-sm first:border-t-0 sm:flex-row sm:gap-3"
              >
                <span className="w-36 shrink-0 text-muted tabular">
                  {formatDateTime(a.createdAt)}
                </span>
                <span className="flex-1">
                  <strong className="font-semibold">
                    {a.actor ? `${a.actor.lastName} ${a.actor.firstName}` : 'Système'}
                  </strong>{' '}
                  · {a.action}
                  {a.reason ? <span className="text-muted"> · motif : {a.reason}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </>
  );
}
