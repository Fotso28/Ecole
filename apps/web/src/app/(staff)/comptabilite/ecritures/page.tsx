'use client';

import { JOURNAL_LABELS, MANUAL_JOURNALS, type JournalCode } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import {
  canReverse,
  entryOrigin,
  useAccounts,
  type EntryRequestView,
  type EntryView,
} from '@/lib/accounting';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatFcfa, formatShortDate, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';

interface DraftLine {
  key: number;
  accountNumber: string;
  debit: string;
  credit: string;
}

const toAmount = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : 0);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Erreur');

export default function EntriesPage() {
  const { can, me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [rejectingRequest, setRejectingRequest] = useState<EntryRequestView | null>(null);
  const requests = useQuery({
    queryKey: ['accounting', 'entry-requests'],
    queryFn: () => api<EntryRequestView[]>('/accounting/entry-requests?status=PENDING'),
  });
  const approveRequest = useMutation({
    mutationFn: (id: string) =>
      api<EntryView>(`/accounting/entry-requests/${id}/approve`, { method: 'POST' }),
    onSuccess: (e) => {
      toast(`Écriture ${e.reference} validée et enregistrée`);
      void queryClient.invalidateQueries({ queryKey: ['accounting'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const rejectRequest = useMutation({
    mutationFn: (reason: string) =>
      api(`/accounting/entry-requests/${rejectingRequest?.id}/reject`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      setRejectingRequest(null);
      toast('Écriture rejetée');
      void queryClient.invalidateQueries({ queryKey: ['accounting'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [journal, setJournal] = useState('');
  const [creating, setCreating] = useState(false);
  const [reversing, setReversing] = useState<EntryView | null>(null);
  const accounts = useAccounts();
  const labels = useMemo(
    () => new Map((accounts.data ?? []).map((a) => [a.number, a.label])),
    [accounts.data],
  );
  const qs = new URLSearchParams({ from, to, ...(journal ? { journal } : {}) }).toString();
  const q = useQuery({
    queryKey: ['accounting', 'entries', qs],
    queryFn: () => api<EntryView[]>(`/accounting/entries?${qs}`),
    enabled: !!from && !!to,
  });
  const reverse = useMutation({
    mutationFn: (reason: string) =>
      api<EntryView>(`/accounting/entries/${reversing?.id}/reverse`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: (e) => {
      setReversing(null);
      toast(`Contre-passation ${e.reference} enregistrée`);
      void queryClient.invalidateQueries({ queryKey: ['accounting'] });
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <>
      <PageHeader
        title="Écritures"
        subtitle="Partie double, numérotation continue par journal. Correction par contre-passation."
        actions={
          can('accounting.write') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Nouvelle écriture
            </Button>
          ) : null
        }
      />
      {requests.data && requests.data.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-base font-bold">Écritures de trésorerie à valider</h2>
          <p className="text-[13px] text-muted">
            Au-delà du seuil des dépenses, une sortie de caisse, de banque ou de Mobile Money est
            passée seulement après l’accord d’une autre personne.
          </p>
          <ul className="flex flex-col gap-2" aria-label="Écritures à valider">
            {requests.data.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 rounded-[12px] border border-line p-3 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="flex min-w-0 flex-col">
                  <strong className="[overflow-wrap:anywhere]">{r.label}</strong>
                  <span className="text-[13px] text-muted">
                    {formatShortDate(r.date)} ·{' '}
                    {JOURNAL_LABELS[r.journal as JournalCode] ?? r.journal}
                    {r.createdBy ? ` · saisie par ${r.createdBy}` : ''} ·{' '}
                    {r.lines
                      .map(
                        (l) =>
                          `${l.accountNumber} ${l.debit ? 'D' : 'C'} ${formatFcfa(l.debit || l.credit, false)}`,
                      )
                      .join(', ')}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <strong className="tabular">{formatFcfa(r.total)}</strong>
                  {can('accounting.write') && r.createdById !== me?.user.id ? (
                    <Button
                      size="sm"
                      loading={approveRequest.isPending && approveRequest.variables === r.id}
                      onClick={() => approveRequest.mutate(r.id)}
                    >
                      Valider<span className="sr-only"> l’écriture {r.label}</span>
                    </Button>
                  ) : null}
                  {can('accounting.write') ? (
                    <Button size="sm" variant="danger" onClick={() => setRejectingRequest(r)}>
                      Rejeter<span className="sr-only"> l’écriture {r.label}</span>
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <InputField label="Du" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <InputField label="Au" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <SelectField
          label="Journal"
          value={journal}
          onChange={(e) => setJournal(e.target.value)}
          containerClassName="col-span-2 lg:col-span-1"
        >
          <option value="">Tous les journaux</option>
          {Object.entries(JOURNAL_LABELS).map(([code, label]) => (
            <option key={code} value={code}>
              {code} · {label}
            </option>
          ))}
        </SelectField>
      </Card>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Aucune écriture sur la période" />
      ) : (
        <ul className="flex flex-col gap-2">
          {q.data.map((e) => (
            <li key={e.id} className="rounded-[14px] border border-line bg-white p-3 lg:p-4">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="flex min-w-0 flex-1 flex-col">
                  <strong className="tabular">{e.reference}</strong>
                  <span className="text-sm [overflow-wrap:anywhere]">{e.label}</span>
                  <span className="text-[13px] text-muted">
                    {formatShortDate(e.date)} ·{' '}
                    {JOURNAL_LABELS[e.journal as JournalCode] ?? e.journal}
                    {e.pieceRef ? ` · pièce ${e.pieceRef}` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {entryOrigin(e) ? <Badge tone="info">{entryOrigin(e)}</Badge> : null}
                  {e.reversedBy ? (
                    <Badge tone="danger">Contre-passée ({e.reversedBy})</Badge>
                  ) : null}
                  <strong className="tabular">{formatFcfa(e.total)}</strong>
                </div>
              </div>
              {/* Téléphone : lignes empilées. */}
              <ul className="mt-2 flex flex-col divide-y divide-line border-t border-line lg:hidden">
                {e.lines.map((l, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="font-semibold tabular">{l.accountNumber}</span>{' '}
                      <span className="text-muted">{labels.get(l.accountNumber) ?? ''}</span>
                    </span>
                    <span className="shrink-0 tabular">
                      {l.debit
                        ? `D ${formatFcfa(l.debit, false)}`
                        : `C ${formatFcfa(l.credit, false)}`}
                    </span>
                  </li>
                ))}
              </ul>
              {/* Ordinateur : tableau. */}
              <table className="mt-3 hidden w-full text-sm lg:table">
                <caption className="sr-only">Lignes de l’écriture {e.reference}</caption>
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th scope="col" className="py-1 font-semibold">
                      Compte
                    </th>
                    <th scope="col" className="py-1 font-semibold">
                      Intitulé
                    </th>
                    <th scope="col" className="py-1 text-right font-semibold">
                      Débit
                    </th>
                    <th scope="col" className="py-1 text-right font-semibold">
                      Crédit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {e.lines.map((l, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1.5 font-semibold tabular">{l.accountNumber}</td>
                      <td className="py-1.5 text-muted">
                        {l.label ?? labels.get(l.accountNumber) ?? ''}
                      </td>
                      <td className="py-1.5 text-right tabular">
                        {l.debit ? formatFcfa(l.debit, false) : ''}
                      </td>
                      <td className="py-1.5 text-right tabular">
                        {l.credit ? formatFcfa(l.credit, false) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {can('accounting.write') && canReverse(e) ? (
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setReversing(e)}
                  >
                    Contre-passer
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <EntryForm
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(e) => {
          setCreating(false);
          toast(
            e.reference
              ? `Écriture ${e.reference} enregistrée`
              : 'Sortie de trésorerie au-delà du seuil : en attente de validation par une autre personne',
          );
          void queryClient.invalidateQueries({ queryKey: ['accounting'] });
        }}
      />
      <Sheet
        open={!!rejectingRequest}
        onClose={() => setRejectingRequest(null)}
        title="Rejeter cette écriture ?"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            rejectRequest.mutate(String(new FormData(ev.currentTarget).get('reason')));
          }}
        >
          <p className="text-sm text-muted">Aucune écriture n’est passée.</p>
          <InputField label="Motif du rejet" name="reason" required minLength={5} />
          <Button type="submit" variant="danger" loading={rejectRequest.isPending}>
            Rejeter l’écriture
          </Button>
        </form>
      </Sheet>
      <Sheet
        open={!!reversing}
        onClose={() => setReversing(null)}
        title={reversing ? `Contre-passer ${reversing.reference} ?` : 'Contre-passer'}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            reverse.mutate(String(new FormData(ev.currentTarget).get('reason')));
          }}
        >
          <p className="text-sm text-muted">
            L’écriture d’origine reste au journal. Une écriture inverse (débit et crédit échangés)
            est ajoutée à la date du jour.
          </p>
          <InputField label="Motif de la correction" name="reason" required minLength={5} />
          <Button type="submit" loading={reverse.isPending}>
            Enregistrer la contre-passation
          </Button>
        </form>
      </Sheet>
    </>
  );
}

function EntryForm({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (e: { reference: string | null }) => void;
}) {
  const toast = useToast();
  const accounts = useAccounts();
  const postable = (accounts.data ?? []).filter((a) => a.postable);
  const [lines, setLines] = useState<DraftLine[]>([
    { key: 1, accountNumber: '', debit: '', credit: '' },
    { key: 2, accountNumber: '', debit: '', credit: '' },
  ]);
  const totalDebit = lines.reduce((s, l) => s + toAmount(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + toAmount(l.credit), 0);
  const balanced = totalDebit > 0 && totalDebit === totalCredit;
  const update = (key: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const create = useMutation({
    mutationFn: (body: unknown) =>
      api<{ reference: string | null }>('/accounting/entries', { method: 'POST', body }),
    onSuccess: (e) => {
      setLines([
        { key: 1, accountNumber: '', debit: '', credit: '' },
        { key: 2, accountNumber: '', debit: '', credit: '' },
      ]);
      onCreated(e);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  return (
    <Sheet open={open} onClose={onClose} title="Nouvelle écriture">
      <form
        className="flex flex-col gap-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          const data = new FormData(ev.currentTarget);
          const pieceRef = String(data.get('pieceRef') ?? '').trim();
          create.mutate({
            journal: data.get('journal'),
            date: data.get('date'),
            label: data.get('label'),
            ...(pieceRef ? { pieceRef } : {}),
            lines: lines
              .filter((l) => l.accountNumber)
              .map((l) => ({
                accountNumber: l.accountNumber,
                debit: toAmount(l.debit),
                credit: toAmount(l.credit),
              })),
          });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="Journal" name="journal" defaultValue="OD">
            {MANUAL_JOURNALS.map((code) => (
              <option key={code} value={code}>
                {code} · {JOURNAL_LABELS[code]}
              </option>
            ))}
          </SelectField>
          <InputField label="Date" name="date" type="date" defaultValue={todayIso()} required />
        </div>
        <InputField label="Libellé" name="label" required minLength={2} maxLength={200} />
        <InputField label="Pièce justificative" name="pieceRef" optional maxLength={60} />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Lignes</legend>
          {lines.map((l, i) => (
            <div key={l.key} className="flex flex-col gap-2 rounded-[12px] border border-line p-3">
              <SelectField
                label={`Compte (ligne ${i + 1})`}
                value={l.accountNumber}
                onChange={(e) => update(l.key, { accountNumber: e.target.value })}
              >
                <option value="">Choisir un compte</option>
                {postable.map((a) => (
                  <option key={a.number} value={a.number}>
                    {a.number} · {a.label}
                  </option>
                ))}
              </SelectField>
              <div className="grid grid-cols-2 gap-2">
                <InputField
                  label={`Débit (ligne ${i + 1})`}
                  inputMode="numeric"
                  value={l.debit}
                  onChange={(e) => update(l.key, { debit: e.target.value, credit: '' })}
                />
                <InputField
                  label={`Crédit (ligne ${i + 1})`}
                  inputMode="numeric"
                  value={l.credit}
                  onChange={(e) => update(l.key, { credit: e.target.value, debit: '' })}
                />
              </div>
              {lines.length > 2 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-end"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Retirer la ligne {i + 1}
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setLines((ls) => [
                ...ls,
                { key: Date.now(), accountNumber: '', debit: '', credit: '' },
              ])
            }
          >
            <Plus className="size-4" aria-hidden />
            Ajouter une ligne
          </Button>
        </fieldset>
        <p
          className={cn(
            'rounded-[10px] p-3 text-sm font-semibold',
            balanced ? 'bg-primary-soft text-primary' : 'bg-warn-soft text-warn',
          )}
          aria-live="polite"
        >
          Débit {formatFcfa(totalDebit)} · Crédit {formatFcfa(totalCredit)} ·{' '}
          {balanced ? 'Écriture équilibrée' : 'Écriture déséquilibrée'}
        </p>
        <Button type="submit" disabled={!balanced} loading={create.isPending}>
          Enregistrer l’écriture
        </Button>
      </form>
    </Sheet>
  );
}
