'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, Upload, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Badge, ENROLLMENT_BADGE } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { controlClass } from '@/components/ui/field';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatCameroonPhone, formatFcfa, initials, plural } from '@/lib/format';
import { useClasses } from '@/lib/queries';
import type { Paged, StudentListItem } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUSES = [
  ['', 'Tous'],
  ['ENROLLED', 'Inscrits'],
  ['REPEATING', 'Redoublants'],
  ['TRANSFERRED', 'Transférés'],
  ['LEFT', 'Sortis'],
] as const;

function StudentsContent() {
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const status = params.get('statut') ?? '';
  const classId = params.get('classe') ?? '';
  const page = Number(params.get('page') ?? '1') || 1;
  const classes = useClasses();

  const setParam = (updates: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in updates)) next.delete('page');
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  useEffect(() => {
    const id = setTimeout(() => {
      if ((params.get('q') ?? '') !== search) setParam({ q: search });
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const query = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (params.get('q')) query.set('search', params.get('q') ?? '');
  if (status) query.set('status', status);
  if (classId) query.set('classId', classId);
  const q = useQuery({
    queryKey: ['students', query.toString()],
    queryFn: () =>
      api<Paged<StudentListItem> & { counts: Record<string, number> }>(
        `/students?${query.toString()}`,
      ),
    placeholderData: keepPreviousData,
  });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  const totalAll = q.data ? Object.values(q.data.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <PageHeader
        title="Élèves"
        subtitle={
          q.data ? `${plural(totalAll, 'élève inscrit', 'élèves inscrits')} cette année` : undefined
        }
        actions={
          can('students.write') ? (
            <>
              <ButtonLink href="/eleves/import" variant="secondary">
                <Upload className="size-4" aria-hidden />
                Importer
              </ButtonLink>
              <ButtonLink href="/eleves/nouveau">
                <UserPlus className="size-4" aria-hidden />
                Inscrire
              </ButtonLink>
            </>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <label className="flex h-12 items-center gap-2 rounded-[10px] border border-line-strong bg-white px-3 lg:h-10 lg:flex-1">
          <Search className="size-4 text-muted" aria-hidden />
          <span className="sr-only">Rechercher</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nom, matricule ou téléphone du parent"
            className="h-full flex-1 bg-transparent text-base outline-none lg:text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 lg:w-56">
          <span className="sr-only">Classe</span>
          <select
            className={cn(controlClass, 'h-12 lg:h-10')}
            value={classId}
            onChange={(e) => setParam({ classe: e.target.value })}
          >
            <option value="">Toutes les classes</option>
            {classes.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        role="group"
        aria-label="Filtrer par statut"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0"
      >
        {STATUSES.map(([value, label]) => {
          const on = status === value;
          const count = value ? (q.data?.counts[value] ?? 0) : totalAll;
          return (
            <button
              key={value || 'all'}
              type="button"
              aria-pressed={on}
              onClick={() => setParam({ statut: value })}
              className={cn(
                'flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-semibold lg:min-h-9',
                on
                  ? 'border-primary bg-primary text-white'
                  : 'border-line-strong bg-white text-ink',
              )}
            >
              {label}
              <span className={cn('tabular', on ? 'text-[#d7ebe1]' : 'text-muted')}>{count}</span>
            </button>
          );
        })}
      </div>

      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="Aucun élève ne correspond">
          Modifiez la recherche ou les filtres.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2 md:hidden">
            {q.data.items.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/eleves/${s.id}`}
                  className="flex items-center gap-3 rounded-[14px] border border-line bg-white p-3"
                >
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary">
                    {initials(`${s.lastName} ${s.firstName}`)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="truncate text-[15px]">
                      {s.lastName} {s.firstName}
                    </strong>
                    <span className="truncate text-[13px] text-muted tabular">
                      {s.class?.name ?? 'Non inscrit'} · {s.matricule}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {s.status ? (
                      <Badge tone={ENROLLMENT_BADGE[s.status].tone}>
                        {ENROLLMENT_BADGE[s.status].label}
                      </Badge>
                    ) : null}
                    {s.overdue ? (
                      <span className="text-[13px] font-semibold text-danger tabular">
                        {formatFcfa(s.overdue)}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-[14px] border border-line bg-white md:block">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-paper text-left text-xs tracking-[0.06em] text-muted uppercase">
                <tr>
                  <th className="px-4 py-3 font-semibold">Élève</th>
                  <th className="px-3 py-3 font-semibold">Classe</th>
                  <th className="px-3 py-3 font-semibold">Parent principal</th>
                  <th className="px-3 py-3 font-semibold">Statut</th>
                  <th className="px-3 py-3 text-right font-semibold">Échu</th>
                  <th className="px-4 py-3 text-right font-semibold">Absences</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((s) => (
                  <tr key={s.id} className="border-t border-line hover:bg-paper/60">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="flex size-9 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary">
                          {initials(`${s.lastName} ${s.firstName}`)}
                        </span>
                        <div className="flex flex-col">
                          <Link href={`/eleves/${s.id}`} className="font-semibold hover:underline">
                            {s.lastName} {s.firstName}
                          </Link>
                          <span className="text-xs text-muted tabular">{s.matricule}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-semibold">{s.class?.name ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      {s.guardian ? (
                        <div className="flex flex-col">
                          <span>{s.guardian.name}</span>
                          <span className="text-xs text-muted tabular">
                            {formatCameroonPhone(s.guardian.phone)}
                          </span>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {s.status ? (
                        <Badge tone={ENROLLMENT_BADGE[s.status].tone}>
                          {ENROLLMENT_BADGE[s.status].label}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular">
                      {s.overdue === null ? (
                        '—'
                      ) : s.overdue > 0 ? (
                        <span className="font-semibold text-danger">{formatFcfa(s.overdue)}</span>
                      ) : (
                        <span className="text-muted">À jour</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular">{s.absences}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted tabular">
              Page {page} sur {pages} · {plural(q.data.total, 'élève', 'élèves')}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="icon"
                aria-label="Page précédente"
                disabled={page <= 1}
                onClick={() => setParam({ page: String(page - 1) })}
              >
                <ChevronLeft className="size-5" aria-hidden />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Page suivante"
                disabled={page >= pages}
                onClick={() => setParam({ page: String(page + 1) })}
              >
                <ChevronRight className="size-5" aria-hidden />
              </Button>
            </div>
          </nav>
        </>
      )}
    </>
  );
}

export default function StudentsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <StudentsContent />
    </Suspense>
  );
}
