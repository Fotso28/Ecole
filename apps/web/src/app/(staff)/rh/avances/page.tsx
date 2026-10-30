'use client';

import { formatFcfa, formatPayrollMonth } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  ADVANCE_STATUS,
  currentMonth,
  monthOptions,
  type AdvanceRow,
  type EmployeeRow,
} from '@/lib/hr';

function RequestSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const employees = useQuery({
    queryKey: ['hr', 'employees'],
    queryFn: () => api<EmployeeRow[]>('/hr/employees'),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/hr/advances', { method: 'POST', body }),
    onSuccess: () => {
      toast('Demande enregistrée. La direction doit l’accorder.');
      void queryClient.invalidateQueries({ queryKey: ['hr'] });
      setErrors({});
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length)
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  const months = monthOptions().slice(0, 3).reverse();
  return (
    <Sheet open={open} onClose={onClose} title="Demande d’avance sur salaire">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          create.mutate({
            employeeId: fd.get('employeeId'),
            amount: Number(fd.get('amount')),
            installments: Number(fd.get('installments')),
            firstMonth: fd.get('firstMonth'),
            reason: fd.get('reason'),
          });
        }}
      >
        <SelectField label="Bénéficiaire" name="employeeId" required error={errors.employeeId}>
          <option value="">Choisir…</option>
          {(employees.data ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.lastName} {e.firstName} · {e.position}
            </option>
          ))}
        </SelectField>
        <InputField
          label="Montant (FCFA)"
          name="amount"
          type="number"
          inputMode="numeric"
          min={1}
          required
          error={errors.amount}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Nombre de mensualités" name="installments" defaultValue="1">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectField>
          <SelectField label="Première retenue" name="firstMonth" defaultValue={currentMonth()}>
            {months.map((m) => (
              <option key={m} value={m}>
                {formatPayrollMonth(m)}
              </option>
            ))}
          </SelectField>
        </div>
        <InputField label="Motif" name="reason" required maxLength={300} error={errors.reason} />
        <p className="text-[13px] text-muted">
          Une fois accordée par la direction, l’avance est retenue automatiquement sur les paies
          suivantes, sans jamais rendre le net négatif.
        </p>
        <Button type="submit" loading={create.isPending}>
          Enregistrer la demande
        </Button>
      </form>
    </Sheet>
  );
}

export default function AdvancesPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['hr', 'advances'],
    queryFn: () => api<AdvanceRow[]>('/hr/advances'),
  });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      api(`/hr/advances/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: {} }),
    onSuccess: (_, v) => {
      toast(v.approve ? 'Avance accordée' : 'Avance refusée');
      void queryClient.invalidateQueries({ queryKey: ['hr'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  return (
    <>
      <PageHeader
        title="Avances sur salaire"
        subtitle="La comptabilité enregistre la demande, la direction l’accorde, puis elle est retenue sur les paies suivantes."
        actions={
          can('hr.payroll.prepare') ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Nouvelle demande
            </Button>
          ) : undefined
        }
      />
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Aucune avance">Les demandes d’avance apparaîtront ici.</EmptyState>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2" aria-label="Avances sur salaire">
          {q.data.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3 lg:p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <strong className="min-w-0 truncate">
                  {a.lastName} {a.firstName}
                </strong>
                <Badge tone={ADVANCE_STATUS[a.status].tone}>{ADVANCE_STATUS[a.status].label}</Badge>
              </div>
              <p className="text-sm">
                <span className="font-semibold tabular">{formatFcfa(a.amount)}</span> en{' '}
                {a.installments} mensualité{a.installments > 1 ? 's' : ''} de{' '}
                <span className="tabular">{formatFcfa(a.monthly)}</span> dès{' '}
                {formatPayrollMonth(a.firstMonth)}
              </p>
              <p className="text-[13px] text-muted">
                {a.reason}
                {a.status !== 'REQUESTED' && a.status !== 'REJECTED'
                  ? ` · remboursé ${formatFcfa(a.repaid)}, reste ${formatFcfa(a.remaining)}`
                  : ''}
              </p>
              {a.status === 'REQUESTED' &&
              can('hr.payroll.validate') &&
              a.requestedById !== me?.user.id ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => decide.mutate({ id: a.id, approve: true })}
                    loading={decide.isPending && decide.variables?.id === a.id}
                  >
                    <Check className="size-4" aria-hidden />
                    Accorder<span className="sr-only"> l’avance de {a.lastName}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => decide.mutate({ id: a.id, approve: false })}
                  >
                    <X className="size-4" aria-hidden />
                    Refuser<span className="sr-only"> l’avance de {a.lastName}</span>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <RequestSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
