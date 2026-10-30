'use client';

import {
  ACCOUNTING_REPORT_LABELS,
  ACCOUNTING_REPORTS,
  JOURNAL_LABELS,
  type AccountingReport,
  type BalanceSheet,
  type GeneralLedgerAccount,
  type IncomeStatement,
  type StatementGroup,
  type TrialBalance,
} from '@ecole/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api, downloadFile, openPdf } from '@/lib/api';
import { formatFcfa, formatShortDate, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ReportHead {
  title: string;
  school: string;
  from: string;
  to: string;
  fiscalYear: { name: string; status: string };
}

interface JournalEntry {
  reference: string;
  journal: string;
  date: string;
  label: string;
  pieceRef: string | null;
  lines: { accountNumber: string; label: string | null; debit: number; credit: number }[];
}

type Report = ReportHead &
  (
    | { kind: 'journal'; entries: JournalEntry[]; totals: { debit: number; credit: number } }
    | { kind: 'grand-livre'; accounts: GeneralLedgerAccount[] }
    | { kind: 'balance'; balance: TrialBalance }
    | { kind: 'compte-de-resultat'; statement: IncomeStatement }
    | { kind: 'bilan'; sheet: BalanceSheet }
  );

const money = (n: number) => formatFcfa(n, false);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Erreur');

export default function ReportsPage() {
  const toast = useToast();
  const [kind, setKind] = useState<AccountingReport>('balance');
  const [from, setFrom] = useState(`${todayIso().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [journal, setJournal] = useState('');
  const [account, setAccount] = useState('');
  const params = new URLSearchParams({ from, to });
  if (kind === 'journal' && journal) params.set('journal', journal);
  if (kind === 'grand-livre' && /^\d{1,10}$/.test(account)) params.set('account', account);
  const qs = params.toString();
  const q = useQuery({
    queryKey: ['accounting', 'report', kind, qs],
    queryFn: () => api<Report>(`/accounting/reports/${kind}?${qs}`),
    enabled: !!from && !!to,
    retry: false,
  });

  return (
    <>
      <PageHeader
        title="États financiers"
        subtitle={
          q.data ? `${q.data.fiscalYear.name} · ${q.data.school}` : 'Grand livre, balance, bilan'
        }
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() =>
                downloadFile(
                  `/accounting/reports/${kind}/export.xlsx?${qs}`,
                  `${kind}-${from}-${to}.xlsx`,
                ).catch((e) => toast(errorMessage(e), 'error'))
              }
            >
              <Download className="size-4" aria-hidden />
              Excel
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                openPdf(`/accounting/reports/${kind}/export.pdf?${qs}`).catch((e) =>
                  toast(errorMessage(e), 'error'),
                )
              }
            >
              <FileText className="size-4" aria-hidden />
              PDF
            </Button>
          </>
        }
      />
      <Card className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SelectField
          label="État"
          value={kind}
          onChange={(e) => setKind(e.target.value as AccountingReport)}
          containerClassName="col-span-2 lg:col-span-1"
        >
          {ACCOUNTING_REPORTS.map((k) => (
            <option key={k} value={k}>
              {ACCOUNTING_REPORT_LABELS[k]}
            </option>
          ))}
        </SelectField>
        <InputField label="Du" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <InputField label="Au" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {kind === 'journal' ? (
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
        ) : kind === 'grand-livre' ? (
          <InputField
            label="Compte"
            value={account}
            inputMode="numeric"
            optional
            hint="Ex. 571 pour la caisse"
            onChange={(e) => setAccount(e.target.value.replace(/\D/g, ''))}
            containerClassName="col-span-2 lg:col-span-1"
          />
        ) : null}
      </Card>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <ReportView report={q.data} />
      )}
    </>
  );
}

function ReportView({ report: r }: { report: Report }) {
  const period = `Du ${formatShortDate(r.from)} au ${formatShortDate(r.to)}`;
  switch (r.kind) {
    case 'balance':
      return <BalanceView balance={r.balance} period={period} />;
    case 'compte-de-resultat':
      return <IncomeView s={r.statement} period={period} />;
    case 'bilan':
      return <SheetView s={r.sheet} period={`Au ${formatShortDate(r.to)}`} />;
    case 'grand-livre':
      return <LedgerView accounts={r.accounts} period={period} />;
    case 'journal':
      return <JournalView title={r.title} entries={r.entries} totals={r.totals} period={period} />;
  }
}

function Amount({ value, className }: { value: number; className?: string }) {
  return <span className={cn('tabular', className)}>{value ? money(value) : ''}</span>;
}

function BalanceView({ balance, period }: { balance: TrialBalance; period: string }) {
  if (balance.rows.length === 0) return <EmptyState title="Aucun mouvement sur la période" />;
  const t = balance.totals;
  return (
    <Card>
      <CardHeader title="Balance générale" subtitle={period} />
      {/* Téléphone : cartes empilées. */}
      <ul className="flex flex-col divide-y divide-line lg:hidden">
        {balance.rows.map((r) => (
          <li key={r.accountNumber} className="flex items-baseline justify-between gap-3 py-2">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="font-semibold tabular">{r.accountNumber}</span>{' '}
              <span className="text-sm text-muted">{r.label}</span>
            </span>
            <span className="shrink-0 text-sm tabular">
              {r.balanceDebit
                ? `D ${money(r.balanceDebit)}`
                : r.balanceCredit
                  ? `C ${money(r.balanceCredit)}`
                  : 'Soldé'}
            </span>
          </li>
        ))}
        <li className="flex justify-between gap-3 py-2 font-bold">
          <span>Totaux</span>
          <span className="tabular">
            D {money(t.balanceDebit)} · C {money(t.balanceCredit)}
          </span>
        </li>
      </ul>
      {/* Ordinateur : tableau. */}
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Balance générale · {period}</caption>
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="py-2 font-semibold">
                Compte
              </th>
              <th scope="col" className="py-2 font-semibold">
                Intitulé
              </th>
              {[
                'Ouverture débit',
                'Ouverture crédit',
                'Mouvements débit',
                'Mouvements crédit',
                'Solde débiteur',
                'Solde créditeur',
              ].map((h) => (
                <th key={h} scope="col" className="py-2 text-right font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {balance.rows.map((r) => (
              <tr key={r.accountNumber} className="border-t border-line">
                <th scope="row" className="py-1.5 text-left font-semibold tabular">
                  {r.accountNumber}
                </th>
                <td className="py-1.5 text-muted">{r.label}</td>
                {[
                  r.openingDebit,
                  r.openingCredit,
                  r.debit,
                  r.credit,
                  r.balanceDebit,
                  r.balanceCredit,
                ].map((v, i) => (
                  <td key={i} className="py-1.5 text-right">
                    <Amount value={v} />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t-2 border-line-strong font-bold">
              <th scope="row" colSpan={2} className="py-2 text-left">
                Totaux
              </th>
              {[
                t.openingDebit,
                t.openingCredit,
                t.debit,
                t.credit,
                t.balanceDebit,
                t.balanceCredit,
              ].map((v, i) => (
                <td key={i} className="py-2 text-right tabular">
                  {money(v)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function GroupList({
  title,
  groups,
  total,
  totalLabel,
}: {
  title: string;
  groups: StatementGroup[];
  total: number;
  totalLabel: string;
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <dl className="flex flex-col divide-y divide-line">
        {groups.length === 0 ? <p className="py-2 text-sm text-muted">Aucun montant</p> : null}
        {groups.map((g) => (
          <div key={g.code} className="flex items-baseline justify-between gap-3 py-2">
            <dt className="min-w-0 text-sm [overflow-wrap:anywhere]">
              {/^\d+$/.test(g.code) ? (
                <span className="font-semibold tabular">{g.code} </span>
              ) : null}
              {g.label}
            </dt>
            <dd className="shrink-0 tabular">{formatFcfa(g.amount)}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 py-2 font-bold">
          <dt>{totalLabel}</dt>
          <dd className="tabular">{formatFcfa(total)}</dd>
        </div>
      </dl>
    </Card>
  );
}

function IncomeView({ s, period }: { s: IncomeStatement; period: string }) {
  return (
    <>
      <p className="text-sm text-muted">{period}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <GroupList
          title="Produits"
          groups={s.products}
          total={s.totalProducts}
          totalLabel="Total des produits"
        />
        <GroupList
          title="Charges"
          groups={s.charges}
          total={s.totalCharges}
          totalLabel="Total des charges"
        />
      </div>
      <ResultBanner label={s.result >= 0 ? 'Bénéfice' : 'Perte'} value={s.result} />
    </>
  );
}

function SheetView({ s, period }: { s: BalanceSheet; period: string }) {
  return (
    <>
      <p className="text-sm text-muted">{period}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <GroupList title="Actif" groups={s.assets} total={s.totalAssets} totalLabel="Total actif" />
        <GroupList
          title="Passif"
          groups={s.liabilities}
          total={s.totalLiabilities}
          totalLabel="Total passif"
        />
      </div>
      <ResultBanner
        label={s.totalAssets === s.totalLiabilities ? 'Bilan équilibré' : 'Bilan déséquilibré'}
        value={s.totalAssets}
      />
    </>
  );
}

function ResultBanner({ label, value }: { label: ReactNode; value: number }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-[14px] p-4 font-bold',
        value < 0 ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-primary',
      )}
    >
      <span>{label}</span>
      <span className="font-display text-xl tabular">{formatFcfa(value)}</span>
    </div>
  );
}

function LedgerView({ accounts, period }: { accounts: GeneralLedgerAccount[]; period: string }) {
  if (accounts.length === 0) return <EmptyState title="Aucun mouvement sur la période" />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{period} · solde positif = débiteur</p>
      {accounts.map((a) => (
        <Card key={a.accountNumber}>
          <CardHeader
            title={`${a.accountNumber} · ${a.label}`}
            subtitle={`Ouverture ${formatFcfa(a.opening)} · clôture ${formatFcfa(a.closing)}`}
          />
          <ul className="flex flex-col divide-y divide-line lg:hidden">
            {a.lines.map((l, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {formatShortDate(l.date)} · {l.label}
                </span>
                <span className="shrink-0 tabular">
                  {l.debit ? `D ${money(l.debit)}` : `C ${money(l.credit)}`}
                </span>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-sm">
              <caption className="sr-only">Grand livre du compte {a.accountNumber}</caption>
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th scope="col" className="py-1 font-semibold">
                    Date
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    Écriture
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    Libellé
                  </th>
                  <th scope="col" className="py-1 text-right font-semibold">
                    Débit
                  </th>
                  <th scope="col" className="py-1 text-right font-semibold">
                    Crédit
                  </th>
                  <th scope="col" className="py-1 text-right font-semibold">
                    Solde
                  </th>
                </tr>
              </thead>
              <tbody>
                {a.lines.map((l, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="py-1.5 tabular">{formatShortDate(l.date)}</td>
                    <td className="py-1.5 tabular">{l.reference}</td>
                    <td className="py-1.5">{l.label}</td>
                    <td className="py-1.5 text-right">
                      <Amount value={l.debit} />
                    </td>
                    <td className="py-1.5 text-right">
                      <Amount value={l.credit} />
                    </td>
                    <td className="py-1.5 text-right tabular">{money(l.balance)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-line-strong font-bold">
                  <th scope="row" colSpan={3} className="py-2 text-left">
                    Totaux
                  </th>
                  <td className="py-2 text-right tabular">{money(a.totalDebit)}</td>
                  <td className="py-2 text-right tabular">{money(a.totalCredit)}</td>
                  <td className="py-2 text-right tabular">{money(a.closing)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

function JournalView({
  title,
  entries,
  totals,
  period,
}: {
  title: string;
  entries: JournalEntry[];
  totals: { debit: number; credit: number };
  period: string;
}) {
  if (entries.length === 0) return <EmptyState title="Aucune écriture sur la période" />;
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={`${period} · ${money(totals.debit)} au débit, ${money(totals.credit)} au crédit`}
      />
      <ul className="flex flex-col gap-2 lg:hidden">
        {entries.map((e) => (
          <li key={e.reference} className="rounded-[12px] border border-line p-3 text-sm">
            <strong className="tabular">{e.reference}</strong>
            <p className="[overflow-wrap:anywhere]">{e.label}</p>
            <p className="text-[13px] text-muted">{formatShortDate(e.date)}</p>
            {e.lines.map((l, i) => (
              <p key={i} className="flex justify-between gap-3 tabular">
                <span>{l.accountNumber}</span>
                <span>{l.debit ? `D ${money(l.debit)}` : `C ${money(l.credit)}`}</span>
              </p>
            ))}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {title} · {period}
          </caption>
          <thead>
            <tr className="text-left text-xs text-muted">
              {['Date', 'Écriture', 'Pièce', 'Compte', 'Libellé'].map((h) => (
                <th key={h} scope="col" className="py-1 font-semibold">
                  {h}
                </th>
              ))}
              <th scope="col" className="py-1 text-right font-semibold">
                Débit
              </th>
              <th scope="col" className="py-1 text-right font-semibold">
                Crédit
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.flatMap((e) =>
              e.lines.map((l, i) => (
                <tr key={`${e.reference}-${i}`} className={cn(i === 0 && 'border-t border-line')}>
                  <td className="py-1 tabular">{i === 0 ? formatShortDate(e.date) : ''}</td>
                  <td className="py-1 tabular">{i === 0 ? e.reference : ''}</td>
                  <td className="py-1">{i === 0 ? (e.pieceRef ?? '') : ''}</td>
                  <td className="py-1 tabular">{l.accountNumber}</td>
                  <td className="py-1">{l.label ?? e.label}</td>
                  <td className="py-1 text-right">
                    <Amount value={l.debit} />
                  </td>
                  <td className="py-1 text-right">
                    <Amount value={l.credit} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
