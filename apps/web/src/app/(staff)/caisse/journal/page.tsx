'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, downloadFile, openPdf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatFcfa, PAYMENT_METHOD_LABELS, todayIso } from '@/lib/format';
import type { PaymentView } from '@/lib/types';
import { cn } from '@/lib/utils';

type Row = PaymentView & {
  student: { id: string; firstName: string; lastName: string; matricule: string } | null;
};

const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export default function JournalPage() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(shift(todayIso(), -7));
  const [to, setTo] = useState(todayIso());
  const [method, setMethod] = useState('');
  const [reverse, setReverse] = useState<Row | null>(null);
  const qs = new URLSearchParams({ from, to, ...(method ? { method } : {}) }).toString();
  const q = useQuery({
    queryKey: ['journal', qs],
    queryFn: () => api<Row[]>(`/finance/payments?${qs}`),
  });
  const doReverse = useMutation({
    mutationFn: (reason: string) =>
      api(`/finance/payments/${reverse?.id}/reverse`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      setReverse(null);
      toast('Paiement annulé par une écriture de correction');
      void queryClient.invalidateQueries({ queryKey: ['journal'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const total =
    q.data
      ?.filter((p) => p.status === 'SUCCESS' && !p.reversed)
      .reduce((s, p) => s + p.amount, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Journal des paiements"
        subtitle={q.data ? `${formatFcfa(total)} encaissés sur la période` : undefined}
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              downloadFile(
                `/finance/payments/export.csv?from=${from}&to=${to}`,
                `paiements-${from}-${to}.csv`,
              ).catch((e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'))
            }
          >
            <Download className="size-4" aria-hidden />
            Exporter (CSV)
          </Button>
        }
      />
      <Card className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <InputField label="Du" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <InputField label="Au" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <SelectField
          label="Moyen"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          containerClassName="col-span-2 lg:col-span-1"
        >
          <option value="">Tous</option>
          {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
      </Card>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Aucun paiement sur la période" />
      ) : (
        <ul className="flex flex-col gap-2">
          {q.data.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-3 rounded-[14px] border border-line bg-white p-3"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                {p.student ? (
                  <Link
                    href={`/eleves/${p.student.id}`}
                    className="truncate font-semibold hover:underline"
                  >
                    {p.student.lastName} {p.student.firstName}
                  </Link>
                ) : null}
                <span className="text-[13px] text-muted">
                  {p.methodLabel} · {formatDateTime(p.confirmedAt ?? p.createdAt)}
                  {p.receipt ? ` · ${p.receipt.number}` : ''}
                </span>
              </div>
              <strong className={cn('tabular', p.reversed && 'text-muted line-through')}>
                {formatFcfa(p.amount)}
              </strong>
              {p.reversed ? (
                <Badge tone="danger">Annulé</Badge>
              ) : p.status === 'SUCCESS' ? (
                <Badge tone="success">Encaissé</Badge>
              ) : p.status === 'PENDING' ? (
                <Badge tone="info">En attente</Badge>
              ) : (
                <Badge>{p.status === 'FAILED' ? 'Échec' : 'Expiré'}</Badge>
              )}
              <div className="flex w-full gap-2 sm:w-auto">
                {p.receipt ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 sm:flex-none"
                    onClick={() =>
                      openPdf(`/finance/payments/${p.id}/receipt.pdf`).catch(() =>
                        toast('Reçu indisponible', 'error'),
                      )
                    }
                  >
                    Reçu
                  </Button>
                ) : null}
                {can('finance.payments.reverse') && p.status === 'SUCCESS' && !p.reversed ? (
                  <Button
                    variant="danger"
                    size="sm"
                    className="flex-1 sm:flex-none"
                    onClick={() => setReverse(p)}
                  >
                    Annuler
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={!!reverse} onClose={() => setReverse(null)} title="Annuler ce paiement ?">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            doReverse.mutate(String(new FormData(e.currentTarget).get('reason')));
          }}
        >
          <p className="text-sm text-muted">
            Le paiement de{' '}
            <strong className="text-ink">{reverse ? formatFcfa(reverse.amount) : ''}</strong> reste
            dans le journal. Une écriture d’annulation est ajoutée et le reçu est marqué « annulé ».
          </p>
          <InputField label="Motif de l’annulation" name="reason" required minLength={5} />
          <Button type="submit" variant="danger" loading={doReverse.isPending}>
            Créer l’écriture de correction
          </Button>
        </form>
      </Sheet>
    </>
  );
}
