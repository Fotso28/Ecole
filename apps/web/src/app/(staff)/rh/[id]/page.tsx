'use client';

import {
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPES,
  formatFcfa,
  formatPayrollMonth,
  PAYOUT_METHOD_LABELS,
  ROLE_LABELS,
  type ContractType,
  type EmployeeSensitive,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, Eye, FilePlus2, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ContractBadge, contractSummary } from '@/components/hr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatShortDate, todayIso } from '@/lib/format';
import { ADVANCE_STATUS, type EmployeeDetail, type MaskedPayout } from '@/lib/hr';

const SENSITIVE_LABELS: Record<keyof EmployeeSensitive, string> = {
  idNumber: 'Pièce d’identité',
  cnpsNumber: 'Numéro CNPS',
  birthDate: 'Date de naissance',
  address: 'Adresse',
  personalPhone: 'Téléphone personnel',
  emergencyContact: 'Personne à prévenir',
  bankName: 'Banque',
  bankAccount: 'Compte bancaire',
  mobileMoneyNumber: 'Numéro Mobile Money',
  mobileMoneyOperator: 'Opérateur Mobile Money',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="text-[13px] font-semibold text-muted sm:w-44 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function payoutText(p: MaskedPayout): string {
  return [
    PAYOUT_METHOD_LABELS[p.method],
    p.bankName,
    p.bankAccount,
    p.mobileMoneyNumber,
    p.mobileMoneyOperator,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Changement des coordonnées de paiement en attente : approuvé ou refusé par une autre personne. */
function PendingPayoutChangeCard({ employee }: { employee: EmployeeDetail }) {
  const { can, me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const change = employee.pendingPayoutChange;
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api(`/hr/employees/${employee.id}/payout-change/${approve ? 'approve' : 'reject'}`, {
        method: 'POST',
        body: approve ? undefined : { reason },
      }),
    onSuccess: (_, approve) => {
      toast(approve ? 'Nouvelles coordonnées approuvées' : 'Changement de coordonnées refusé');
      setRejecting(false);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['hr'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  if (!change) return null;
  const canDecide =
    can('hr.write') && change.requestedById !== me?.user.id && employee.userId !== me?.user.id;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-[10px] bg-warn-soft p-3 text-sm">
      <strong>Changement de coordonnées en attente d’approbation</strong>
      <p>
        Actuelles : {payoutText(change.before)}
        <br />
        Demandées : {payoutText(change.after)}
      </p>
      <p className="text-[13px]">
        Demandé par {change.requestedBy ?? '—'} le {formatShortDate(change.requestedAt)}. Il ne
        prend effet qu’après l’accord d’une autre personne ; les paies déjà validées gardent leurs
        coordonnées.
      </p>
      {canDecide ? (
        rejecting ? (
          <div className="flex flex-col gap-2">
            <InputField
              label="Motif du refus"
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              maxLength={300}
            />
            <Button
              size="sm"
              variant="danger"
              disabled={reason.trim().length < 1}
              loading={decide.isPending}
              onClick={() => decide.mutate(false)}
            >
              Refuser le changement
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={decide.isPending} onClick={() => decide.mutate(true)}>
              <Check className="size-4" aria-hidden />
              Approuver
            </Button>
            <Button size="sm" variant="danger" onClick={() => setRejecting(true)}>
              <X className="size-4" aria-hidden />
              Refuser
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function ContractSheet({
  employeeId,
  open,
  onClose,
}: {
  employeeId: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [type, setType] = useState<ContractType>('CDI');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/hr/employees/${employeeId}/contracts`, { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hr'] });
      toast('Contrat enregistré');
      setErrors({});
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length)
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  const num = (v: FormDataEntryValue | null) => (v ? Number(v) : undefined);
  return (
    <Sheet open={open} onClose={onClose} title="Nouveau contrat">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          save.mutate({
            type,
            startDate: fd.get('startDate'),
            endDate: fd.get('endDate') || undefined,
            baseSalary: type === 'HOURLY' ? undefined : num(fd.get('baseSalary')),
            hourlyRate: type === 'HOURLY' ? num(fd.get('hourlyRate')) : undefined,
            overtimeRate: num(fd.get('overtimeRate')),
          });
        }}
      >
        <SelectField
          label="Type de contrat"
          value={type}
          onChange={(e) => setType(e.target.value as ContractType)}
        >
          {CONTRACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {CONTRACT_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <div className="grid gap-3 sm:grid-cols-2">
          <InputField
            label="Début"
            name="startDate"
            type="date"
            required
            defaultValue={todayIso()}
            error={errors.startDate}
          />
          <InputField
            label="Fin"
            name="endDate"
            type="date"
            optional={type !== 'CDD'}
            required={type === 'CDD'}
            error={errors.endDate}
          />
        </div>
        {type === 'HOURLY' ? (
          <InputField
            label="Taux horaire (FCFA)"
            name="hourlyRate"
            type="number"
            inputMode="numeric"
            min={1}
            required
            hint="Le vacataire est payé aux heures de cours réellement faites."
            error={errors.hourlyRate}
          />
        ) : (
          <InputField
            label="Salaire de base mensuel (FCFA)"
            name="baseSalary"
            type="number"
            inputMode="numeric"
            min={1}
            required
            error={errors.baseSalary}
          />
        )}
        <InputField
          label="Taux des heures supplémentaires (FCFA de l’heure)"
          name="overtimeRate"
          type="number"
          inputMode="numeric"
          min={0}
          optional
        />
        <p className="text-[13px] text-muted">
          Le contrat en cours, s’il existe, prend fin la veille du nouveau.
        </p>
        <Button type="submit" loading={save.isPending}>
          Enregistrer le contrat
        </Button>
      </form>
    </Sheet>
  );
}

function SensitiveSheet({
  employeeId,
  open,
  onClose,
}: {
  employeeId: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [data, setData] = useState<EmployeeSensitive | null>(null);
  const reveal = useMutation({
    mutationFn: () =>
      api<EmployeeSensitive>(`/hr/employees/${employeeId}/sensitive`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: setData,
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const close = () => {
    setData(null);
    setReason('');
    onClose();
  };
  const entries = data
    ? (Object.keys(SENSITIVE_LABELS) as (keyof EmployeeSensitive)[]).filter((k) => data[k])
    : [];
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Données sensibles"
      footer={
        data ? (
          <Button block variant="secondary" onClick={close}>
            Masquer et fermer
          </Button>
        ) : (
          <Button
            block
            onClick={() => reveal.mutate()}
            loading={reveal.isPending}
            disabled={reason.trim().length < 5}
          >
            Afficher les données
          </Button>
        )
      }
    >
      {data ? (
        entries.length ? (
          <dl className="flex flex-col gap-2 text-sm">
            {entries.map((k) => (
              <Row key={k} label={SENSITIVE_LABELS[k]}>
                <span className="tabular">{data[k]}</span>
              </Row>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted">Aucune donnée sensible renseignée.</p>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Votre nom, la date et le motif seront inscrits au journal d’audit. N’affichez ces
            données qu’en cas de besoin.
          </p>
          <TextareaField
            label="Motif de la consultation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint="5 caractères minimum, par exemple « Déclaration CNPS »."
            maxLength={200}
          />
        </div>
      )}
    </Sheet>
  );
}

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const [contractOpen, setContractOpen] = useState(false);
  const [sensitiveOpen, setSensitiveOpen] = useState(false);
  const q = useQuery({
    queryKey: ['hr', 'employee', id],
    queryFn: () => api<EmployeeDetail>(`/hr/employees/${id}`),
  });

  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data;
  return (
    <>
      <Link
        href="/rh"
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-primary"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Dossiers du personnel
      </Link>
      <PageHeader
        title={`${e.lastName} ${e.firstName}`}
        subtitle={e.position}
        actions={
          can('hr.write') ? (
            <Button onClick={() => setContractOpen(true)}>
              <FilePlus2 className="size-4" aria-hidden />
              Nouveau contrat
            </Button>
          ) : undefined
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Identité et poste" />
          <dl className="flex flex-col gap-2 text-sm">
            <Row label="Rôles">
              <span className="flex flex-wrap gap-1">
                {e.roles.map((r) => (
                  <Badge key={r} tone="info">
                    {ROLE_LABELS[r]}
                  </Badge>
                ))}
              </span>
            </Row>
            <Row label="Adresse e-mail">{e.email ?? '—'}</Row>
            <Row label="Téléphone">{e.phone ?? '—'}</Row>
            <Row label="Date d’entrée">{formatShortDate(e.hireDate)}</Row>
            <Row label="Diplômes">
              {e.diplomas.length
                ? e.diplomas
                    .map((d) => [d.title, d.institution, d.year].filter(Boolean).join(', '))
                    .join(' ; ')
                : '—'}
            </Row>
          </dl>
        </Card>
        <Card>
          <CardHeader
            title="Paiement et données sensibles"
            subtitle="Chiffrées en base ; chaque affichage est journalisé."
            action={
              <Button size="sm" variant="secondary" onClick={() => setSensitiveOpen(true)}>
                <Eye className="size-4" aria-hidden />
                Afficher
              </Button>
            }
          />
          <PendingPayoutChangeCard employee={e} />
          <dl className="mt-3 flex flex-col gap-2 text-sm">
            <Row label="Mode de paiement">{PAYOUT_METHOD_LABELS[e.payoutMethod]}</Row>
            <Row label="Numéro CNPS">
              <span className="tabular">{e.sensitive.cnpsNumber ?? 'Non renseigné'}</span>
            </Row>
            {e.sensitive.bankAccount ? (
              <Row label="Compte bancaire">
                <span className="tabular">{e.sensitive.bankAccount}</span>
              </Row>
            ) : null}
            {e.sensitive.mobileMoneyNumber ? (
              <Row label="Mobile Money">
                <span className="tabular">{e.sensitive.mobileMoneyNumber}</span>
              </Row>
            ) : null}
          </dl>
        </Card>
        <Card>
          <CardHeader title="Contrats" action={<ContractBadge contract={e.contract} />} />
          <p className="mb-3 text-sm font-semibold">{contractSummary(e.contract)}</p>
          <ul className="flex flex-col gap-2 text-sm">
            {e.contracts.map((c) => (
              <li key={c.id} className="rounded-[10px] border border-line p-3">
                <span className="font-semibold">{CONTRACT_TYPE_LABELS[c.type]}</span>
                <span className="text-muted">
                  {' '}
                  · du {formatShortDate(c.startDate)}
                  {c.endDate ? ` au ${formatShortDate(c.endDate)}` : ''}
                </span>
                <span className="block">
                  {c.type === 'HOURLY'
                    ? `${formatFcfa(c.hourlyRate ?? 0)} de l’heure`
                    : `${formatFcfa(c.baseSalary ?? 0)} par mois`}
                  {c.overtimeRate
                    ? ` · heures supplémentaires ${formatFcfa(c.overtimeRate)}/h`
                    : ''}
                </span>
                {c.endedAt ? (
                  <span className="block text-[13px] text-muted">Terminé : {c.endReason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Avances sur salaire" />
          {e.advances.length === 0 ? (
            <p className="text-sm text-muted">Aucune avance.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {e.advances.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-line p-3"
                >
                  <span>
                    <strong className="tabular">{formatFcfa(a.amount)}</strong> en {a.installments}{' '}
                    mois dès {formatPayrollMonth(a.firstMonth)} · remboursé {formatFcfa(a.repaid)}
                  </span>
                  <Badge tone={ADVANCE_STATUS[a.status].tone}>
                    {ADVANCE_STATUS[a.status].label}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <ContractSheet employeeId={e.id} open={contractOpen} onClose={() => setContractOpen(false)} />
      <SensitiveSheet
        employeeId={e.id}
        open={sensitiveOpen}
        onClose={() => setSensitiveOpen(false)}
      />
    </>
  );
}
