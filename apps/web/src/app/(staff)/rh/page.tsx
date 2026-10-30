'use client';

import {
  PAYOUT_METHOD_LABELS,
  PAYOUT_METHODS,
  ROLE_LABELS,
  type PayoutMethod,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ContractBadge, contractSummary } from '@/components/hr';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatShortDate, todayIso } from '@/lib/format';
import type { ContractAlert, EmployeeRow } from '@/lib/hr';
import type { Me } from '@/lib/types';

interface Candidate {
  id: string;
  firstName: string;
  lastName: string;
  roles: Me['roles'];
}

function CreateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const candidates = useQuery({
    queryKey: ['hr', 'candidates'],
    queryFn: () => api<Candidate[]>('/hr/employees/candidates'),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string }>('/hr/employees', { method: 'POST', body }),
    onSuccess: (file) => {
      void queryClient.invalidateQueries({ queryKey: ['hr'] });
      toast('Dossier créé. Ajoutez maintenant le contrat.');
      onClose();
      router.push(`/rh/${file.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length)
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  return (
    <Sheet open={open} onClose={onClose} title="Nouveau dossier du personnel">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const value = (k: string) => String(fd.get(k) ?? '').trim() || undefined;
          create.mutate({
            userId: fd.get('userId'),
            position: fd.get('position'),
            hireDate: fd.get('hireDate'),
            payoutMethod: fd.get('payoutMethod'),
            diplomas: value('diploma') ? [{ title: value('diploma') }] : [],
            sensitive: {
              cnpsNumber: value('cnpsNumber'),
              idNumber: value('idNumber'),
              bankName: value('bankName'),
              bankAccount: value('bankAccount'),
              mobileMoneyNumber: value('mobileMoneyNumber'),
            },
          });
        }}
      >
        <SelectField label="Membre du personnel" name="userId" required error={errors.userId}>
          <option value="">Choisir…</option>
          {(candidates.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.lastName} {c.firstName} ({c.roles.map((r) => ROLE_LABELS[r]).join(', ')})
            </option>
          ))}
        </SelectField>
        <InputField label="Poste" name="position" required error={errors.position} />
        <InputField
          label="Date d’entrée"
          name="hireDate"
          type="date"
          required
          defaultValue={todayIso()}
          error={errors.hireDate}
        />
        <InputField label="Diplôme principal" name="diploma" optional />
        <SelectField label="Mode de paiement du salaire" name="payoutMethod" defaultValue="BANK">
          {PAYOUT_METHODS.map((m: PayoutMethod) => (
            <option key={m} value={m}>
              {PAYOUT_METHOD_LABELS[m]}
            </option>
          ))}
        </SelectField>
        <fieldset className="flex flex-col gap-3 rounded-[12px] border border-line p-3">
          <legend className="px-1 text-sm font-semibold">Données sensibles (chiffrées)</legend>
          <InputField label="Numéro CNPS" name="cnpsNumber" optional />
          <InputField label="Numéro de pièce d’identité" name="idNumber" optional />
          <InputField label="Banque" name="bankName" optional />
          <InputField label="Numéro de compte (RIB)" name="bankAccount" optional />
          <InputField label="Numéro Mobile Money" name="mobileMoneyNumber" type="tel" optional />
        </fieldset>
        <Button type="submit" loading={create.isPending}>
          Créer le dossier
        </Button>
      </form>
    </Sheet>
  );
}

export default function HrPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['hr', 'employees'],
    queryFn: () => api<EmployeeRow[]>('/hr/employees'),
  });
  const alerts = useQuery({
    queryKey: ['hr', 'alerts'],
    queryFn: () => api<ContractAlert[]>('/hr/alerts'),
  });

  return (
    <>
      <PageHeader
        title="Dossiers du personnel"
        subtitle="Identité, poste, diplômes, contrats et coordonnées de paiement. Les données sensibles sont chiffrées et chaque consultation est journalisée."
        actions={
          can('hr.write') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Nouveau dossier
            </Button>
          ) : undefined
        }
      />

      {alerts.data && alerts.data.length > 0 ? (
        <section
          aria-labelledby="alertes-cdd"
          className="flex flex-col gap-2 rounded-[14px] bg-warn-soft p-4"
        >
          <h2 id="alertes-cdd" className="flex items-center gap-2 font-bold text-warn">
            <TriangleAlert className="size-5" aria-hidden />
            CDD à renouveler ou à clôturer
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {alerts.data.map((a) => (
              <li key={a.contract.id}>
                <Link href={`/rh/${a.employeeId}`} className="font-semibold underline">
                  {a.lastName} {a.firstName}
                </Link>{' '}
                · {a.position} · fin le {formatShortDate(a.contract.endDate ?? '')}
                {a.contract.daysLeft !== null && a.contract.daysLeft < 0
                  ? ' (échu)'
                  : ` (dans ${a.contract.daysLeft} jours)`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Aucun dossier">
          Créez un dossier pour chaque membre du personnel rémunéré par l’école.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Dossiers du personnel">
            {q.data.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/rh/${e.id}`}
                  className="flex min-h-14 flex-col gap-1.5 rounded-[14px] border border-line bg-white p-3"
                >
                  <span className="flex items-start justify-between gap-2">
                    <strong className="min-w-0 truncate">
                      {e.lastName} {e.firstName}
                    </strong>
                    <ContractBadge contract={e.contract} />
                  </span>
                  <span className="text-[13px] text-muted">{e.position}</span>
                  <span className="text-sm">{contractSummary(e.contract)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-[14px] border border-line bg-white md:block">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">Dossiers du personnel</caption>
              <thead className="bg-paper text-left text-xs tracking-[0.06em] text-muted uppercase">
                <tr>
                  <th className="px-4 py-3 font-semibold">Nom</th>
                  <th className="px-3 py-3 font-semibold">Poste</th>
                  <th className="px-3 py-3 font-semibold">Contrat</th>
                  <th className="px-3 py-3 font-semibold">Entrée</th>
                  <th className="px-4 py-3 font-semibold">Paiement</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((e) => (
                  <tr key={e.id} className="border-t border-line align-top">
                    <td className="px-4 py-2.5">
                      <Link href={`/rh/${e.id}`} className="font-semibold hover:underline">
                        {e.lastName} {e.firstName}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">{e.position}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col items-start gap-1">
                        <span>{contractSummary(e.contract)}</span>
                        <ContractBadge contract={e.contract} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 tabular">{formatShortDate(e.hireDate)}</td>
                    <td className="px-4 py-2.5">{PAYOUT_METHOD_LABELS[e.payoutMethod]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <CreateSheet open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
