'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { PillTabs } from '@/components/ui/pill-tabs';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDateTime, formatFcfa, formatSignedFcfa, plural } from '@/lib/format';
import { cn } from '@/lib/utils';

type Person = { id: string; firstName: string; lastName: string } | null;

interface CashClosure {
  id: string;
  status: 'OPEN' | 'CLOSED' | 'APPROVED';
  openedAt: string;
  closedAt: string | null;
  approvedAt: string | null;
  openedBy: Person;
  closedBy: Person;
  approvedBy: Person;
  expectedAmount: number;
  countedAmount: number | null;
  difference: number | null;
  note: string | null;
  entry: string | null;
  canApprove: boolean;
}

const STATUS = {
  OPEN: { tone: 'info', label: 'Ouverte' },
  CLOSED: { tone: 'warn', label: 'À approuver' },
  APPROVED: { tone: 'success', label: 'Approuvée' },
} as const;

const TABS = [
  ['CLOSED', 'À approuver'],
  ['APPROVED', 'Approuvées'],
  ['', 'Toutes'],
] as const;

const name = (p: Person) => (p ? `${p.lastName} ${p.firstName}` : '—');

function Difference({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted">—</span>;
  return (
    <span
      className={cn(
        'font-semibold tabular',
        value < 0 ? 'text-danger' : value > 0 ? 'text-warn' : 'text-primary',
      )}
    >
      {value === 0 ? 'Aucun écart' : formatSignedFcfa(value)}
    </span>
  );
}

/** Clôtures de caisse : consultation et approbation par une autre personne que le caissier. */
export default function CashClosuresPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<(typeof TABS)[number][0]>('CLOSED');
  const q = useQuery({
    queryKey: ['cash-sessions', status],
    queryFn: () => api<CashClosure[]>(`/finance/cash-sessions${status ? `?status=${status}` : ''}`),
  });
  const approve = useMutation({
    mutationFn: (id: string) =>
      api<{ difference: number; entry: string | null }>(`/finance/cash-sessions/${id}/approve`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      toast(
        r.entry
          ? `Clôture approuvée · écart passé en comptabilité (${r.entry})`
          : 'Clôture approuvée',
      );
      void queryClient.invalidateQueries({ queryKey: ['cash-sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const rows = q.data ?? [];
  const pending = rows.filter((r) => r.status === 'CLOSED').length;

  const action = (r: CashClosure) =>
    r.canApprove ? (
      <Button
        size="sm"
        className="w-full lg:w-auto"
        loading={approve.isPending && approve.variables === r.id}
        onClick={() => approve.mutate(r.id)}
      >
        Approuver<span className="sr-only"> la clôture de {name(r.openedBy)}</span>
      </Button>
    ) : r.status === 'CLOSED' ? (
      <span className="text-[13px] text-muted">À approuver par une autre personne</span>
    ) : null;

  return (
    <>
      <PageHeader
        title="Clôtures de caisse"
        subtitle={
          status === 'CLOSED' && q.data
            ? pending === 0
              ? 'Aucune clôture en attente'
              : `${plural(pending, 'clôture', 'clôtures')} en attente d’approbation`
            : 'L’approbation revient à une autre personne que le caissier ; l’écart est alors passé en comptabilité.'
        }
      />
      <PillTabs label="Statut des clôtures" tabs={TABS} value={status} onChange={setStatus} />
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={status === 'CLOSED' ? 'Aucune clôture à approuver' : 'Aucune clôture'} />
      ) : (
        <>
          {/* Téléphone : cartes empilées. */}
          <ul className="flex flex-col gap-2 lg:hidden">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <strong className="[overflow-wrap:anywhere]">{name(r.openedBy)}</strong>
                    <span className="text-[13px] text-muted">
                      {r.closedAt
                        ? `Clôturée le ${formatDateTime(r.closedAt)}`
                        : `Ouverte le ${formatDateTime(r.openedAt)}`}
                    </span>
                  </div>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-[13px] text-muted">Attendu</dt>
                    <dd className="font-semibold tabular">{formatFcfa(r.expectedAmount)}</dd>
                  </div>
                  <div>
                    <dt className="text-[13px] text-muted">Compté</dt>
                    <dd className="font-semibold tabular">
                      {r.countedAmount === null ? '—' : formatFcfa(r.countedAmount)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[13px] text-muted">Écart</dt>
                    <dd>
                      <Difference value={r.difference} />
                    </dd>
                  </div>
                </dl>
                {r.note ? (
                  <p className="text-[13px] [overflow-wrap:anywhere]">
                    <span className="text-muted">Motif : </span>
                    {r.note}
                  </p>
                ) : null}
                {r.status === 'APPROVED' ? (
                  <p className="text-[13px] text-muted">
                    Approuvée par {name(r.approvedBy)}
                    {r.entry ? ` · écriture ${r.entry}` : ''}
                  </p>
                ) : null}
                {action(r)}
              </li>
            ))}
          </ul>
          {/* Ordinateur : tableau. */}
          <Card className="hidden p-0 lg:block lg:p-0">
            <table className="w-full text-sm">
              <caption className="sr-only">Clôtures de caisse</caption>
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Caissier
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Clôture
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    Attendu
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    Compté
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    Écart
                  </th>
                  <th scope="col" className="py-2 pl-4 font-semibold">
                    Motif
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Statut
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="px-4 py-2.5 font-semibold">{name(r.openedBy)}</td>
                    <td className="py-2.5">
                      {r.closedAt ? formatDateTime(r.closedAt) : '—'}
                      {r.closedBy && r.closedBy.id !== r.openedBy?.id ? (
                        <span className="block text-[13px] text-muted">par {name(r.closedBy)}</span>
                      ) : null}
                    </td>
                    <td className="py-2.5 text-right tabular">{formatFcfa(r.expectedAmount)}</td>
                    <td className="py-2.5 text-right tabular">
                      {r.countedAmount === null ? '—' : formatFcfa(r.countedAmount)}
                    </td>
                    <td className="py-2.5 text-right">
                      <Difference value={r.difference} />
                    </td>
                    <td className="max-w-64 py-2.5 pl-4 [overflow-wrap:anywhere]">
                      {r.note ?? <span className="text-muted">—</span>}
                    </td>
                    <td className="py-2.5">
                      <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                      {r.status === 'APPROVED' ? (
                        <span className="block text-[13px] text-muted">
                          par {name(r.approvedBy)}
                          {r.entry ? ` · ${r.entry}` : ''}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-right">{action(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}
