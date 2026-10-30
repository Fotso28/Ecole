'use client';

import {
  CONTRACT_TYPE_LABELS,
  formatFcfa,
  formatPayrollMonth,
  PAY_ELEMENT_KINDS,
  PAY_ELEMENT_LABELS,
  PAYROLL_STATUS_LABELS,
  type PayElement,
  type PayElementKind,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  Calculator,
  FileDown,
  Printer,
  Scale,
  Send,
  ShieldCheck,
  SquarePen,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { PayoutSheet, payoutSummary } from '@/components/hr-payout';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, ErrorBlock, LoadingBlock, PageHeader, Stat } from '@/components/ui/card';
import { Checkbox, InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, downloadFile, openPdf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { currentMonth, monthOptions, type PayrollRunView, type PayslipView } from '@/lib/hr';

const STATUS_TONE = { DRAFT: 'neutral', PREPARED: 'warn', VALIDATED: 'success' } as const;

function ElementsSheet({
  month,
  slip,
  onClose,
}: {
  month: string;
  slip: PayslipView | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [elements, setElements] = useState<PayElement[]>([]);
  const [absenceDays, setAbsenceDays] = useState(0);
  const [kind, setKind] = useState<PayElementKind>('BONUS');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [taxable, setTaxable] = useState(true);
  useEffect(() => {
    if (slip) {
      setElements(slip.elements);
      setAbsenceDays(slip.absenceDays);
      setLabel('');
      setAmount('');
    }
  }, [slip]);
  const save = useMutation({
    mutationFn: () =>
      api(`/hr/payroll/${month}/payslips/${slip?.id}`, {
        method: 'PUT',
        body: { elements, absenceDays },
      }),
    onSuccess: () => {
      toast('Bulletin recalculé');
      void queryClient.invalidateQueries({ queryKey: ['hr', 'payroll'] });
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const parsedAmount = Number(amount);
  const canAdd =
    label.trim().length > 0 &&
    Number.isInteger(parsedAmount) &&
    parsedAmount !== 0 &&
    (kind === 'RECALL' || parsedAmount > 0);
  return (
    <Sheet
      open={!!slip}
      onClose={onClose}
      title={slip ? `Éléments de ${slip.lastName} ${slip.firstName}` : 'Éléments'}
      footer={
        <Button block onClick={() => save.mutate()} loading={save.isPending}>
          Enregistrer et recalculer
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {elements.length ? (
          <ul className="flex flex-col gap-2" aria-label="Éléments du bulletin">
            {elements.map((e, i) => (
              <li
                key={`${e.label}-${i}`}
                className="flex items-center justify-between gap-2 rounded-[10px] border border-line p-2 pl-3 text-sm"
              >
                <span className="min-w-0">
                  <strong>{PAY_ELEMENT_LABELS[e.kind]}</strong> · {e.label}
                  {e.taxable ? '' : ' (non imposable)'} ·{' '}
                  <span className="tabular">{formatFcfa(e.amount)}</span>
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Retirer ${e.label}`}
                  onClick={() => setElements(elements.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Aucune prime, indemnité ni rappel.</p>
        )}
        <fieldset className="flex flex-col gap-3 rounded-[12px] border border-line p-3">
          <legend className="px-1 text-sm font-semibold">Ajouter un élément</legend>
          <SelectField
            label="Type"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as PayElementKind;
              setKind(k);
              setTaxable(k !== 'ALLOWANCE');
            }}
          >
            {PAY_ELEMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {PAY_ELEMENT_LABELS[k]}
              </option>
            ))}
          </SelectField>
          <InputField
            label="Libellé"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
            hint={
              kind === 'RECALL'
                ? 'Correction d’un mois validé, par exemple « Rappel octobre 2026 ».'
                : undefined
            }
          />
          <InputField
            label="Montant (FCFA)"
            type="number"
            inputMode="numeric"
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint={kind === 'RECALL' ? 'Négatif pour reprendre un trop-perçu.' : undefined}
          />
          <Checkbox
            label="Soumis aux cotisations et à l’impôt"
            checked={taxable}
            onChange={(e) => setTaxable(e.target.checked)}
          />
          <Button
            variant="secondary"
            disabled={!canAdd}
            onClick={() => {
              setElements([
                ...elements,
                { kind, label: label.trim(), amount: parsedAmount, taxable },
              ]);
              setLabel('');
              setAmount('');
            }}
          >
            Ajouter l’élément
          </Button>
        </fieldset>
        {slip?.contractType !== 'HOURLY' ? (
          <InputField
            label="Jours d’absence non justifiée (hors cours)"
            type="number"
            inputMode="numeric"
            min={0}
            max={31}
            value={absenceDays}
            onChange={(e) => setAbsenceDays(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
            hint="Retenue de 1/30 du salaire par jour. Les cours manqués sont déjà retenus d’après les heures."
          />
        ) : null}
      </div>
    </Sheet>
  );
}

function Amounts({ slip }: { slip: PayslipView }) {
  const r = slip.result;
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted">Brut</dt>
      <dd className="text-right tabular">{formatFcfa(r.gross)}</dd>
      <dt className="text-muted">Cotisations et impôts</dt>
      <dd className="text-right tabular">− {formatFcfa(r.employee.total)}</dd>
      {r.advanceDeduction ? (
        <>
          <dt className="text-muted">Avance</dt>
          <dd className="text-right tabular">− {formatFcfa(r.advanceDeduction)}</dd>
        </>
      ) : null}
      <dt className="font-semibold">Net à payer</dt>
      <dd className="text-right font-bold tabular">{formatFcfa(r.net)}</dd>
    </dl>
  );
}

/** Transition de la paie du mois (calcul, soumission, validation, renvoi). */
function useRunAction(
  month: string,
  path: string,
  success: string,
  onDone: () => void,
  body?: () => unknown,
) {
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/hr/payroll/${month}/${path}`, { method: 'POST', body: body?.() }),
    onSuccess: () => {
      toast(success);
      onDone();
      void queryClient.invalidateQueries({ queryKey: ['hr'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
}

export default function PayrollPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const [month, setMonth] = useState(currentMonth());
  const [editing, setEditing] = useState<PayslipView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const q = useQuery({
    queryKey: ['hr', 'payroll', month],
    queryFn: () => api<PayrollRunView>(`/hr/payroll/${month}`),
  });
  const onError = (e: unknown) => toast(e instanceof Error ? e.message : 'Erreur', 'error');
  const done = () => {
    setConfirming(false);
    setRejecting(false);
  };
  const compute = useRunAction(month, 'compute', 'Paie calculée', done);
  const submit = useRunAction(month, 'submit', 'Paie soumise à la direction', done);
  const validate = useRunAction(
    month,
    'validate',
    'Paie validée : bulletins et état des virements disponibles',
    done,
  );
  const reject = useRunAction(month, 'reject', 'Paie renvoyée à la comptabilité', done, () => ({
    reason: rejectReason,
  }));

  const run = q.data;
  const status = run?.status ?? null;
  const isPreparer =
    !!run && (run.preparedById === me?.user.id || run.computedById === me?.user.id);
  const download = (format: 'csv' | 'xlsx') =>
    downloadFile(
      `/hr/payroll/${month}/transfers?format=${format}`,
      `virements-${month}.${format}`,
    ).catch(onError);
  const printAll = () => openPdf(`/hr/payroll/${month}/payslips.pdf`).catch(onError);
  const printOne = (slip: PayslipView) =>
    openPdf(`/hr/payroll/${month}/payslips/${slip.id}/pdf`).catch(onError);

  const slipActions = (slip: PayslipView) => (
    <div className="flex flex-wrap gap-2">
      {status === 'DRAFT' && can('hr.payroll.prepare') ? (
        <Button size="sm" variant="secondary" onClick={() => setEditing(slip)}>
          <SquarePen className="size-4" aria-hidden />
          Éléments
          <span className="sr-only">
            {' '}
            de {slip.lastName} {slip.firstName}
          </span>
        </Button>
      ) : null}
      {status === 'VALIDATED' ? (
        <Button size="sm" variant="secondary" onClick={() => printOne(slip)}>
          <Printer className="size-4" aria-hidden />
          Bulletin
          <span className="sr-only">
            {' '}
            de {slip.lastName} {slip.firstName}
          </span>
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Paie"
        subtitle="La comptabilité prépare la paie du mois, la direction la valide. Une paie validée est figée ; une correction passe par un rappel le mois suivant."
        actions={
          <ButtonLink href="/rh/baremes" variant="secondary">
            <Scale className="size-4" aria-hidden />
            Barèmes
          </ButtonLink>
        }
      />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_1fr] sm:items-end">
        <SelectField label="Mois de paie" value={month} onChange={(e) => setMonth(e.target.value)}>
          {monthOptions().map((m) => (
            <option key={m} value={m}>
              {formatPayrollMonth(m)}
            </option>
          ))}
        </SelectField>
        <div className="flex flex-wrap gap-2">
          {(status === null || status === 'DRAFT') && can('hr.payroll.prepare') ? (
            <Button
              variant={status === null ? 'primary' : 'secondary'}
              onClick={() => compute.mutate()}
              loading={compute.isPending}
            >
              <Calculator className="size-4" aria-hidden />
              {status === null ? 'Calculer la paie' : 'Recalculer'}
            </Button>
          ) : null}
          {status === 'DRAFT' && can('hr.payroll.prepare') && run?.payslips.length ? (
            <Button onClick={() => submit.mutate()} loading={submit.isPending}>
              <Send className="size-4" aria-hidden />
              Soumettre à la direction
            </Button>
          ) : null}
          {status === 'PREPARED' && can('hr.payroll.validate') && !isPreparer ? (
            <>
              <Button onClick={() => setConfirming(true)}>
                <ShieldCheck className="size-4" aria-hidden />
                Valider la paie
              </Button>
              <Button variant="secondary" onClick={() => setRejecting(true)}>
                <Undo2 className="size-4" aria-hidden />
                Renvoyer
              </Button>
            </>
          ) : null}
          {status === 'VALIDATED' && !run?.payout && can('hr.payroll.pay') ? (
            <Button onClick={() => setPaying(true)}>
              <Banknote className="size-4" aria-hidden />
              Marquer comme versée
            </Button>
          ) : null}
          {status === 'VALIDATED' ? (
            <>
              <Button variant="secondary" onClick={printAll}>
                <Printer className="size-4" aria-hidden />
                Bulletins PDF
              </Button>
              {can('hr.payroll.prepare') ? (
                <>
                  <Button variant="secondary" onClick={() => download('xlsx')}>
                    <FileDown className="size-4" aria-hidden />
                    Virements (Excel)
                  </Button>
                  <Button variant="secondary" onClick={() => download('csv')}>
                    <FileDown className="size-4" aria-hidden />
                    Virements (CSV)
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <Card className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold">Paie de {formatPayrollMonth(month)}</h2>
              {status ? (
                <Badge tone={STATUS_TONE[status]}>{PAYROLL_STATUS_LABELS[status]}</Badge>
              ) : (
                <Badge tone="neutral">Non calculée</Badge>
              )}
              {status === 'VALIDATED' ? (
                run?.payout ? (
                  <Badge tone="success">Versée</Badge>
                ) : (
                  <Badge tone="warn">À verser</Badge>
                )
              ) : null}
            </div>
            {run?.computedAt ? (
              <p className="text-muted">
                Calculée le {formatDateTime(run.computedAt)} par {run.computedBy}
                {run.preparedAt
                  ? ` · soumise le ${formatDateTime(run.preparedAt)} par ${run.preparedBy}`
                  : ''}
                {run.validatedAt
                  ? ` · validée le ${formatDateTime(run.validatedAt)} par ${run.validatedBy}`
                  : ''}
              </p>
            ) : null}
            {status === 'PREPARED' && isPreparer ? (
              <p className="text-muted">
                En attente de validation par une autre personne de la direction.
              </p>
            ) : null}
            {status === 'DRAFT' && run?.rejectReason ? (
              <p role="status" className="rounded-[10px] bg-danger-soft p-3 text-danger">
                Renvoyée par {run.rejectedBy} : {run.rejectReason}
              </p>
            ) : null}
            {run?.payout ? (
              <p className="font-medium">
                {payoutSummary(run.payout)}
                {run.payout.sameAsValidator
                  ? ' · enregistré par la personne qui a validé (aucune autre personne habilitée)'
                  : ''}
              </p>
            ) : null}
            {status === 'VALIDATED' && !run?.payout ? (
              <p className="text-muted">
                Aucun virement n’est envoyé par Ecole : exportez l’état des virements et exécutez-le
                auprès de la banque ou de l’opérateur.
              </p>
            ) : null}
            {run?.scale ? (
              <p className={run.scale.toVerify ? 'font-medium text-warn' : 'text-muted'}>
                Barème : {run.scale.label}
                {run.scale.toVerify && !run.scale.label.includes('vérifier')
                  ? ' · taux à vérifier par un comptable'
                  : ''}
              </p>
            ) : null}
          </Card>

          {run?.totals ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Bulletins" value={run.totals.headcount} />
              <Stat label="Masse salariale brute" value={formatFcfa(run.totals.gross)} />
              <Stat label="Net à payer" value={formatFcfa(run.totals.net)} />
              <Stat label="Coût employeur" value={formatFcfa(run.totals.employerCost)} />
            </div>
          ) : null}

          {run && run.payslips.length > 0 ? (
            <>
              <ul className="flex flex-col gap-2 md:hidden" aria-label="Bulletins de paie">
                {run.payslips.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-col">
                        <strong className="truncate">
                          {p.lastName} {p.firstName}
                        </strong>
                        <span className="text-[13px] text-muted">
                          {p.position} · {CONTRACT_TYPE_LABELS[p.contractType]}
                        </span>
                      </div>
                      {p.number ? <Badge tone="info">{p.number}</Badge> : null}
                    </div>
                    <Amounts slip={p} />
                    {slipActions(p)}
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto rounded-[14px] border border-line bg-white md:block">
                <table className="w-full min-w-[820px] text-sm">
                  <caption className="sr-only">
                    Bulletins de paie de {formatPayrollMonth(month)}
                  </caption>
                  <thead className="bg-paper text-left text-xs tracking-[0.06em] text-muted uppercase">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Nom</th>
                      <th className="px-3 py-3 text-right font-semibold">Brut</th>
                      <th className="px-3 py-3 text-right font-semibold">Retenues</th>
                      <th className="px-3 py-3 text-right font-semibold">Avance</th>
                      <th className="px-3 py-3 text-right font-semibold">Net à payer</th>
                      <th className="px-4 py-3 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.payslips.map((p) => (
                      <tr key={p.id} className="border-t border-line align-top">
                        <td className="px-4 py-2.5">
                          <div className="flex flex-col">
                            <strong>
                              {p.lastName} {p.firstName}
                            </strong>
                            <span className="text-xs text-muted">
                              {p.position} · {CONTRACT_TYPE_LABELS[p.contractType]}
                              {p.number ? ` · ${p.number}` : ''}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular">
                          {formatFcfa(p.result.gross)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular">
                          {formatFcfa(p.result.employee.total)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular">
                          {formatFcfa(p.result.advanceDeduction)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-bold tabular">
                          {formatFcfa(p.result.net)}
                        </td>
                        <td className="px-4 py-2.5">{slipActions(p)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : status !== null ? (
            <p className="text-sm text-muted">
              Aucun bulletin : vérifiez que les dossiers ont un contrat couvrant ce mois.
            </p>
          ) : null}
        </>
      )}

      <ElementsSheet month={month} slip={editing} onClose={() => setEditing(null)} />
      <PayoutSheet
        open={paying}
        onClose={() => setPaying(false)}
        title="Marquer la paie comme versée"
        path={`/hr/payroll/${month}/pay`}
        amount={run?.totals?.net ?? 0}
        debitAccount="422 (rémunérations dues)"
        success="Paie marquée comme versée"
        intro={`Salaires de ${formatPayrollMonth(month)} exécutés auprès de la banque, en caisse ou par Mobile Money.`}
      />
      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Valider la paie"
        footer={
          <Button block onClick={() => validate.mutate()} loading={validate.isPending}>
            Je valide la paie de {formatPayrollMonth(month)}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>
            {run?.totals?.headcount} bulletins pour un net à payer de{' '}
            <strong className="tabular">{formatFcfa(run?.totals?.net ?? 0)}</strong>.
          </p>
          <p>
            Après validation, la paie est figée : les bulletins sont numérotés, les avances retenues
            sont enregistrées et toute correction passera par un rappel le mois suivant. Aucun
            virement n’est envoyé automatiquement.
          </p>
        </div>
      </Sheet>
      <Sheet
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Renvoyer la paie"
        footer={
          <Button
            block
            variant="danger"
            disabled={!rejectReason.trim()}
            onClick={() => reject.mutate()}
            loading={reject.isPending}
          >
            Renvoyer à la comptabilité
          </Button>
        }
      >
        <TextareaField
          label="Motif du renvoi"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          maxLength={500}
        />
      </Sheet>
    </>
  );
}
