'use client';

import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { useAccounts, type ExpenseView } from '@/lib/accounting';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatFcfa, formatShortDate, todayIso } from '@/lib/format';

const STATUS = {
  PENDING_APPROVAL: { tone: 'warn', label: 'À valider' },
  POSTED: { tone: 'success', label: 'Comptabilisée' },
  REJECTED: { tone: 'neutral', label: 'Rejetée' },
} as const;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Erreur');

export default function ExpensesPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [rejecting, setRejecting] = useState<ExpenseView | null>(null);
  const q = useQuery({
    queryKey: ['accounting', 'expenses', status],
    queryFn: () => api<ExpenseView[]>(`/accounting/expenses${status ? `?status=${status}` : ''}`),
  });
  const settings = useQuery({
    queryKey: ['accounting', 'settings'],
    queryFn: () => api<{ expenseApprovalThreshold: number }>('/accounting/settings'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['accounting'] });
  const approve = useMutation({
    mutationFn: (id: string) =>
      api<{ entries: string[] }>(`/accounting/expenses/${id}/approve`, { method: 'POST' }),
    onSuccess: (r) => {
      toast(`Dépense validée · écritures ${r.entries.join(', ')}`);
      void refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const reject = useMutation({
    mutationFn: (reason: string) =>
      api(`/accounting/expenses/${rejecting?.id}/reject`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      setRejecting(null);
      toast('Dépense rejetée');
      void refresh();
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const threshold = settings.data?.expenseApprovalThreshold;

  const actions = (e: ExpenseView) =>
    can('accounting.write') && e.status === 'PENDING_APPROVAL' ? (
      <div className="flex w-full gap-2 lg:w-auto lg:justify-end">
        {/* La validation revient à une autre personne que l'auteur de la saisie. */}
        {e.createdById !== me?.user.id ? (
          <Button
            size="sm"
            className="flex-1 lg:flex-none"
            loading={approve.isPending && approve.variables === e.id}
            onClick={() => approve.mutate(e.id)}
          >
            Valider
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="danger"
          className="flex-1 lg:flex-none"
          onClick={() => setRejecting(e)}
        >
          Rejeter
        </Button>
      </div>
    ) : null;

  return (
    <>
      <PageHeader
        title="Dépenses"
        subtitle={
          threshold !== undefined
            ? `Validation par une autre personne à partir de ${formatFcfa(threshold)}`
            : undefined
        }
        actions={
          can('accounting.write') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Nouvelle dépense
            </Button>
          ) : null
        }
      />
      <Card>
        <SelectField label="Statut" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Toutes les dépenses</option>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </SelectField>
      </Card>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Aucune dépense" />
      ) : (
        <>
          {/* Téléphone : cartes empilées. */}
          <ul className="flex flex-col gap-2 lg:hidden">
            {q.data.map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <strong className="[overflow-wrap:anywhere]">{e.label}</strong>
                    <span className="text-[13px] text-muted [overflow-wrap:anywhere]">
                      {e.supplier} · {formatShortDate(e.date)} · pièce {e.pieceRef}
                    </span>
                    <span className="text-[13px] text-muted">
                      Compte {e.accountNumber} · {PAYMENT_METHOD_LABELS[e.method]}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <strong className="tabular">{formatFcfa(e.amount)}</strong>
                    <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
                  </div>
                </div>
                {e.rejectedReason ? (
                  <p className="text-[13px] text-muted">Motif : {e.rejectedReason}</p>
                ) : null}
                {actions(e)}
              </li>
            ))}
          </ul>
          {/* Ordinateur : tableau. */}
          <Card className="hidden p-0 lg:block lg:p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Dépenses</caption>
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Date
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Dépense
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Compte · règlement
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    Montant
                  </th>
                  <th scope="col" className="py-2 pl-4 font-semibold">
                    Statut
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((e) => (
                  <tr key={e.id} className="border-t border-line align-top">
                    <td className="px-4 py-2.5 tabular">{formatShortDate(e.date)}</td>
                    <td className="py-2.5">
                      <span className="font-semibold">{e.label}</span>
                      <span className="block text-[13px] text-muted">
                        {e.supplier} · pièce {e.pieceRef}
                        {e.createdBy ? ` · saisie par ${e.createdBy}` : ''}
                      </span>
                      {e.rejectedReason ? (
                        <span className="block text-[13px] text-muted">
                          Motif : {e.rejectedReason}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2.5">
                      {e.accountNumber} · {PAYMENT_METHOD_LABELS[e.method]}
                    </td>
                    <td className="py-2.5 text-right font-semibold tabular">
                      {formatFcfa(e.amount)}
                    </td>
                    <td className="py-2.5 pl-4">
                      <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
                    </td>
                    <td className="px-4 py-2.5">{actions(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
      <ExpenseForm
        open={creating}
        threshold={threshold}
        onClose={() => setCreating(false)}
        onCreated={(r) => {
          setCreating(false);
          toast(
            r.status === 'POSTED'
              ? 'Dépense comptabilisée'
              : 'Dépense enregistrée : en attente de validation par une autre personne',
          );
          void refresh();
        }}
      />
      <Sheet open={!!rejecting} onClose={() => setRejecting(null)} title="Rejeter cette dépense ?">
        <form
          className="flex flex-col gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            reject.mutate(String(new FormData(ev.currentTarget).get('reason')));
          }}
        >
          <p className="text-sm text-muted">
            Aucune écriture n’est passée. La dépense reste visible avec son motif de rejet.
          </p>
          <InputField label="Motif du rejet" name="reason" required minLength={5} />
          <Button type="submit" variant="danger" loading={reject.isPending}>
            Rejeter la dépense
          </Button>
        </form>
      </Sheet>
    </>
  );
}

function ExpenseForm({
  open,
  threshold,
  onClose,
  onCreated,
}: {
  open: boolean;
  threshold: number | undefined;
  onClose: () => void;
  onCreated: (r: { status: ExpenseView['status'] }) => void;
}) {
  const toast = useToast();
  const accounts = useAccounts();
  const suppliers = useQuery({
    queryKey: ['accounting', 'suppliers'],
    queryFn: () => api<{ id: string; name: string }[]>('/accounting/suppliers'),
    enabled: open,
  });
  const charges = (accounts.data ?? []).filter((a) => a.class === 6 && a.postable);
  const create = useMutation({
    mutationFn: (body: unknown) =>
      api<{ status: ExpenseView['status'] }>('/accounting/expenses', { method: 'POST', body }),
    onSuccess: onCreated,
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <Sheet open={open} onClose={onClose} title="Nouvelle dépense">
      <form
        className="flex flex-col gap-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          const data = new FormData(ev.currentTarget);
          const name = String(data.get('supplier')).trim();
          const known = suppliers.data?.find((s) => s.name.toLowerCase() === name.toLowerCase());
          create.mutate({
            ...(known ? { supplierId: known.id } : { supplierName: name }),
            date: data.get('date'),
            label: data.get('label'),
            amount: Number(data.get('amount')),
            accountNumber: data.get('accountNumber'),
            method: data.get('method'),
            pieceRef: data.get('pieceRef'),
          });
        }}
      >
        <InputField
          label="Fournisseur"
          name="supplier"
          list="suppliers"
          required
          minLength={2}
          autoComplete="off"
          hint="Un nouveau fournisseur est créé s’il n’existe pas encore"
        />
        <datalist id="suppliers">
          {suppliers.data?.map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
        <InputField label="Objet" name="label" required minLength={2} maxLength={200} />
        <div className="grid grid-cols-2 gap-3">
          <InputField
            label="Montant (FCFA)"
            name="amount"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            required
          />
          <InputField label="Date" name="date" type="date" defaultValue={todayIso()} required />
        </div>
        <SelectField label="Compte de charge" name="accountNumber" required defaultValue="">
          <option value="" disabled>
            Choisir un compte
          </option>
          {charges.map((a) => (
            <option key={a.number} value={a.number}>
              {a.number} · {a.label}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Mode de règlement" name="method" defaultValue="CASH">
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </SelectField>
          <InputField label="Pièce de référence" name="pieceRef" required maxLength={60} />
        </div>
        {threshold !== undefined ? (
          <p className="text-[13px] text-muted">
            À partir de {formatFcfa(threshold)}, la dépense attend la validation d’une autre
            personne avant d’être comptabilisée.
          </p>
        ) : null}
        <Button type="submit" loading={create.isPending}>
          Enregistrer la dépense
        </Button>
      </form>
    </Sheet>
  );
}
