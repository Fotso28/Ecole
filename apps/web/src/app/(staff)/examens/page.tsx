'use client';

import { EXAM_KIND_LABELS, EXAM_KINDS } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { Checkbox, InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { ExamSessionSummary } from '@/lib/exams';
import { formatShortDate, plural } from '@/lib/format';
import { useClasses, useCurrentStructure } from '@/lib/queries';

export default function ExamSessionsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof EXAM_KINDS)[number]>('MOCK');
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['exam-sessions'],
    queryFn: () => api<ExamSessionSummary[]>('/exams/sessions'),
  });
  const classes = useClasses();
  const structure = useCurrentStructure();
  const sequences =
    structure.data?.terms.flatMap((t) =>
      t.sequences.map((s) => ({ id: s.id, label: `${s.name} · ${t.name}` })),
    ) ?? [];

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string }>('/exams/sessions', { method: 'POST', body }),
    onSuccess: (s) => {
      setOpen(false);
      setError(null);
      toast('Session créée');
      void queryClient.invalidateQueries({ queryKey: ['exam-sessions'] });
      router.push(`/examens/${s.id}`);
    },
    onError: (e) => {
      const fields = e instanceof ApiError ? e.fieldErrors.map((f) => f.message) : [];
      setError(fields.length ? fields.join(' ') : e instanceof Error ? e.message : 'Erreur');
    },
  });

  return (
    <>
      <PageHeader
        title="Examens"
        subtitle="Examens blancs, compositions de séquence et examens de passage : calendrier, salles, surveillances, anonymat et résultats."
        actions={
          can('exams.manage') ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Nouvelle session
            </Button>
          ) : undefined
        }
      />
      {list.isPending ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState title="Aucune session d’examen">
          {can('exams.manage')
            ? 'Créez une session pour planifier ses épreuves.'
            : 'Les sessions où vous surveillez ou corrigez apparaîtront ici.'}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {list.data.map((s) => (
            <li key={s.id}>
              <Link
                href={`/examens/${s.id}`}
                className="flex min-h-20 items-center gap-3 rounded-[14px] border border-line bg-white p-4 hover:border-primary"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <strong className="text-[16px]">{s.name}</strong>
                    <Badge tone={s.published ? 'night' : 'warn'}>
                      {s.published ? 'Résultats publiés' : 'En préparation'}
                    </Badge>
                  </span>
                  <span className="text-[13px] text-muted">
                    {s.kindLabel} · du {formatShortDate(s.startDate)} au{' '}
                    {formatShortDate(s.endDate)}
                  </span>
                  <span className="text-[13px] text-muted [overflow-wrap:anywhere]">
                    {s.classes.map((c) => c.name).join(', ')} ·{' '}
                    {plural(s.papers, 'épreuve', 'épreuves')} ·{' '}
                    {plural(s.candidates, 'candidat', 'candidats')}
                  </span>
                </span>
                <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="Nouvelle session d’examen">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            create.mutate({
              name: fd.get('name'),
              kind,
              sequenceId: fd.get('sequenceId') || undefined,
              startDate: fd.get('startDate'),
              endDate: fd.get('endDate'),
              classIds: fd.getAll('classIds'),
              mixClasses: fd.get('mixClasses') === 'on',
              supervisorsPerRoom: Number(fd.get('supervisorsPerRoom')),
            });
          }}
        >
          {error ? (
            <p role="alert" className="rounded-[10px] bg-danger-soft p-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <InputField label="Nom" name="name" required maxLength={80} placeholder="Examen blanc" />
          <SelectField
            label="Type"
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {EXAM_KINDS.map((k) => (
              <option key={k} value={k}>
                {EXAM_KIND_LABELS[k]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Séquence"
            name="sequenceId"
            optional={kind !== 'SEQUENCE'}
            required={kind === 'SEQUENCE'}
            hint="Permet de reporter les notes dans les évaluations de la séquence."
          >
            <option value="">{kind === 'SEQUENCE' ? 'Choisir…' : 'Aucune'}</option>
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <div className="grid grid-cols-2 gap-3">
            <InputField label="Début" name="startDate" type="date" required />
            <InputField label="Fin" name="endDate" type="date" required />
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-semibold lg:text-[13px]">
              Classes concernées
            </legend>
            <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-3">
              {classes.data?.map((c) => (
                <Checkbox key={c.id} name="classIds" value={c.id} label={c.name} />
              ))}
            </div>
          </fieldset>
          <Checkbox
            name="mixClasses"
            defaultChecked
            label="Mélanger les classes dans les salles (voisins de classes différentes)"
          />
          <SelectField label="Surveillants par salle" name="supervisorsPerRoom" defaultValue="1">
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectField>
          <Button type="submit" loading={create.isPending}>
            Créer la session
          </Button>
        </form>
      </Sheet>
    </>
  );
}
