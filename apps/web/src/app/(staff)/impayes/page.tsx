'use client';

import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Stat,
} from '@/components/ui/card';
import { SelectField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { formatFcfa, formatShortDate, plural } from '@/lib/format';
import { useClasses } from '@/lib/queries';

interface Unpaid {
  students: {
    student: { id: string; firstName: string; lastName: string; matricule: string };
    class: { id: string; name: string };
    overdue: number;
    outstanding: number;
    oldestDueDate: string | null;
  }[];
  classes: {
    classId: string;
    className: string;
    students: number;
    overdue: number;
    rate: number;
  }[];
}
interface Summary {
  expected: number;
  collected: number;
  recoveryRate: number;
  overdue: number;
  overdueStudents: number;
}

export default function UnpaidPage() {
  const classes = useClasses();
  const [classId, setClassId] = useState('');
  const summary = useQuery({
    queryKey: ['finance-summary'],
    queryFn: () => api<Summary>('/finance/summary'),
  });
  const q = useQuery({
    queryKey: ['unpaid', classId],
    queryFn: () => api<Unpaid>(`/finance/unpaid${classId ? `?classId=${classId}` : ''}`),
  });
  return (
    <>
      <PageHeader
        title="Impayés"
        subtitle="Échéances dépassées et non réglées. Les relances SMS partent automatiquement à J+5, J+15 et J+30."
      />
      {summary.data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Recouvrement" value={`${summary.data.recoveryRate} %`} />
          <Stat label="Encaissé" value={formatFcfa(summary.data.collected, false)} hint="FCFA" />
          <Stat
            label="Impayés échus"
            value={formatFcfa(summary.data.overdue, false)}
            tone="danger"
            hint="FCFA"
          />
          <Stat label="Familles en retard" value={summary.data.overdueStudents} />
        </div>
      ) : null}
      <SelectField
        label="Classe"
        value={classId}
        onChange={(e) => setClassId(e.target.value)}
        containerClassName="sm:max-w-xs"
      >
        <option value="">Toutes les classes</option>
        {classes.data?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_2fr] lg:items-start">
          <Card>
            <CardHeader title="Par classe" />
            <ul className="flex flex-col">
              {q.data.classes.map((c) => (
                <li
                  key={c.classId}
                  className="flex flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0"
                >
                  <div className="flex justify-between gap-2 text-sm">
                    <button
                      type="button"
                      className="font-semibold text-primary"
                      onClick={() => setClassId(c.classId)}
                    >
                      {c.className}
                    </button>
                    <span className="tabular">{c.rate} %</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-neutral-soft">
                    <div className="h-2 bg-primary" style={{ width: `${c.rate}%` }} />
                  </div>
                  <span className="text-xs text-muted">
                    {plural(c.students, 'élève en retard', 'élèves en retard')} ·{' '}
                    {formatFcfa(c.overdue)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          {q.data.students.length === 0 ? (
            <EmptyState title="Aucun impayé échu">Toutes les familles sont à jour.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {q.data.students.map((s) => (
                <li
                  key={s.student.id}
                  className="flex items-center gap-3 rounded-[14px] border border-line bg-white p-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Link
                      href={`/eleves/${s.student.id}`}
                      className="truncate font-semibold hover:underline"
                    >
                      {s.student.lastName} {s.student.firstName}
                    </Link>
                    <span className="text-[13px] text-muted">
                      {s.class.name} · en retard depuis le{' '}
                      {s.oldestDueDate ? formatShortDate(s.oldestDueDate) : '—'}
                    </span>
                  </div>
                  <strong className="text-danger tabular">{formatFcfa(s.overdue)}</strong>
                  <Link
                    href={`/caisse?eleve=${s.student.id}`}
                    aria-label={`Encaisser pour ${s.student.lastName} ${s.student.firstName}`}
                    className="flex size-11 items-center justify-center rounded-[10px] border border-line-strong"
                  >
                    <Wallet className="size-4" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
