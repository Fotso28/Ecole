'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Stat,
} from '@/components/ui/card';
import { InputField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { useFiscalYears, type AccountingOverview, type FiscalYearView } from '@/lib/accounting';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatFcfa, formatShortDate, plural, todayIso } from '@/lib/format';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Erreur');

export default function AccountingPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [openYear, setOpenYear] = useState(false);
  const [closing, setClosing] = useState<FiscalYearView | null>(null);
  const q = useQuery({
    queryKey: ['accounting', 'overview'],
    queryFn: () => api<AccountingOverview>('/accounting/overview'),
  });
  const years = useFiscalYears();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['accounting'] });

  const sync = useMutation({
    mutationFn: () =>
      api<{ posted: number; pending: number; failed: number }>('/accounting/sync', {
        method: 'POST',
      }),
    onSuccess: (r) => {
      toast(
        r.posted > 0
          ? `${plural(r.posted, 'écriture passée', 'écritures passées')} depuis la scolarité`
          : 'Comptabilité à jour avec la scolarité',
      );
      void refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const createYear = useMutation({
    mutationFn: (body: { name?: string; startDate: string; endDate: string }) =>
      api<FiscalYearView>('/accounting/fiscal-years', { method: 'POST', body }),
    onSuccess: (y) => {
      setOpenYear(false);
      toast(`${y.name} ouvert`);
      void refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const closeYear = useMutation({
    mutationFn: (id: string) =>
      api<{ name: string; carryForward: string | null }>(`/accounting/fiscal-years/${id}/close`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      setClosing(null);
      toast(`${r.name} clôturé${r.carryForward ? ` · report à nouveau ${r.carryForward}` : ''}`);
      void refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const saveThreshold = useMutation({
    mutationFn: (expenseApprovalThreshold: number) =>
      api('/accounting/settings', { method: 'PUT', body: { expenseApprovalThreshold } }),
    onSuccess: () => {
      toast('Seuil de validation enregistré');
      void refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  const o = q.data;
  const cash = o?.treasury.reduce((s, t) => s + t.balance, 0) ?? 0;
  const today = todayIso();

  return (
    <>
      <PageHeader
        title="Comptabilité"
        subtitle={
          o?.fiscalYear
            ? `${o.fiscalYear.name} · du ${formatShortDate(o.fiscalYear.startDate)} au ${formatShortDate(o.fiscalYear.endDate)}`
            : 'SYSCOHADA révisé'
        }
        actions={
          can('accounting.write') ? (
            <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate()}>
              <RefreshCw className="size-4" aria-hidden />
              Synchroniser la scolarité
            </Button>
          ) : null
        }
      />
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Résultat de l’exercice"
              value={formatFcfa(o!.result)}
              tone={o!.result < 0 ? 'danger' : 'default'}
              hint={`Produits ${formatFcfa(o!.products)}`}
            />
            <Stat label="Trésorerie" value={formatFcfa(cash)} hint="Caisse, banque, Mobile Money" />
            <Stat
              label="Dû par les familles"
              value={formatFcfa(o!.receivables)}
              hint="Compte 4111"
            />
            <Stat
              label="En attente"
              value={
                o!.pendingTuition + o!.pendingOperations + o!.pendingExpenses + o!.pendingEntries
              }
              hint={`${plural(o!.pendingTuition, 'opération', 'opérations')} de scolarité, ${plural(o!.pendingOperations, 'opération', 'opérations')} de paie ou de stock, ${plural(o!.pendingExpenses + o!.pendingEntries, 'dépense ou écriture', 'dépenses ou écritures')} à valider`}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Trésorerie"
                action={
                  <ButtonLink href="/comptabilite/etats" variant="ghost" size="sm">
                    États financiers
                  </ButtonLink>
                }
              />
              <ul className="flex flex-col divide-y divide-line">
                {o!.treasury.map((t) => (
                  <li
                    key={t.accountNumber}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="font-semibold">{t.label}</span>{' '}
                      <span className="text-[13px] text-muted tabular">{t.accountNumber}</span>
                    </span>
                    <strong className="shrink-0 tabular">{formatFcfa(t.balance)}</strong>
                  </li>
                ))}
              </ul>
            </Card>
            <ThresholdCard
              value={o!.expenseApprovalThreshold}
              editable={can('settings.write')}
              saving={saveThreshold.isPending}
              onSave={(v) => saveThreshold.mutate(v)}
            />
          </div>
        </>
      )}
      <Card>
        <CardHeader
          title="Exercices comptables"
          subtitle="Une clôture est définitive : plus aucune écriture sur la période, soldes reportés à nouveau."
          action={
            can('accounting.close') ? (
              <Button size="sm" variant="secondary" onClick={() => setOpenYear(true)}>
                Ouvrir un exercice
              </Button>
            ) : null
          }
        />
        {years.isPending ? (
          <LoadingBlock />
        ) : years.isError ? (
          <ErrorBlock error={years.error} onRetry={() => years.refetch()} />
        ) : years.data.length === 0 ? (
          <EmptyState title="Aucun exercice">
            Le premier exercice s’ouvre automatiquement avec la première écriture.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {years.data.map((y) => (
              <li
                key={y.id}
                className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line p-3"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <strong>{y.name}</strong>
                  <span className="text-[13px] text-muted">
                    Du {formatShortDate(y.startDate)} au {formatShortDate(y.endDate)} ·{' '}
                    {plural(y.entries ?? 0, 'écriture', 'écritures')}
                  </span>
                </div>
                {y.status === 'OPEN' ? (
                  <Badge tone="success">Ouvert</Badge>
                ) : (
                  <Badge tone="neutral">Clôturé</Badge>
                )}
                {can('accounting.close') && y.status === 'OPEN' && y.endDate < today ? (
                  <Button
                    size="sm"
                    variant="danger"
                    className="w-full sm:w-auto"
                    onClick={() => setClosing(y)}
                  >
                    Clôturer
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Sheet open={openYear} onClose={() => setOpenYear(false)} title="Ouvrir un exercice">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const name = String(data.get('name') ?? '').trim();
            createYear.mutate({
              ...(name ? { name } : {}),
              startDate: String(data.get('startDate')),
              endDate: String(data.get('endDate')),
            });
          }}
        >
          <InputField
            label="Nom"
            name="name"
            optional
            hint="Par défaut : « Exercice » suivi de l’année de début"
          />
          <div className="grid grid-cols-2 gap-3">
            <InputField label="Début" name="startDate" type="date" required />
            <InputField label="Fin" name="endDate" type="date" required />
          </div>
          <Button type="submit" loading={createYear.isPending}>
            Ouvrir l’exercice
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={!!closing}
        onClose={() => setClosing(null)}
        title={closing ? `Clôturer ${closing.name} ?` : 'Clôturer'}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Plus aucune écriture ne pourra être passée sur cette période. Les soldes des comptes de
            bilan et le résultat seront repris en à-nouveaux à l’ouverture de l’exercice suivant.
            Cette opération est définitive.
          </p>
          <Button
            variant="danger"
            loading={closeYear.isPending}
            onClick={() => closing && closeYear.mutate(closing.id)}
          >
            Clôturer définitivement
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function ThresholdCard({
  value,
  editable,
  saving,
  onSave,
}: {
  value: number;
  editable: boolean;
  saving: boolean;
  onSave: (v: number) => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Validation des dépenses"
        subtitle="À partir de ce montant, une autre personne que l’auteur valide la dépense."
      />
      {editable ? (
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(Number(new FormData(e.currentTarget).get('threshold')));
          }}
        >
          <InputField
            key={value}
            label="Seuil (FCFA)"
            name="threshold"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            defaultValue={value}
            required
            containerClassName="flex-1"
          />
          <Button type="submit" variant="secondary" loading={saving}>
            Enregistrer
          </Button>
        </form>
      ) : (
        <p className="font-display text-2xl font-bold tabular">{formatFcfa(value)}</p>
      )}
    </Card>
  );
}
