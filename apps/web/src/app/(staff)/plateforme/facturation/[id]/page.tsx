'use client';

import {
  SUBSCRIPTION_MODULE_LABELS,
  SUBSCRIPTION_PAYMENT_METHOD_LABELS,
  SUBSCRIPTION_PRICING_LABELS,
  type Module,
  type SubscriptionLine,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PlatformError, StateBadge } from '@/components/billing';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { BillingWarning, Invoice, InvoicePayment, Plan } from '@/lib/billing';
import { formatDate, formatDateTime, formatFcfa, plural, todayIso } from '@/lib/format';

interface Detail {
  school: { id: string; name: string; city: string; status: string; modules: string[] };
  plan: Plan | null;
  preview: {
    period: string | null;
    studentCount: number;
    lines: SubscriptionLine[];
    total: number | null;
  };
  invoices: Invoice[];
  warning: BillingWarning | null;
}

type Dialog =
  | { kind: 'pay'; invoice: Invoice }
  | { kind: 'cancel'; invoice: Invoice }
  | { kind: 'correct'; invoice: Invoice; payment: InvoicePayment }
  | null;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function Lines({ lines, total }: { lines: SubscriptionLine[]; total: number }) {
  return (
    <dl className="flex flex-col text-sm">
      {lines.map((l) => (
        <div
          key={l.label}
          className="flex flex-wrap justify-between gap-x-3 border-t border-line py-1.5 first:border-t-0"
        >
          <dt>
            {l.label}
            {l.quantity > 1 ? (
              <span className="text-muted tabular">
                {' '}
                · {l.quantity} × {formatFcfa(l.unitPrice)}
              </span>
            ) : null}
          </dt>
          <dd className="tabular">{l.amount === 0 ? 'Inclus' : formatFcfa(l.amount)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t border-line-strong pt-2 font-bold">
        <dt>Total annuel</dt>
        <dd className="tabular">{formatFcfa(total)}</dd>
      </div>
    </dl>
  );
}

export default function SchoolBillingPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['billing-school', id],
    queryFn: () => api<Detail>(`/platform/billing/schools/${id}`),
  });
  const plans = useQuery({
    queryKey: ['billing-plans'],
    queryFn: () => api<Plan[]>('/platform/billing/plans'),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['billing-school', id] });
    void queryClient.invalidateQueries({ queryKey: ['billing-overview'] });
  };
  const onError = (e: unknown) => toast(e instanceof Error ? e.message : 'Erreur', 'error');
  const assign = useMutation({
    mutationFn: (planId: string) =>
      api(`/platform/billing/schools/${id}/subscription`, { method: 'PUT', body: { planId } }),
    onSuccess: () => {
      toast('Offre enregistrée');
      refresh();
    },
    onError,
  });
  const issue = useMutation({
    mutationFn: (dueDate: string) =>
      api<Invoice>(`/platform/billing/schools/${id}/invoices`, {
        method: 'POST',
        body: { dueDate },
      }),
    onSuccess: (invoice) => {
      toast(`Facture ${invoice.number} émise`);
      refresh();
    },
    onError,
  });
  const remind = useMutation({
    mutationFn: (invoiceId: string) =>
      api<Invoice>(`/platform/billing/invoices/${invoiceId}/reminders`, { method: 'POST' }),
    onSuccess: () => {
      toast('Relance envoyée');
      refresh();
    },
    onError,
  });
  const dialogAction = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      api<Invoice>(path, { method: 'POST', body }),
    onSuccess: () => {
      toast('Enregistré');
      setDialog(null);
      refresh();
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : 'Erreur'),
  });
  const openDialog = (d: Dialog) => {
    setFormError(null);
    setDialog(d);
  };

  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <PlatformError error={q.error} onRetry={() => q.refetch()} />;
  const { school, plan, preview, invoices, warning } = q.data;
  const activePlans = plans.data?.filter((p) => p.active || p.id === plan?.id) ?? [];
  const hasOpenInvoice = invoices.some(
    (i) => i.period === preview.period && i.state !== 'CANCELLED',
  );

  return (
    <>
      <Link
        href="/plateforme/facturation"
        className="-mb-2 flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-primary"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Toutes les écoles
      </Link>
      <PageHeader
        title={school.name}
        subtitle={`${school.city} · ${plural(preview.studentCount, 'élève inscrit', 'élèves inscrits')} · ${plural(school.modules.length, 'module activé', 'modules activés')}`}
      />
      {warning ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-[14px] bg-warn-soft p-4 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
          <span>
            {warning.level === 'overdue' ? 'Facture en retard' : 'Facture en attente de règlement'}{' '}
            : reste à payer <strong className="tabular">{formatFcfa(warning.due)}</strong>. L’accès
            de l’école n’est pas coupé.
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <Card>
          <CardHeader
            title="Offre"
            subtitle={plan ? SUBSCRIPTION_PRICING_LABELS[plan.pricing] : 'Aucune offre choisie'}
          />
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const planId = String(new FormData(e.currentTarget).get('planId') ?? '');
              if (planId) assign.mutate(planId);
            }}
          >
            <SelectField
              label="Offre de l’établissement"
              name="planId"
              defaultValue={plan?.id ?? ''}
              key={plan?.id ?? 'aucune'}
              containerClassName="flex-1"
            >
              <option value="" disabled>
                Choisir une offre
              </option>
              {activePlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
            <Button type="submit" variant="secondary" loading={assign.isPending}>
              Appliquer
            </Button>
          </form>
          <p className="mt-3 text-[13px] text-muted">
            Modules activés :{' '}
            {school.modules.map((m) => SUBSCRIPTION_MODULE_LABELS[m as Module] ?? m).join(', ')}
          </p>
        </Card>

        <Card>
          <CardHeader
            title="Prochaine facture"
            subtitle={
              preview.period
                ? `Année scolaire ${preview.period}, calculée sur l’effectif actuel`
                : 'Aucune année scolaire en cours'
            }
          />
          {preview.total === null ? (
            <p className="text-sm text-muted">Choisissez une offre pour calculer la facture.</p>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                issue.mutate(String(new FormData(e.currentTarget).get('dueDate')));
              }}
            >
              <Lines lines={preview.lines} total={preview.total} />
              <InputField
                label="Date d’échéance"
                name="dueDate"
                type="date"
                required
                defaultValue={addDaysIso(todayIso(), 30)}
              />
              <Button type="submit" loading={issue.isPending} disabled={hasOpenInvoice}>
                Émettre la facture
              </Button>
              {hasOpenInvoice ? (
                <p className="text-[13px] text-muted">
                  Une facture est déjà émise pour {preview.period}. Annulez-la pour en émettre une
                  nouvelle.
                </p>
              ) : null}
            </form>
          )}
        </Card>
      </div>

      <h2 className="text-lg font-bold">Factures</h2>
      {invoices.length === 0 ? (
        <EmptyState title="Aucune facture émise" />
      ) : (
        <ul className="flex flex-col gap-3">
          {invoices.map((inv) => (
            <li key={inv.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <h3 className="font-bold tabular">{inv.number}</h3>
                    <span className="text-[13px] text-muted">
                      {inv.period} · {inv.planName} · échéance le {formatDate(inv.dueDate)}
                    </span>
                  </div>
                  <StateBadge state={inv.state} />
                </div>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div className="flex flex-col">
                    <dt className="text-[13px] text-muted">Montant</dt>
                    <dd className="font-semibold tabular">{formatFcfa(inv.amount)}</dd>
                  </div>
                  <div className="flex flex-col">
                    <dt className="text-[13px] text-muted">Réglé</dt>
                    <dd className="font-semibold tabular">{formatFcfa(inv.paid)}</dd>
                  </div>
                  <div className="flex flex-col">
                    <dt className="text-[13px] text-muted">Reste</dt>
                    <dd className={`font-semibold tabular ${inv.due > 0 ? 'text-danger' : ''}`}>
                      {formatFcfa(inv.due)}
                    </dd>
                  </div>
                </dl>
                <details className="text-sm">
                  <summary className="min-h-11 cursor-pointer content-center font-semibold text-primary">
                    Détail ({plural(inv.studentCount, 'élève', 'élèves')})
                  </summary>
                  <Lines lines={inv.lines} total={inv.amount} />
                </details>
                {inv.payments.length > 0 ? (
                  <ul className="flex flex-col text-sm" aria-label={`Règlements de ${inv.number}`}>
                    {inv.payments.map((p) => (
                      <li
                        key={p.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2"
                      >
                        <span className="w-24 text-muted tabular">{formatDate(p.paidOn)}</span>
                        <span className="flex-1">
                          {p.correctsId
                            ? 'Correction'
                            : (SUBSCRIPTION_PAYMENT_METHOD_LABELS[
                                p.method as keyof typeof SUBSCRIPTION_PAYMENT_METHOD_LABELS
                              ] ?? p.method)}
                          {p.reference ? (
                            <span className="text-muted"> · {p.reference}</span>
                          ) : null}
                          {p.note ? <span className="text-muted"> · {p.note}</span> : null}
                        </span>
                        <strong className={`tabular ${p.amount < 0 ? 'text-danger' : ''}`}>
                          {formatFcfa(p.amount)}
                        </strong>
                        {p.amount > 0 && !p.corrected && inv.state !== 'CANCELLED' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              openDialog({ kind: 'correct', invoice: inv, payment: p })
                            }
                          >
                            Corriger
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {inv.reminders > 0 && inv.lastReminderAt ? (
                  <p className="text-[13px] text-muted">
                    {plural(inv.reminders, 'relance', 'relances')}, la dernière le{' '}
                    {formatDateTime(inv.lastReminderAt)}
                  </p>
                ) : null}
                {inv.state === 'CANCELLED' ? (
                  <p className="text-[13px] text-muted">Annulée : {inv.cancelReason}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {inv.due > 0 ? (
                      <>
                        <Button size="sm" onClick={() => openDialog({ kind: 'pay', invoice: inv })}>
                          Enregistrer un règlement
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={remind.isPending && remind.variables === inv.id}
                          onClick={() => remind.mutate(inv.id)}
                        >
                          Relancer
                        </Button>
                      </>
                    ) : null}
                    {inv.paid === 0 ? (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => openDialog({ kind: 'cancel', invoice: inv })}
                      >
                        Annuler la facture
                      </Button>
                    ) : null}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog?.kind === 'pay'
            ? `Règlement de ${dialog.invoice.number}`
            : dialog?.kind === 'cancel'
              ? `Annuler ${dialog.invoice.number}`
              : 'Corriger un règlement'
        }
      >
        {dialog ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setFormError(null);
              const fd = new FormData(e.currentTarget);
              if (dialog.kind === 'pay')
                dialogAction.mutate({
                  path: `/platform/billing/invoices/${dialog.invoice.id}/payments`,
                  body: {
                    amount: Number(fd.get('amount')),
                    method: String(fd.get('method')),
                    reference: String(fd.get('reference') ?? '') || undefined,
                    paidOn: String(fd.get('paidOn')),
                    note: String(fd.get('note') ?? '') || undefined,
                  },
                });
              else
                dialogAction.mutate({
                  path:
                    dialog.kind === 'cancel'
                      ? `/platform/billing/invoices/${dialog.invoice.id}/cancel`
                      : `/platform/billing/payments/${dialog.payment.id}/correct`,
                  body: { reason: String(fd.get('reason') ?? '') },
                });
            }}
          >
            {dialog.kind === 'pay' ? (
              <>
                <InputField
                  label="Montant (FCFA)"
                  name="amount"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={dialog.invoice.due}
                  step={1}
                  required
                  defaultValue={dialog.invoice.due}
                  hint={`Reste à payer : ${formatFcfa(dialog.invoice.due)}`}
                />
                <SelectField label="Moyen de paiement" name="method" defaultValue="BANK_TRANSFER">
                  {Object.entries(SUBSCRIPTION_PAYMENT_METHOD_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </SelectField>
                <InputField label="Référence" name="reference" optional maxLength={80} />
                <InputField
                  label="Date du règlement"
                  name="paidOn"
                  type="date"
                  required
                  defaultValue={todayIso()}
                />
                <InputField label="Note" name="note" optional maxLength={300} />
              </>
            ) : (
              <>
                {dialog.kind === 'correct' ? (
                  <p className="text-sm">
                    Une écriture de {formatFcfa(-dialog.payment.amount)} annulera ce règlement ; le
                    règlement d’origine reste visible.
                  </p>
                ) : null}
                <TextareaField label="Motif" name="reason" required minLength={5} maxLength={300} />
              </>
            )}
            {formError ? (
              <p role="alert" className="text-sm font-medium text-danger">
                {formError}
              </p>
            ) : null}
            <Button
              type="submit"
              variant={dialog.kind === 'pay' ? 'primary' : 'danger'}
              loading={dialogAction.isPending}
            >
              {dialog.kind === 'pay'
                ? 'Enregistrer le règlement'
                : dialog.kind === 'cancel'
                  ? 'Annuler la facture'
                  : 'Corriger le règlement'}
            </Button>
          </form>
        ) : null}
      </Sheet>
    </>
  );
}
