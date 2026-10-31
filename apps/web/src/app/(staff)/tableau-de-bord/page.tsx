'use client';

import { formatRate } from '@ecole/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Banknote,
  ChevronRight,
  Download,
  FileText,
  HandCoins,
  NotebookPen,
  Receipt,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock, PageHeader, Stat } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { StartGuide } from '@/components/start-guide';
import { api, ApiError, downloadFile, openPdf } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatFcfa, formatGrade, formatTime, formatWeekday, plural } from '@/lib/format';

interface Dashboard {
  year: { id: string; name: string };
  today: string;
  enrollment: { total: number; girls: number; boys: number; changeFromPreviousYear: number | null };
  attendance: { unjustifiedThisWeek: number; studentsAboveThreshold: number };
  finance: null | {
    expected: number;
    collected: number;
    recoveryRate: number;
    overdue: number;
    overdueStudents: number;
    items: { name: string; dueDate: string; due: number; paid: number; rate: number }[];
    weekly: { weekStart: string; amount: number }[];
    worstClasses: {
      classId: string;
      className: string;
      students: number;
      overdue: number;
      rate: number;
    }[];
  };
  todo: {
    pendingJustifications: number;
    pendingMobileMoney: number;
    cashSessionsToApprove: number;
    gradeSheetsToValidate: number;
    reportCardBatchesToPublish: number;
    expensesToApprove?: number;
    entriesToApprove?: number;
    payrollToValidate?: number;
    advancesToDecide?: number;
    advancesToPay?: number;
  };
  activity: { id: string; at: string; actor: string; label: string }[];
}

interface PassRateCell {
  counted: number;
  passed: number;
  ratePermille: number | null;
  averageCenti: number | null;
  provisional: boolean;
}

interface Results {
  year: { id: string; name: string };
  terms: { id: string; name: string; order: number }[];
  classes: {
    classId: string;
    className: string;
    terms: (PassRateCell | null)[];
    annual: PassRateCell | null;
  }[];
  overall: { terms: (PassRateCell | null)[]; annual: PassRateCell | null };
}

function RateValue({ cell }: { cell: PassRateCell | null }) {
  if (!cell) return <span className="text-muted">—</span>;
  return (
    <span className="tabular">
      <strong>{formatRate(cell.ratePermille)}</strong>
      {cell.provisional ? (
        <abbr title="Provisoire : bulletins non publiés" className="ml-0.5 text-warn no-underline">
          *
        </abbr>
      ) : null}
      <span className="block text-xs text-muted">
        {cell.passed}/{cell.counted} · moy. {formatGrade(cell.averageCenti)}
      </span>
    </span>
  );
}

/** Taux de réussite (moyenne d'au moins 10/20) par classe, par trimestre et sur l'année. */
function PassRates() {
  const q = useQuery({
    queryKey: ['dashboard-results'],
    queryFn: () => api<Results>('/dashboard/results'),
  });
  if (q.isPending) return <LoadingBlock label="Chargement des résultats…" />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  const periods = [...r.terms.map((t) => t.name), 'Année'];
  const rows = r.classes.filter((c) => [...c.terms, c.annual].some(Boolean));
  const overall = [...r.overall.terms, r.overall.annual];
  const provisional = [...overall, ...rows.flatMap((c) => [...c.terms, c.annual])].some(
    (c) => c?.provisional,
  );
  return (
    <Card>
      <CardHeader
        title="Taux de réussite"
        subtitle="Élèves ayant au moins 10/20 de moyenne, d’après les bulletins"
      />
      <ul
        className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
        aria-label="Taux de l’établissement"
      >
        {periods.map((p, i) => (
          <li key={p} className="rounded-[12px] bg-paper p-3">
            <span className="block text-[13px] text-muted">{p}</span>
            <RateValue cell={overall[i] ?? null} />
          </li>
        ))}
      </ul>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">
          Aucun bulletin préparé pour l’instant : les taux apparaîtront avec les premiers bulletins.
        </p>
      ) : (
        <>
          {/* Téléphone : une carte par classe. */}
          <ul className="flex flex-col gap-2 lg:hidden">
            {rows.map((c) => (
              <li key={c.classId} className="rounded-[12px] border border-line p-3">
                <strong>{c.className}</strong>
                <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  {periods.map((p, i) => (
                    <div key={p}>
                      <dt className="text-[13px] text-muted">{p}</dt>
                      <dd>
                        <RateValue cell={[...c.terms, c.annual][i] ?? null} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          {/* Ordinateur : tableau. */}
          <table className="hidden w-full text-sm lg:table">
            <caption className="sr-only">Taux de réussite par classe</caption>
            <thead>
              <tr className="text-left text-xs text-muted">
                <th scope="col" className="py-2 font-semibold">
                  Classe
                </th>
                {periods.map((p) => (
                  <th key={p} scope="col" className="py-2 text-right font-semibold">
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.classId} className="border-t border-line">
                  <th scope="row" className="py-2 text-left font-semibold">
                    {c.className}
                  </th>
                  {[...c.terms, c.annual].map((cell, i) => (
                    <td key={periods[i]} className="py-2 text-right">
                      <RateValue cell={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {provisional ? (
        <p className="mt-3 text-[13px] text-muted">
          * Provisoire : calculé sur des bulletins préparés mais pas encore publiés.
        </p>
      ) : null}
    </Card>
  );
}

const shortDay = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

type Weekly = NonNullable<Dashboard['finance']>['weekly'];

function WeeklyChart({ weeks }: { weeks: Weekly }) {
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(1, ...weeks.map((w) => w.amount));
  return (
    <Card>
      <CardHeader
        title="Encaissements par semaine"
        subtitle="Toutes méthodes confondues, en FCFA"
        action={
          <button
            type="button"
            onClick={() => setAsTable((v) => !v)}
            className="min-h-11 rounded-[9px] border border-line-strong px-3 text-[13px] font-semibold lg:min-h-9"
          >
            {asTable ? 'Graphique' : 'Tableau'}
          </button>
        }
      />
      {asTable ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-2 font-semibold">Semaine du</th>
              <th className="py-2 text-right font-semibold">Encaissé</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.weekStart} className="border-t border-line">
                <td className="py-2">{shortDay.format(new Date(`${w.weekStart}T00:00:00Z`))}</td>
                <td className="py-2 text-right tabular">{formatFcfa(w.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <figure className="m-0">
          <div
            className="flex h-44 items-end gap-1 border-b border-[#8a928d] lg:h-52"
            role="img"
            aria-label="Histogramme des encaissements hebdomadaires ; utilisez le bouton Tableau pour les montants exacts."
          >
            {weeks.map((w, i) => {
              const last = i === weeks.length - 1;
              return (
                <div
                  key={w.weekStart}
                  className="group relative flex h-full flex-1 items-end justify-center"
                  title={`${shortDay.format(new Date(`${w.weekStart}T00:00:00Z`))} : ${formatFcfa(w.amount)}`}
                >
                  <div
                    className="w-[70%] max-w-12 rounded-t-[4px] bg-primary group-hover:bg-primary-hover"
                    style={{ height: `${Math.max(2, (w.amount / max) * 100)}%` }}
                  />
                  {last || w.amount === max ? (
                    <span
                      className="absolute text-[11px] font-semibold whitespace-nowrap tabular"
                      style={{ bottom: `${Math.max(2, (w.amount / max) * 100) + 2}%` }}
                    >
                      {(w.amount / 1_000_000).toFixed(1).replace('.', ',')} M
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="mt-1.5 flex gap-1 text-center text-[11px] text-muted">
            {weeks.map((w, i) => (
              <span key={w.weekStart} className="flex-1 truncate">
                {i % 2 === weeks.length % 2
                  ? shortDay.format(new Date(`${w.weekStart}T00:00:00Z`))
                  : ''}
              </span>
            ))}
          </div>
        </figure>
      )}
    </Card>
  );
}

export default function DashboardPage() {
  const { me, can } = useAuth();
  const toast = useToast();
  // École neuve sans année scolaire en cours : guide de démarrage au lieu d'une erreur.
  const noYear = !!me?.activeSchool && !me.activeSchool.currentYear;
  const q = useQuery({
    queryKey: ['dashboard', me?.activeSchool?.currentYear?.id ?? null],
    queryFn: () => api<Dashboard>('/dashboard'),
    enabled: !noYear,
  });
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'Erreur', 'error');
  if (noYear || (q.error instanceof ApiError && q.error.code === 'NO_CURRENT_YEAR'))
    return <StartGuide />;
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  // Libellés accordés au nombre : « 1 clôture de caisse à approuver », « 2 clôtures… ».
  const todos = [
    {
      n: d.todo.gradeSheetsToValidate,
      label: (n: number) => (n > 1 ? 'grilles de notes à valider' : 'grille de notes à valider'),
      href: '/notes',
      icon: FileText,
    },
    {
      n: d.todo.reportCardBatchesToPublish,
      label: (n: number) => (n > 1 ? 'lots de bulletins à publier' : 'lot de bulletins à publier'),
      href: '/bulletins',
      icon: FileText,
    },
    {
      n: d.todo.pendingJustifications,
      label: (n: number) => (n > 1 ? 'justificatifs d’absence' : 'justificatif d’absence'),
      href: '/presences/justificatifs',
      icon: ShieldCheck,
    },
    {
      n: d.todo.pendingMobileMoney,
      label: (n: number) =>
        n > 1
          ? 'paiements Mobile Money en attente depuis plus de 2 h'
          : 'paiement Mobile Money en attente depuis plus de 2 h',
      href: '/caisse/journal',
      icon: Receipt,
    },
    {
      n: d.todo.cashSessionsToApprove,
      label: (n: number) =>
        n > 1 ? 'clôtures de caisse à approuver' : 'clôture de caisse à approuver',
      href: '/caisse/clotures',
      icon: Wallet,
    },
    {
      n: d.todo.expensesToApprove ?? 0,
      label: (n: number) => (n > 1 ? 'dépenses à valider' : 'dépense à valider'),
      href: '/comptabilite/depenses',
      icon: HandCoins,
    },
    {
      n: d.todo.entriesToApprove ?? 0,
      label: (n: number) =>
        n > 1 ? 'écritures de trésorerie à valider' : 'écriture de trésorerie à valider',
      href: '/comptabilite/ecritures',
      icon: NotebookPen,
    },
    {
      n: d.todo.payrollToValidate ?? 0,
      label: (n: number) => (n > 1 ? 'paies à valider' : 'paie à valider'),
      href: '/rh/paie',
      icon: Banknote,
    },
    {
      n: d.todo.advancesToDecide ?? 0,
      label: (n: number) =>
        n > 1
          ? 'demandes d’avance sur salaire à accorder'
          : 'demande d’avance sur salaire à accorder',
      href: '/rh/avances',
      icon: HandCoins,
    },
    {
      n: d.todo.advancesToPay ?? 0,
      label: (n: number) => (n > 1 ? 'avances accordées à verser' : 'avance accordée à verser'),
      href: '/rh/avances',
      icon: HandCoins,
    },
  ].filter((t) => t.n > 0);

  return (
    <>
      <PageHeader
        title={`Bonjour, ${me?.user.firstName ?? ''}`}
        subtitle={`${formatWeekday(d.today).replace(/^./, (c) => c.toUpperCase())} · ${d.year.name}`}
        actions={
          <>
            {me?.permissions.includes('students.write') ? (
              <ButtonLink href="/eleves/nouveau" variant="secondary">
                Nouvelle inscription
              </ButtonLink>
            ) : null}
            {me?.permissions.includes('finance.payments.create') ? (
              <ButtonLink href="/caisse">Encaisser</ButtonLink>
            ) : null}
            <Button
              variant="secondary"
              onClick={() =>
                downloadFile('/dashboard/export.xlsx', `indicateurs-${d.year.name}.xlsx`).catch(
                  fail,
                )
              }
            >
              <Download className="size-4" aria-hidden />
              Exporter Excel
            </Button>
            <Button
              variant="secondary"
              onClick={() => openPdf('/dashboard/export.pdf').catch(fail)}
            >
              <FileText className="size-4" aria-hidden />
              Exporter PDF
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <Stat
          label="Effectif"
          value={d.enrollment.total.toLocaleString('fr-FR')}
          hint={`${d.enrollment.girls} filles · ${d.enrollment.boys} garçons`}
        />
        {d.finance ? (
          <>
            <Stat
              label="Recouvrement"
              value={`${d.finance.recoveryRate} %`}
              hint={`${formatFcfa(d.finance.collected, false)} / ${formatFcfa(d.finance.expected)}`}
            />
            <Stat
              label="Impayés échus"
              value={formatFcfa(d.finance.overdue, false)}
              tone="danger"
              hint={`FCFA · ${plural(d.finance.overdueStudents, 'élève', 'élèves')}`}
            />
          </>
        ) : null}
        <Stat
          label="Absences non justifiées · semaine"
          value={d.attendance.unjustifiedThisWeek}
          hint={`${plural(d.attendance.studentsAboveThreshold, 'élève', 'élèves')} au-dessus du seuil`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        {d.finance ? <WeeklyChart weeks={d.finance.weekly} /> : null}
        <Card className={d.finance ? '' : 'lg:col-span-2'}>
          <CardHeader title="À traiter" />
          {todos.length === 0 ? (
            <p className="text-sm text-muted">Rien en attente. Tout est à jour.</p>
          ) : (
            <ul className="flex flex-col">
              {todos.map((t) => (
                <li key={t.label(2)} className="border-t border-line first:border-t-0">
                  <Link href={t.href} className="flex min-h-14 items-center gap-3 py-2">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
                      <t.icon className="size-4" aria-hidden />
                    </span>
                    <span className="flex-1 text-[15px] lg:text-sm">
                      <strong className="tabular">{t.n}</strong> {t.label(t.n)}
                    </span>
                    <ChevronRight className="size-4 text-muted" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {d.finance ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Recouvrement par échéance" />
            <ul className="flex flex-col gap-3">
              {d.finance.items.map((i) => (
                <li key={i.name} className="flex flex-col gap-1.5">
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="font-semibold">{i.name}</span>
                    <span className="tabular">{i.rate} %</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-neutral-soft">
                    <div className="h-2 bg-primary" style={{ width: `${i.rate}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader
              title="Classes les moins à jour"
              action={
                <Link href="/impayes" className="text-sm font-semibold text-primary">
                  Tous les impayés
                </Link>
              }
            />
            <ul className="flex flex-col">
              {d.finance.worstClasses.map((c) => (
                <li
                  key={c.classId}
                  className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0"
                >
                  <span className="w-16 font-semibold">{c.className}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-soft">
                    <div className="h-2 bg-primary" style={{ width: `${c.rate}%` }} />
                  </div>
                  <span className="w-12 text-right text-sm tabular">{c.rate} %</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      {can('reportcards.read') && me?.activeSchool?.modules.includes('grades') ? (
        <PassRates />
      ) : null}

      <Card>
        <CardHeader
          title="Activité récente"
          action={
            me?.permissions.includes('audit.read') ? (
              <Link href="/parametres#audit" className="text-sm font-semibold text-primary">
                Journal d’audit
              </Link>
            ) : undefined
          }
        />
        {d.activity.length === 0 ? (
          <p className="text-sm text-muted">Aucune activité pour l’instant.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {d.activity.map((a) => (
              <li key={a.id} className="flex gap-3 text-sm">
                <span className="w-12 shrink-0 text-muted tabular">{formatTime(a.at)}</span>
                <span>
                  <strong className="font-semibold">{a.actor}</strong> {a.label}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
