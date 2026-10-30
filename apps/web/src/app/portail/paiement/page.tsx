'use client';

import { formatCameroonPhone, normalizeCameroonPhone } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Lock, Smartphone, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { EmptyState, LoadingBlock } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { ChildSwitcher, useChildren } from '@/components/shell/parent-shell';
import { api, openPdf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatFcfa, formatShortDate } from '@/lib/format';
import type { PaymentView } from '@/lib/types';
import { cn, newIdempotencyKey } from '@/lib/utils';

type Option = 'due' | 'all' | 'other';
type Operator = 'MTN_MOMO' | 'ORANGE_MONEY';

const SIMULATOR = process.env.NEXT_PUBLIC_MOBILE_MONEY_SIMULATOR === 'true';

export default function PortalPayment() {
  const { me } = useAuth();
  const { selected } = useChildren();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [option, setOption] = useState<Option>('due');
  const [other, setOther] = useState('');
  const [operator, setOperator] = useState<Operator>('MTN_MOMO');
  const [phone, setPhone] = useState('');
  const [payment, setPayment] = useState<(PaymentView & { balance?: number }) | null>(null);

  useEffect(() => {
    if (me?.user.phone && !phone) setPhone(formatCameroonPhone(me.user.phone));
  }, [me, phone]);

  const balance = selected?.balance ?? 0;
  const due = selected?.nextDue?.amount ?? balance;
  const otherValue = parseInt(other.replace(/\D/g, ''), 10) || 0;
  const amount =
    option === 'due' ? due : option === 'all' ? balance : Math.min(otherValue, balance);
  const normalized = normalizeCameroonPhone(phone);

  const pay = useMutation({
    mutationFn: () =>
      api<PaymentView>('/portal/payments', {
        method: 'POST',
        body: {
          studentId: selected?.id,
          amount,
          method: operator,
          payerPhone: normalized,
          idempotencyKey: newIdempotencyKey(),
        },
      }),
    onSuccess: setPayment,
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  const status = useQuery({
    queryKey: ['portal-payment', payment?.id],
    queryFn: () => api<PaymentView & { balance: number }>(`/portal/payments/${payment?.id}`),
    enabled: !!payment && payment.status === 'PENDING',
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'PENDING' ? false : 3000),
  });
  const current = status.data ?? payment;

  useEffect(() => {
    if (current && current.status !== 'PENDING') {
      void queryClient.invalidateQueries({ queryKey: ['portal-children'] });
      void queryClient.invalidateQueries({ queryKey: ['portal-child'] });
    }
  }, [current, queryClient]);

  if (!selected) return <LoadingBlock />;

  if (current?.status === 'PENDING') {
    return (
      <div className="flex flex-1 flex-col gap-5 pt-4" role="status" aria-live="polite">
        <div className="flex size-28 items-center justify-center self-center rounded-full bg-warn-soft">
          <div className="flex size-20 items-center justify-center rounded-full bg-saffron">
            <Smartphone className="size-9" aria-hidden />
          </div>
        </div>
        <div className="flex flex-col gap-2 text-center">
          <h2 className="font-display text-[26px] font-bold">Validez sur votre téléphone</h2>
          <p className="text-[15px] text-muted">
            Une demande de <strong className="text-ink">{formatFcfa(current.amount)}</strong> a été
            envoyée au {phone}. Confirmez-la avec votre code secret{' '}
            {operator === 'MTN_MOMO' ? 'MTN MoMo' : 'Orange Money'}.
          </p>
        </div>
        <p className="text-center text-[13px] text-muted">
          Vous pouvez quitter cette page : le paiement se met à jour tout seul dès que l’opérateur
          confirme.
        </p>
        {SIMULATOR && current.operatorReference ? (
          <Button
            variant="secondary"
            onClick={async () => {
              await api(`/dev/mobile-money/${current.operatorReference}/SUCCESS`, {
                method: 'POST',
              });
              void status.refetch();
            }}
          >
            Démo : simuler la validation de l’opérateur
          </Button>
        ) : null}
      </div>
    );
  }

  if (current?.status === 'SUCCESS') {
    return (
      <div className="flex flex-1 flex-col gap-5 pt-4" role="status">
        <CheckCircle2 className="size-24 self-center text-primary" aria-hidden />
        <div className="flex flex-col gap-1 text-center">
          <h2 className="font-display text-[28px] font-bold">Paiement reçu</h2>
          <p className="text-[15px] text-muted">Merci. Le reçu vous a été envoyé par SMS.</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-3 rounded-[16px] border border-line bg-white p-4 text-sm">
          <dt className="text-muted">Montant</dt>
          <dd className="text-right font-bold tabular">{formatFcfa(current.amount)}</dd>
          <dt className="text-muted">Payé avec</dt>
          <dd className="text-right font-semibold">{current.methodLabel}</dd>
          <dt className="text-muted">Reçu</dt>
          <dd className="text-right font-semibold tabular">{current.receipt?.number}</dd>
          <dt className="border-t border-line pt-3 text-muted">Reste à payer</dt>
          <dd className="border-t border-line pt-3 text-right font-display text-xl font-bold tabular">
            {formatFcfa(status.data?.balance ?? Math.max(0, balance - current.amount))}
          </dd>
        </dl>
        <Button
          variant="secondary"
          size="lg"
          onClick={() =>
            openPdf(`/portal/payments/${current.id}/receipt.pdf`).catch(() =>
              toast('Reçu indisponible', 'error'),
            )
          }
        >
          <Download className="size-5" aria-hidden />
          Télécharger le reçu (PDF)
        </Button>
        <ButtonLink href="/portail" size="lg">
          Retour à l’accueil
        </ButtonLink>
      </div>
    );
  }

  if (current && (current.status === 'FAILED' || current.status === 'CANCELLED')) {
    return (
      <div className="flex flex-1 flex-col gap-5 pt-4" role="alert">
        <XCircle className="size-24 self-center text-danger" aria-hidden />
        <div className="flex flex-col gap-1 text-center">
          <h2 className="font-display text-[26px] font-bold">Paiement non abouti</h2>
          <p className="text-[15px] text-muted">
            Aucun montant n’a été encaissé par l’école. Vous pouvez réessayer.
          </p>
        </div>
        <Button size="lg" onClick={() => setPayment(null)}>
          Réessayer
        </Button>
      </div>
    );
  }

  if (balance === 0) {
    return (
      <>
        <ChildSwitcher />
        <EmptyState title={`La scolarité de ${selected.firstName} est à jour`}>
          Aucun montant à payer.
        </EmptyState>
      </>
    );
  }

  const options: { value: Option; label: string; sub: string; amount: number | null }[] = [
    {
      value: 'due',
      label: selected.nextDue
        ? `Échéance du ${formatShortDate(selected.nextDue.dueDate)}`
        : 'Prochaine échéance',
      sub: selected.nextDue?.label ?? '',
      amount: due,
    },
    {
      value: 'all',
      label: 'Tout le solde',
      sub: 'Toutes les échéances restantes',
      amount: balance,
    },
    { value: 'other', label: 'Autre montant', sub: 'Paiement partiel', amount: null },
  ];

  return (
    <form
      className="flex flex-1 flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        pay.mutate();
      }}
    >
      <ChildSwitcher />
      <p className="text-sm text-muted">
        Scolarité de <strong className="text-ink">{selected.firstName}</strong> ·{' '}
        {selected.school.name}
      </p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[15px] font-bold">Montant</legend>
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'flex min-h-15 items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5',
              option === o.value ? 'border-2 border-primary' : 'border border-line',
            )}
          >
            <input
              type="radio"
              name="amount"
              className="size-5 accent-primary"
              checked={option === o.value}
              onChange={() => setOption(o.value)}
            />
            <span className="flex flex-1 flex-col">
              <strong className="text-[15px]">{o.label}</strong>
              <span className="text-[13px] text-muted">{o.sub}</span>
            </span>
            {o.amount !== null ? (
              <strong className="text-[15px] tabular">{formatFcfa(o.amount, false)}</strong>
            ) : null}
          </label>
        ))}
        {option === 'other' ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">Montant en FCFA</span>
            <input
              inputMode="numeric"
              value={other}
              onChange={(e) => setOther(e.target.value.replace(/[^\d]/g, ''))}
              className="h-13 rounded-[14px] border-2 border-primary bg-white px-3.5 text-right text-xl font-bold tabular"
            />
          </label>
        ) : null}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[15px] font-bold">Payer avec</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['MTN_MOMO', 'ORANGE_MONEY'] as const).map((op) => (
            <button
              key={op}
              type="button"
              aria-pressed={operator === op}
              onClick={() => setOperator(op)}
              className={cn(
                'flex min-h-14 items-center justify-center gap-2 rounded-[14px] text-[15px] font-bold',
                operator === op
                  ? 'border-2 border-primary bg-primary-soft'
                  : 'border border-line bg-white',
              )}
            >
              <Smartphone className="size-4" aria-hidden />
              {op === 'MTN_MOMO' ? 'MTN MoMo' : 'Orange Money'}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Numéro débité</span>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={!!phone && !normalized}
            className="h-13 rounded-[14px] border border-line-strong bg-white px-3.5 text-lg font-semibold tabular aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger"
          />
        </label>
      </fieldset>
      <div className="mt-auto flex flex-col gap-2.5">
        <Button
          type="submit"
          size="lg"
          loading={pay.isPending}
          disabled={amount < 100 || !normalized}
        >
          Payer {formatFcfa(amount)}
        </Button>
        <span className="flex items-center justify-center gap-1.5 text-[13px] text-muted">
          <Lock className="size-3.5" aria-hidden />
          Votre code secret n’est jamais demandé ici.
        </span>
      </div>
    </form>
  );
}
