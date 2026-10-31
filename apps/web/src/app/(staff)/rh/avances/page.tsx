'use client';

import {
  advanceInstallment,
  advanceShareTooHigh,
  formatFcfa,
  formatPayrollMonth,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Check, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { PayoutSheet, payoutSummary } from '@/components/hr-payout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ADVANCE_STATUS, nextMonths, type AdvanceRow, type EmployeeRow } from '@/lib/hr';

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
  // Première retenue : le mois en cours ou un mois à venir, jamais un mois passé.
  const months = nextMonths(3);
  const [employeeId, setEmployeeId] = useState('');
  const [amount, setAmount] = useState('');
  const [installments, setInstallments] = useState('1');
  const employee = employees.data?.find((e) => e.id === employeeId);
  const baseSalary =
    employee?.contract && employee.contract.type !== 'HOURLY' ? employee.contract.baseSalary : null;
  const monthly =
    Number(amount) > 0 && Number.isSafeInteger(Number(amount))
      ? advanceInstallment(Number(amount), Number(installments), 0)
      : 0;
  const tooHigh = monthly > 0 && advanceShareTooHigh(monthly, baseSalary);
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
        <SelectField
          label="Bénéficiaire"
          name="employeeId"
          required
          error={errors.employeeId}
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
        >
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
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Nombre de mensualités"
            name="installments"
            value={installments}
            onChange={(e) => setInstallments(e.target.value)}
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectField>
          <SelectField label="Première retenue" name="firstMonth" defaultValue={months[0]}>
            {months.map((m) => (
              <option key={m} value={m}>
                {formatPayrollMonth(m)}
              </option>
            ))}
          </SelectField>
        </div>
        {tooHigh && baseSalary ? (
          <p role="alert" className="rounded-[10px] bg-warn-soft p-3 text-sm">
            <strong>Retenue élevée :</strong> {formatFcfa(monthly)} par mois, soit plus du tiers du
            salaire de base ({formatFcfa(baseSalary)}). Augmentez le nombre de mensualités ou
            réduisez le montant ; sinon, la direction l’accordera en connaissance de cause.
          </p>
        ) : null}
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
  const [paying, setPaying] = useState<AdvanceRow | null>(null);
  const q = useQuery({
    queryKey: ['hr', 'advances'],
    queryFn: () => api<AdvanceRow[]>('/hr/advances'),
  });
  const [rejecting, setRejecting] = useState<AdvanceRow | null>(null);
  const decide = useMutation({
    mutationFn: ({ id, approve, reason }: { id: string; approve: boolean; reason?: string }) =>
      api(`/hr/advances/${id}/${approve ? 'approve' : 'reject'}`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
    onSuccess: (_, v) => {
      toast(v.approve ? 'Avance accordée' : 'Avance refusée');
      setRejecting(null);
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
              {a.shareAlert && a.status === 'REQUESTED' ? (
                <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[13px]">
                  Retenue de {formatFcfa(a.monthly)} par mois : plus du tiers du salaire de base
                  {a.baseSalary ? ` (${formatFcfa(a.baseSalary)})` : ''}.
                </p>
              ) : null}
              {a.status === 'REJECTED' && a.decisionNote ? (
                <p className="text-[13px]">Motif du refus : {a.decisionNote}</p>
              ) : null}
              <p className="text-[13px] text-muted">
                {a.reason}
                {a.status !== 'REQUESTED' && a.status !== 'REJECTED'
                  ? ` · remboursé ${formatFcfa(a.repaid)}, reste ${formatFcfa(a.remaining)}`
                  : ''}
              </p>
              {a.payout ? (
                <p className="text-[13px] font-medium">{payoutSummary(a.payout)}</p>
              ) : a.status === 'APPROVED' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warn">À verser</Badge>
                  {can('hr.payroll.pay') ? (
                    <Button size="sm" variant="secondary" onClick={() => setPaying(a)}>
                      <Banknote className="size-4" aria-hidden />
                      Verser<span className="sr-only"> l’avance de {a.lastName}</span>
                    </Button>
                  ) : null}
                </div>
              ) : null}
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
                  <Button size="sm" variant="danger" onClick={() => setRejecting(a)}>
                    <X className="size-4" aria-hidden />
                    Refuser<span className="sr-only"> l’avance de {a.lastName}</span>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <RequestSheet key={open ? 'ouvert' : 'ferme'} open={open} onClose={() => setOpen(false)} />
      <Sheet open={!!rejecting} onClose={() => setRejecting(null)} title="Refuser cette avance ?">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!rejecting) return;
            decide.mutate({
              id: rejecting.id,
              approve: false,
              reason: String(new FormData(e.currentTarget).get('reason') ?? ''),
            });
          }}
        >
          <p className="text-sm text-muted">
            Avance de {rejecting ? formatFcfa(rejecting.amount) : ''} demandée pour{' '}
            {rejecting?.lastName} {rejecting?.firstName}. Le motif est conservé et communiqué à la
            comptabilité.
          </p>
          <InputField label="Motif du refus" name="reason" required minLength={5} maxLength={300} />
          <Button type="submit" variant="danger" loading={decide.isPending}>
            Refuser l’avance
          </Button>
        </form>
      </Sheet>
      <PayoutSheet
        open={!!paying}
        onClose={() => setPaying(null)}
        title="Versement de l’avance"
        path={`/hr/advances/${paying?.id ?? ''}/pay`}
        amount={paying?.amount ?? 0}
        debitAccount="421 (avances au personnel)"
        success="Avance versée"
        intro={`Avance de ${paying?.lastName ?? ''} ${paying?.firstName ?? ''}, remboursée ensuite par retenue sur les paies.`}
      />
    </>
  );
}
