'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INCIDENT_TYPE_LABELS,
  INCIDENT_TYPES,
  SANCTION_TYPE_LABELS,
  SANCTION_TYPES,
  type IncidentType,
  type SanctionType,
} from '@ecole/shared';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  Stat,
} from '@/components/ui/card';
import { InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { StudentPicker, type PickedStudent } from '@/components/ui/student-picker';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatShortDate, plural, todayIso } from '@/lib/format';
import { useClasses } from '@/lib/queries';
import type { Paged } from '@/lib/types';

interface IncidentRow {
  id: string;
  date: string;
  type: IncidentType;
  typeLabel: string;
  description: string;
  sanctionType: SanctionType;
  sanctionLabel: string;
  sanction: string | null;
  student: { id: string; firstName: string; lastName: string; matricule: string } | null;
  class: { id: string; name: string } | null;
  reportedBy: string | null;
}

interface Stats {
  total: number;
  students: number;
  sanctioned: number;
  byType: { type: IncidentType; count: number }[];
  bySanction: { sanctionType: SanctionType; count: number }[];
  byMonth: { month: string; count: number }[];
  byClass: { classId: string | null; className: string; count: number }[];
  repeatStudents: {
    studentId: string;
    count: number;
    student: { id: string; firstName: string; lastName: string } | null;
    class: { id: string; name: string } | null;
  }[];
}

const monthFmt = new Intl.DateTimeFormat('fr-FR', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthLabel = (m: string) => monthFmt.format(new Date(`${m}-01T00:00:00Z`));

function Bars({ rows }: { rows: { key: string; label: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) return <p className="text-sm text-muted">Aucune donnée sur la période.</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <div className="flex justify-between gap-2 text-sm">
            <span className="font-semibold">{r.label}</span>
            <span className="tabular">{r.count}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-neutral-soft" aria-hidden>
            <div className="h-2 bg-primary" style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function sanctionTone(s: SanctionType) {
  if (s === 'NONE') return 'neutral' as const;
  if (s === 'WARNING' || s === 'DETENTION') return 'warn' as const;
  return 'danger' as const;
}

function NewIncidentSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const empty = {
    date: todayIso(),
    type: 'INDISCIPLINE' as IncidentType,
    description: '',
    sanctionType: 'NONE' as SanctionType,
    sanction: '',
  };
  const [student, setStudent] = useState<PickedStudent | null>(null);
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const reset = () => {
    setStudent(null);
    setForm({ ...empty, date: todayIso() });
    setErrors({});
  };
  const create = useMutation({
    mutationFn: () =>
      api('/discipline/incidents', {
        method: 'POST',
        body: { ...form, studentId: student?.id, sanction: form.sanction || undefined },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      void queryClient.invalidateQueries({ queryKey: ['incident-stats'] });
      toast('Incident enregistré au registre');
      reset();
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length > 0)
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Signaler un incident"
      footer={
        <Button
          block
          onClick={() => create.mutate()}
          loading={create.isPending}
          disabled={!student || form.description.trim().length < 3}
        >
          Enregistrer l’incident
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <StudentPicker value={student} onChange={setStudent} />
        <div className="grid gap-4 sm:grid-cols-2">
          <InputField
            label="Date"
            type="date"
            value={form.date}
            max={todayIso()}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            error={errors.date}
          />
          <SelectField
            label="Type d’incident"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as IncidentType })}
          >
            {INCIDENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {INCIDENT_TYPE_LABELS[t]}
              </option>
            ))}
          </SelectField>
        </div>
        <TextareaField
          label="Description"
          value={form.description}
          maxLength={1000}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          error={errors.description}
          hint="Faits constatés, lieu, témoins."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Sanction"
            value={form.sanctionType}
            onChange={(e) => setForm({ ...form, sanctionType: e.target.value as SanctionType })}
          >
            {SANCTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {SANCTION_TYPE_LABELS[t]}
              </option>
            ))}
          </SelectField>
          <InputField
            label="Précisions sur la sanction"
            value={form.sanction}
            maxLength={300}
            onChange={(e) => setForm({ ...form, sanction: e.target.value })}
            placeholder="Durée, date de la consigne…"
            optional
          />
        </div>
      </div>
    </Sheet>
  );
}

export default function IncidentsPage() {
  const { can } = useAuth();
  const classes = useClasses();
  const [filters, setFilters] = useState({
    classId: '',
    from: '',
    to: '',
    type: '',
    sanctionType: '',
  });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const base = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== ''));
  const listQuery = new URLSearchParams(base);
  listQuery.set('page', String(page));
  const invalidPeriod = !!filters.from && !!filters.to && filters.from > filters.to;
  const q = useQuery({
    queryKey: ['incidents', listQuery.toString()],
    queryFn: () => api<Paged<IncidentRow>>(`/discipline/incidents?${listQuery.toString()}`),
    placeholderData: keepPreviousData,
    enabled: !invalidPeriod,
  });
  const stats = useQuery({
    queryKey: ['incident-stats', base.toString()],
    queryFn: () => api<Stats>(`/discipline/stats?${base.toString()}`),
    placeholderData: keepPreviousData,
    enabled: !invalidPeriod,
  });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  const topType = stats.data?.byType[0];

  return (
    <>
      <PageHeader
        title="Registre des incidents"
        subtitle="Incidents et sanctions de toute l’école, réservés à la surveillance générale et à la direction."
        actions={
          can('discipline.write') ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Signaler un incident
            </Button>
          ) : undefined
        }
      />

      <Card className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <SelectField
          label="Classe"
          value={filters.classId}
          onChange={(e) => setFilter('classId', e.target.value)}
          containerClassName="col-span-2 lg:col-span-1"
        >
          <option value="">Toutes les classes</option>
          {classes.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <InputField
          label="Du"
          type="date"
          value={filters.from}
          onChange={(e) => setFilter('from', e.target.value)}
        />
        <InputField
          label="Au"
          type="date"
          value={filters.to}
          onChange={(e) => setFilter('to', e.target.value)}
          error={invalidPeriod ? 'La date de fin précède la date de début' : undefined}
        />
        <SelectField
          label="Type"
          value={filters.type}
          onChange={(e) => setFilter('type', e.target.value)}
        >
          <option value="">Tous les types</option>
          {INCIDENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {INCIDENT_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Sanction"
          value={filters.sanctionType}
          onChange={(e) => setFilter('sanctionType', e.target.value)}
        >
          <option value="">Toutes les sanctions</option>
          {SANCTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {SANCTION_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
      </Card>

      {stats.data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Incidents" value={stats.data.total} />
          <Stat label="Élèves concernés" value={stats.data.students} />
          <Stat label="Sanctionnés" value={stats.data.sanctioned} />
          <Stat
            label="Type le plus fréquent"
            value={topType ? (INCIDENT_TYPE_LABELS[topType.type] ?? topType.type) : '—'}
            hint={topType ? plural(topType.count, 'incident', 'incidents') : undefined}
          />
        </div>
      ) : null}

      {stats.data && stats.data.total > 0 ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title="Par type" />
            <Bars
              rows={stats.data.byType.map((r) => ({
                key: r.type,
                label: INCIDENT_TYPE_LABELS[r.type] ?? r.type,
                count: r.count,
              }))}
            />
          </Card>
          <Card>
            <CardHeader title="Par classe" />
            <Bars
              rows={stats.data.byClass.map((r) => ({
                key: r.classId ?? 'none',
                label: r.className,
                count: r.count,
              }))}
            />
          </Card>
          <Card>
            <CardHeader title="Par mois" subtitle="Élèves signalés plusieurs fois ci-dessous." />
            <Bars
              rows={stats.data.byMonth.map((r) => ({
                key: r.month,
                label: monthLabel(r.month),
                count: r.count,
              }))}
            />
            {stats.data.repeatStudents.length > 0 ? (
              <ul className="mt-4 flex flex-col gap-1 border-t border-line pt-3 text-sm">
                {stats.data.repeatStudents.map((r) => (
                  <li key={r.studentId} className="flex justify-between gap-2">
                    {r.student ? (
                      <Link
                        href={`/eleves/${r.studentId}`}
                        className="font-semibold text-primary hover:underline"
                      >
                        {r.student.lastName} {r.student.firstName}
                      </Link>
                    ) : (
                      <span>—</span>
                    )}
                    <span className="text-muted tabular">
                      {r.class?.name ?? ''} · {r.count}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
      ) : null}

      {invalidPeriod ? null : q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <ErrorBlock error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <EmptyState title="Aucun incident sur ces critères">
          Modifiez les filtres ou signalez un incident.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Incidents">
            {q.data.items.map((i) => (
              <li
                key={i.id}
                className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    {i.student ? (
                      <Link
                        href={`/eleves/${i.student.id}`}
                        className="truncate font-semibold hover:underline"
                      >
                        {i.student.lastName} {i.student.firstName}
                      </Link>
                    ) : null}
                    <span className="text-[13px] text-muted">
                      {i.class?.name ?? 'Sans classe'} · {formatShortDate(i.date)}
                    </span>
                  </div>
                  <Badge tone="info">{i.typeLabel}</Badge>
                </div>
                <p className="text-sm [overflow-wrap:anywhere]">{i.description}</p>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Badge tone={sanctionTone(i.sanctionType)}>{i.sanctionLabel}</Badge>
                  {i.sanction ? <span className="text-muted">{i.sanction}</span> : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-[14px] border border-line bg-white md:block">
            <table className="w-full min-w-[900px] text-sm">
              <caption className="sr-only">Incidents</caption>
              <thead className="bg-paper text-left text-xs tracking-[0.06em] text-muted uppercase">
                <tr>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-3 py-3 font-semibold">Élève</th>
                  <th className="px-3 py-3 font-semibold">Type</th>
                  <th className="px-3 py-3 font-semibold">Description</th>
                  <th className="px-3 py-3 font-semibold">Sanction</th>
                  <th className="px-4 py-3 font-semibold">Signalé par</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((i) => (
                  <tr key={i.id} className="border-t border-line align-top">
                    <td className="px-4 py-2.5 whitespace-nowrap tabular">
                      {formatShortDate(i.date)}
                    </td>
                    <td className="px-3 py-2.5">
                      {i.student ? (
                        <div className="flex flex-col">
                          <Link
                            href={`/eleves/${i.student.id}`}
                            className="font-semibold hover:underline"
                          >
                            {i.student.lastName} {i.student.firstName}
                          </Link>
                          <span className="text-xs text-muted">
                            {i.class?.name ?? 'Sans classe'}
                          </span>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone="info">{i.typeLabel}</Badge>
                    </td>
                    <td className="max-w-80 px-3 py-2.5 [overflow-wrap:anywhere]">
                      {i.description}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-1">
                        <Badge tone={sanctionTone(i.sanctionType)} className="self-start">
                          {i.sanctionLabel}
                        </Badge>
                        {i.sanction ? (
                          <span className="text-xs text-muted">{i.sanction}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-muted">{i.reportedBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Pagination" className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted tabular">
              Page {page} sur {pages} · {plural(q.data.total, 'incident', 'incidents')}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="icon"
                aria-label="Page précédente"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="size-5" aria-hidden />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Page suivante"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="size-5" aria-hidden />
              </Button>
            </div>
          </nav>
        </>
      )}
      <NewIncidentSheet open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
