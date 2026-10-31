'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilLine, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatShortDate, plural } from '@/lib/format';
import { useCurrentStructure, type YearStructure } from '@/lib/queries';

interface Cycle {
  id: string;
  name: string;
  levels: { id: string; name: string }[];
}
interface Subject {
  id: string;
  name: string;
  code: string;
  group: 'LITERARY' | 'SCIENTIFIC' | 'OTHER';
}
interface Teacher {
  id: string;
  firstName: string;
  lastName: string;
}

const GROUP = { LITERARY: 'Lettres et langues', SCIENTIFIC: 'Sciences', OTHER: 'Autres' } as const;

type ClassSubjectRow = YearStructure['classes'][number]['subjects'][number];

/** Correction du coefficient, des heures ou de l'enseignant d'une matière, ou retrait de la classe. */
function ClassSubjectSheet({
  editing,
  teachers,
  onClose,
  onSaved,
}: {
  editing: { row: ClassSubjectRow; className: string } | null;
  teachers: Teacher[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/academic/class-subjects/${editing?.row.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      toast('Matière mise à jour');
      onSaved();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api(`/academic/class-subjects/${editing?.row.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast(`Matière « ${editing?.row.subject.name} » retirée de la ${editing?.className}`);
      onSaved();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const title = editing ? `${editing.row.subject.name} · ${editing.className}` : '';
  return (
    <Sheet open={!!editing} onClose={onClose} title={title}>
      {editing ? (
        <form
          key={editing.row.id}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            update.mutate({
              coefficient: Number(fd.get('coefficient')),
              weeklyHours: fd.get('weeklyHours') ? Number(fd.get('weeklyHours')) : null,
              teacherId: fd.get('teacherId') || null,
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <InputField
              label="Coefficient"
              name="coefficient"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              defaultValue={editing.row.coefficient}
              required
            />
            <InputField
              label="Heures par semaine"
              name="weeklyHours"
              type="number"
              inputMode="numeric"
              min={0}
              max={20}
              defaultValue={editing.row.weeklyHours ?? ''}
              optional
            />
          </div>
          <SelectField
            label="Enseignant"
            name="teacherId"
            defaultValue={editing.row.teacherId ?? ''}
            optional
          >
            <option value="">À désigner</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.lastName} {t.firstName}
              </option>
            ))}
          </SelectField>
          <p className="text-[13px] text-muted">
            Le nouveau coefficient s’applique aux prochains bulletins ; les bulletins déjà publiés
            ne changent pas.
          </p>
          <Button type="submit" loading={update.isPending}>
            Enregistrer
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Retirer ${editing.row.subject.name} de la ${editing.className} ? Impossible si des notes y sont déjà saisies.`,
                )
              )
                remove.mutate();
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            Retirer de la classe
          </Button>
        </form>
      ) : null}
    </Sheet>
  );
}

export default function StructurePage() {
  const { me, can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const structure = useCurrentStructure();
  const cycles = useQuery({
    queryKey: ['cycles'],
    queryFn: () => api<Cycle[]>('/academic/cycles'),
  });
  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api<Subject[]>('/academic/subjects'),
  });
  const teachers = useQuery({
    queryKey: ['teachers'],
    queryFn: () => api<Teacher[]>('/staff/teachers'),
  });
  const [sheet, setSheet] = useState<null | 'class' | 'subject' | { assign: string }>(null);
  const [editing, setEditing] = useState<{ row: ClassSubjectRow; className: string } | null>(null);
  const canWrite = can('academic.write');
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['structure'] });
    void queryClient.invalidateQueries({ queryKey: ['classes'] });
    void queryClient.invalidateQueries({ queryKey: ['subjects'] });
  };
  const post = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      api(path, { method: 'POST', body }),
    onSuccess: () => {
      setSheet(null);
      toast('Enregistré');
      invalidate();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const teacherName = (id: string | null) => {
    const t = teachers.data?.find((x) => x.id === id);
    return t ? `${t.lastName} ${t.firstName}` : 'Sans enseignant';
  };

  if (structure.isPending) return <LoadingBlock />;
  if (structure.isError) return <ErrorBlock error={structure.error} />;
  const s = structure.data;

  return (
    <>
      <PageHeader
        title="Structure académique"
        subtitle={`Année ${s.name} · du ${formatShortDate(s.startDate)} au ${formatShortDate(s.endDate)}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setSheet('subject')}>
              <Plus className="size-4" aria-hidden />
              Matière
            </Button>
            <Button onClick={() => setSheet('class')}>
              <Plus className="size-4" aria-hidden />
              Classe
            </Button>
          </>
        }
      />
      <Card>
        <CardHeader title="Trimestres et séquences" />
        <ul className="grid gap-3 sm:grid-cols-3">
          {s.terms.map((t) => (
            <li key={t.id} className="rounded-[10px] bg-paper p-3 text-sm">
              <strong>{t.name}</strong>
              <p className="text-xs text-muted">
                {formatShortDate(t.startDate)} → {formatShortDate(t.endDate)}
              </p>
              <p className="mt-1">{t.sequences.map((q) => q.name).join(' · ')}</p>
            </li>
          ))}
        </ul>
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        {s.classes.map((c) => (
          <Card key={c.id}>
            <CardHeader
              title={c.name}
              subtitle={`${c.level.cycle.name} · ${plural(c._count.enrollments, 'élève', 'élèves')}`}
              action={
                <Button variant="ghost" size="sm" onClick={() => setSheet({ assign: c.id })}>
                  <Plus className="size-4" aria-hidden />
                  Matière
                </Button>
              }
            />
            {c.subjects.length === 0 ? (
              <p className="text-sm text-muted">Aucune matière affectée.</p>
            ) : (
              <ul className="flex flex-col">
                {c.subjects.map((cs) => (
                  <li
                    key={cs.id}
                    className="flex items-center gap-2 border-t border-line py-2 text-sm first:border-t-0"
                  >
                    <span className="flex-1">
                      <strong className="font-semibold">{cs.subject.name}</strong>
                      <span className="block text-xs text-muted">{teacherName(cs.teacherId)}</span>
                    </span>
                    <Badge>coef. {cs.coefficient}</Badge>
                    {cs.weeklyHours ? <Badge tone="info">{cs.weeklyHours} h</Badge> : null}
                    {canWrite ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Modifier ${cs.subject.name} en ${c.name}`}
                        onClick={() => setEditing({ row: cs, className: c.name })}
                      >
                        <PencilLine className="size-4" aria-hidden />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>

      <Sheet open={sheet === 'class'} onClose={() => setSheet(null)} title="Nouvelle classe">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            post.mutate({
              path: '/academic/classes',
              body: {
                academicYearId: me?.activeSchool?.currentYear?.id,
                levelId: fd.get('levelId'),
                name: fd.get('name'),
                capacity: fd.get('capacity') ? Number(fd.get('capacity')) : undefined,
              },
            });
          }}
        >
          <SelectField label="Niveau" name="levelId" required>
            {cycles.data?.flatMap((c) =>
              c.levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {c.name} · {l.name}
                </option>
              )),
            )}
          </SelectField>
          <InputField
            label="Nom de la classe"
            name="name"
            placeholder="4e C"
            required
            maxLength={20}
          />
          <InputField
            label="Effectif maximal"
            name="capacity"
            type="number"
            inputMode="numeric"
            optional
          />
          <Button type="submit" loading={post.isPending}>
            Créer
          </Button>
        </form>
      </Sheet>

      <Sheet open={sheet === 'subject'} onClose={() => setSheet(null)} title="Nouvelle matière">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            post.mutate({
              path: '/academic/subjects',
              body: {
                name: fd.get('name'),
                code: String(fd.get('code')).toUpperCase(),
                group: fd.get('group'),
              },
            });
          }}
        >
          <InputField label="Nom" name="name" required />
          <InputField
            label="Code"
            name="code"
            required
            pattern="[A-Za-z0-9-]{2,12}"
            hint="2 à 12 lettres ou chiffres, ex. INFO"
          />
          <SelectField label="Groupe sur le bulletin" name="group">
            {Object.entries(GROUP).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </SelectField>
          <Button type="submit" loading={post.isPending}>
            Créer
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={typeof sheet === 'object' && sheet !== null}
        onClose={() => setSheet(null)}
        title="Affecter une matière"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (typeof sheet !== 'object' || !sheet) return;
            const fd = new FormData(e.currentTarget);
            post.mutate({
              path: '/academic/class-subjects',
              body: {
                classId: sheet.assign,
                subjectId: fd.get('subjectId'),
                coefficient: Number(fd.get('coefficient')),
                teacherId: fd.get('teacherId') || undefined,
                weeklyHours: fd.get('weeklyHours') ? Number(fd.get('weeklyHours')) : undefined,
              },
            });
          }}
        >
          <SelectField label="Matière" name="subjectId" required>
            {subjects.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
          <div className="grid grid-cols-2 gap-3">
            <InputField
              label="Coefficient"
              name="coefficient"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              defaultValue={2}
              required
            />
            <InputField
              label="Heures par semaine"
              name="weeklyHours"
              type="number"
              inputMode="numeric"
              min={0}
              max={20}
              optional
            />
          </div>
          <SelectField label="Enseignant" name="teacherId" optional>
            <option value="">À désigner</option>
            {teachers.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.lastName} {t.firstName}
              </option>
            ))}
          </SelectField>
          <Button type="submit" loading={post.isPending}>
            Affecter
          </Button>
        </form>
      </Sheet>

      <ClassSubjectSheet
        editing={editing}
        teachers={teachers.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          invalidate();
        }}
      />
    </>
  );
}
