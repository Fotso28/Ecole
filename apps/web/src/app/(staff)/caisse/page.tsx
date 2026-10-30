'use client';

import { normalizeCameroonPhone } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Printer, Search, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Badge, LINE_BADGE } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, openPdf } from '@/lib/api';
import { formatFcfa, formatShortDate, initials, PAYMENT_METHOD_LABELS, plural } from '@/lib/format';
import type { Account, Paged, PaymentView, StudentListItem } from '@/lib/types';
import { cn, newIdempotencyKey } from '@/lib/utils';

type Method = 'CASH' | 'MTN_MOMO' | 'ORANGE_MONEY' | 'BANK';

interface CashSession {
  id: string;
  openedAt: string;
  operations: number;
  expected: number;
  reversed: number;
}

interface PaymentResult extends PaymentView {
  allocations?: { lineId: string; amount: number }[];
  unallocated?: number;
  balance?: number;
}

const toInt = (s: string) => {
  const n = parseInt(s.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

function CashContent() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [studentId, setStudentId] = useState(params.get('eleve') ?? '');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('CASH');
  const [given, setGiven] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankReference, setBankReference] = useState('');
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [counted, setCounted] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const session = useQuery({
    queryKey: ['cash-session'],
    queryFn: () => api<CashSession | null>('/finance/cash-sessions/current'),
  });
  const results = useQuery({
    queryKey: ['cash-search', debounced],
    queryFn: () =>
      api<Paged<StudentListItem>>(`/students?search=${encodeURIComponent(debounced)}&pageSize=8`),
    enabled: debounced.length >= 2 && !studentId,
  });
  const account = useQuery({
    queryKey: ['account', studentId],
    queryFn: () => api<Account>(`/finance/students/${studentId}/account`),
    enabled: !!studentId,
  });

  const openLines = useMemo(
    () => account.data?.lines.filter((l) => l.outstanding > 0) ?? [],
    [account.data],
  );
  useEffect(() => {
    if (!account.data) return;
    const first = account.data.lines.find((l) => l.outstanding > 0);
    setSelected(new Set(first ? [first.id] : []));
  }, [account.data]);
  const selectedTotal = openLines
    .filter((l) => selected.has(l.id))
    .reduce((s, l) => s + l.outstanding, 0);
  useEffect(() => setAmount(selectedTotal ? String(selectedTotal) : ''), [selectedTotal]);

  const amountValue = toInt(amount);
  const change = toInt(given) - amountValue;
  const phone = normalizeCameroonPhone(payerPhone);
  const momo = method === 'MTN_MOMO' || method === 'ORANGE_MONEY';
  const ready =
    amountValue > 0 &&
    (method !== 'CASH' || (!!session.data && toInt(given) >= amountValue)) &&
    (!momo || !!phone) &&
    (method !== 'BANK' || bankReference.trim().length > 0);

  const pay = useMutation({
    mutationFn: (key: string) =>
      api<PaymentResult>('/finance/payments', {
        method: 'POST',
        body: {
          studentId,
          amount: amountValue,
          method,
          lineIds: [...selected],
          payerPhone: momo ? phone : undefined,
          bankName: method === 'BANK' ? bankName || undefined : undefined,
          bankReference: method === 'BANK' ? bankReference : undefined,
          idempotencyKey: key,
        },
      }),
    onSuccess: (p) => {
      setConfirmKey(null);
      setResult(p);
      void queryClient.invalidateQueries({ queryKey: ['account', studentId] });
      void queryClient.invalidateQueries({ queryKey: ['cash-session'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'CASH_SESSION_REQUIRED')
        void queryClient.invalidateQueries({ queryKey: ['cash-session'] });
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });

  // Suivi d'un paiement Mobile Money jusqu'à la réponse de l'opérateur.
  const pending = useQuery({
    queryKey: ['payment', result?.id],
    queryFn: () => api<PaymentView>(`/finance/payments/${result?.id}`),
    enabled: !!result && result.status === 'PENDING',
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'PENDING' ? false : 3000),
  });
  const shown =
    pending.data && pending.data.status !== 'PENDING' ? { ...result, ...pending.data } : result;

  const openSession = useMutation({
    mutationFn: () => api('/finance/cash-sessions/open', { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['cash-session'] }),
  });
  const closeSession = useMutation({
    mutationFn: () =>
      api<{ difference: number; expectedAmount: number }>(
        `/finance/cash-sessions/${session.data?.id}/close`,
        { method: 'POST', body: { countedAmount: toInt(counted) } },
      ),
    onSuccess: (r) => {
      setCloseOpen(false);
      setCounted('');
      toast(
        r.difference === 0
          ? 'Caisse clôturée sans écart'
          : `Caisse clôturée · écart de ${formatFcfa(r.difference)}`,
        r.difference === 0 ? 'success' : 'error',
      );
      void queryClient.invalidateQueries({ queryKey: ['cash-session'] });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });

  const reset = () => {
    setResult(null);
    setStudentId('');
    setSearch('');
    setGiven('');
    setPayerPhone('');
    setBankReference('');
    router.replace('/caisse', { scroll: false });
  };

  return (
    <>
      <PageHeader title="Caisse" />

      {session.data ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-white p-3">
          <Badge tone="success">Ouverte</Badge>
          <span className="flex-1 text-sm">
            {plural(session.data.operations, 'opération', 'opérations')} en espèces ·{' '}
            <strong className="tabular">{formatFcfa(session.data.expected)}</strong>
          </span>
          <Button variant="secondary" size="sm" onClick={() => setCloseOpen(true)}>
            Clôturer ma caisse
          </Button>
        </div>
      ) : session.isSuccess ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[12px] bg-warn-soft p-3">
          <span className="flex-1 text-sm">
            Votre caisse est fermée : ouvrez-la pour encaisser des espèces.
          </span>
          <Button size="sm" onClick={() => openSession.mutate()} loading={openSession.isPending}>
            Ouvrir ma caisse
          </Button>
        </div>
      ) : null}

      {shown ? (
        <Card className="flex flex-col items-center gap-4 py-8 text-center" aria-live="polite">
          {shown.status === 'SUCCESS' ? (
            <CheckCircle2 className="size-14 text-primary" aria-hidden />
          ) : shown.status === 'PENDING' ? (
            <Clock className="size-14 text-warn" aria-hidden />
          ) : (
            <X className="size-14 text-danger" aria-hidden />
          )}
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-2xl font-bold">
              {shown.status === 'SUCCESS'
                ? `Reçu ${shown.receipt?.number ?? ''} émis`
                : shown.status === 'PENDING'
                  ? 'En attente de validation sur le téléphone'
                  : 'Paiement non abouti'}
            </h2>
            <p className="text-sm text-muted">
              {formatFcfa(shown.amount)} · {PAYMENT_METHOD_LABELS[shown.method]}
              {shown.status === 'PENDING'
                ? ' · le reçu sera émis dès la confirmation de l’opérateur'
                : ''}
            </p>
          </div>
          <div className="flex w-full max-w-sm flex-col gap-2">
            {shown.status === 'SUCCESS' ? (
              <Button
                variant="secondary"
                onClick={() =>
                  openPdf(`/finance/payments/${shown.id}/receipt.pdf`).catch(() =>
                    toast('Reçu indisponible', 'error'),
                  )
                }
              >
                <Printer className="size-4" aria-hidden />
                Imprimer le reçu
              </Button>
            ) : null}
            <Button onClick={reset}>Nouvel encaissement</Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr] lg:items-start">
          <div className="flex flex-col gap-4">
            <Card className="flex flex-col gap-3">
              {studentId && account.data ? (
                <div className="flex items-center gap-3">
                  <span className="flex size-11 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary">
                    {initials(`${account.data.student.lastName} ${account.data.student.firstName}`)}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <strong className="truncate">
                      {account.data.student.lastName} {account.data.student.firstName}
                    </strong>
                    <span className="text-[13px] text-muted tabular">
                      {account.data.student.matricule}
                    </span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-xs text-muted">Reste à payer</span>
                    <strong className="tabular">
                      {formatFcfa(account.data.totals.outstanding)}
                    </strong>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Changer d’élève"
                    onClick={() => setStudentId('')}
                  >
                    <X className="size-5" aria-hidden />
                  </Button>
                </div>
              ) : (
                <>
                  <label className="flex h-12 items-center gap-2 rounded-[10px] border border-line-strong bg-white px-3 lg:h-11">
                    <Search className="size-4 text-muted" aria-hidden />
                    <span className="sr-only">Élève ou payeur</span>
                    <input
                      autoFocus
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Nom, matricule ou téléphone du parent"
                      className="h-full flex-1 bg-transparent text-base outline-none"
                    />
                  </label>
                  {results.data?.items.length ? (
                    <ul className="flex flex-col">
                      {results.data.items.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => setStudentId(s.id)}
                            className="flex min-h-14 w-full items-center gap-3 border-t border-line text-left first:border-t-0"
                          >
                            <span className="flex-1">
                              <strong className="block text-[15px]">
                                {s.lastName} {s.firstName}
                              </strong>
                              <span className="text-[13px] text-muted">
                                {s.class?.name ?? '—'} · {s.matricule}
                              </span>
                            </span>
                            {s.overdue ? (
                              <span className="text-[13px] font-semibold text-danger tabular">
                                {formatFcfa(s.overdue)}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : debounced.length >= 2 && results.isSuccess ? (
                    <p className="text-sm text-muted">Aucun élève trouvé.</p>
                  ) : null}
                </>
              )}
            </Card>

            {studentId ? (
              account.isPending ? (
                <LoadingBlock />
              ) : account.isError ? (
                <ErrorBlock error={account.error} />
              ) : (
                <Card>
                  <CardHeader
                    title="Échéancier"
                    subtitle="Cochez les échéances réglées aujourd’hui"
                  />
                  <ul className="flex flex-col">
                    {account.data.lines.map((l) => {
                      const payable = l.outstanding > 0;
                      return (
                        <li key={l.id} className="border-t border-line first:border-t-0">
                          <label
                            className={cn(
                              'flex min-h-14 items-center gap-3 py-2',
                              !payable && 'opacity-80',
                            )}
                          >
                            <input
                              type="checkbox"
                              className="size-5 accent-primary"
                              disabled={!payable}
                              checked={selected.has(l.id)}
                              onChange={() =>
                                setSelected((s) => {
                                  const n = new Set(s);
                                  if (n.has(l.id)) n.delete(l.id);
                                  else n.add(l.id);
                                  return n;
                                })
                              }
                            />
                            <span className="flex flex-1 flex-col">
                              <strong className="text-sm">{l.label}</strong>
                              <span
                                className={cn(
                                  'text-xs',
                                  l.overdue ? 'font-semibold text-danger' : 'text-muted',
                                )}
                              >
                                {l.overdue ? 'Échue le' : 'Échéance'} {formatShortDate(l.dueDate)}
                              </span>
                            </span>
                            <span className="flex flex-col items-end gap-1">
                              <span className="text-sm font-semibold tabular">
                                {payable ? formatFcfa(l.outstanding) : formatFcfa(l.due)}
                              </span>
                              <Badge tone={LINE_BADGE[l.status].tone}>
                                {LINE_BADGE[l.status].label}
                              </Badge>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )
            ) : null}
          </div>

          {studentId && account.data ? (
            <Card className="flex flex-col gap-4 lg:sticky lg:top-20">
              <div className="flex items-baseline justify-between gap-2 rounded-[12px] bg-night p-4 text-white">
                <span className="text-sm text-night-text">Montant</span>
                <strong className="font-display text-3xl tabular">{formatFcfa(amountValue)}</strong>
              </div>
              <InputField
                label="Montant encaissé"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                hint="Modifiable pour un paiement partiel."
              />
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-semibold">Moyen de paiement</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(['CASH', 'MTN_MOMO', 'ORANGE_MONEY', 'BANK'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={method === m}
                      onClick={() => setMethod(m)}
                      className={cn(
                        'min-h-13 rounded-[12px] border px-3 text-left text-sm font-bold',
                        method === m
                          ? 'border-2 border-primary bg-primary-soft'
                          : 'border-line-strong bg-white',
                      )}
                    >
                      {PAYMENT_METHOD_LABELS[m]}
                    </button>
                  ))}
                </div>
              </fieldset>
              {method === 'CASH' ? (
                <div className="grid grid-cols-2 gap-3">
                  <InputField
                    label="Montant remis"
                    inputMode="numeric"
                    value={given}
                    onChange={(e) => setGiven(e.target.value.replace(/[^\d]/g, ''))}
                  />
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-semibold">Monnaie à rendre</span>
                    <strong
                      className={cn(
                        'flex h-12 items-center justify-end rounded-[10px] bg-paper px-3 text-lg tabular lg:h-10',
                        change < 0 && given ? 'text-danger' : '',
                      )}
                    >
                      {given
                        ? change < 0
                          ? `Manque ${formatFcfa(-change)}`
                          : formatFcfa(change)
                        : '—'}
                    </strong>
                  </div>
                </div>
              ) : momo ? (
                <InputField
                  label={`Numéro ${PAYMENT_METHOD_LABELS[method]} du payeur`}
                  type="tel"
                  inputMode="tel"
                  value={payerPhone}
                  onChange={(e) => setPayerPhone(e.target.value)}
                  placeholder="6 77 12 34 56"
                  hint="Le payeur valide sur son téléphone avec son code secret."
                  error={payerPhone && !phone ? 'Numéro camerounais invalide' : undefined}
                />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <InputField
                    label="Banque"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    optional
                  />
                  <InputField
                    label="N° de bordereau"
                    value={bankReference}
                    onChange={(e) => setBankReference(e.target.value)}
                  />
                </div>
              )}
              <Button
                size="lg"
                disabled={!ready}
                onClick={() => setConfirmKey(newIdempotencyKey())}
              >
                {momo
                  ? `Envoyer la demande de ${formatFcfa(amountValue)}`
                  : `Encaisser ${formatFcfa(amountValue)}`}
              </Button>
              <p className="text-xs text-muted">
                Un encaissement validé ne se modifie pas : une erreur se corrige par une écriture
                d’annulation tracée.
              </p>
            </Card>
          ) : null}
        </div>
      )}

      <Sheet
        open={!!confirmKey}
        onClose={() => setConfirmKey(null)}
        title="Vérifiez avant de valider"
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setConfirmKey(null)}>
              Modifier
            </Button>
            <Button onClick={() => confirmKey && pay.mutate(confirmKey)} loading={pay.isPending}>
              Valider
            </Button>
          </div>
        }
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted">Élève</dt>
          <dd className="text-right font-semibold">
            {account.data?.student.lastName} {account.data?.student.firstName}
          </dd>
          <dt className="text-muted">Échéances</dt>
          <dd className="text-right font-semibold">
            {openLines
              .filter((l) => selected.has(l.id))
              .map((l) => l.label)
              .join(' + ') || 'Les plus anciennes'}
          </dd>
          <dt className="text-muted">Moyen</dt>
          <dd className="text-right font-semibold">{PAYMENT_METHOD_LABELS[method]}</dd>
          <dt className="text-muted">Montant</dt>
          <dd className="text-right font-display text-2xl font-bold tabular">
            {formatFcfa(amountValue)}
          </dd>
        </dl>
      </Sheet>

      <Sheet open={closeOpen} onClose={() => setCloseOpen(false)} title="Clôturer ma caisse">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            closeSession.mutate();
          }}
        >
          <p className="text-sm text-muted">
            Espèces attendues :{' '}
            <strong className="text-ink tabular">{formatFcfa(session.data?.expected ?? 0)}</strong>.
            Comptez le tiroir et saisissez le montant réel.
          </p>
          <InputField
            label="Montant compté"
            inputMode="numeric"
            value={counted}
            onChange={(e) => setCounted(e.target.value.replace(/[^\d]/g, ''))}
            required
          />
          <Button type="submit" loading={closeSession.isPending} disabled={!counted}>
            Clôturer
          </Button>
        </form>
      </Sheet>
    </>
  );
}

export default function CashPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <CashContent />
    </Suspense>
  );
}
