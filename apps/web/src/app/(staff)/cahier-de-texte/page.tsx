'use client';

import { formatFileSize, lessonLogSchema } from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Paperclip, PenLine, Plus, Trash2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '@/components/ui/card';
import { InputField, SelectField, TextareaField } from '@/components/ui/field';
import { FilePicker } from '@/components/ui/file-picker';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, openFile, uploadFile } from '@/lib/api';
import { formatShortDate, formatWeekday, todayIso } from '@/lib/format';

interface ClassSubjectOption {
  id: string;
  classId: string;
  className: string;
  subjectName: string;
  canWrite: boolean;
}

interface Material {
  id: string;
  title: string;
  classId: string;
  className: string | null;
  classSubjectId: string;
  subjectName: string | null;
  lessonLogId: string | null;
  createdAt: string;
  file: { id: string; name: string; mimeType: string; size: number } | null;
}

interface Lesson {
  id: string;
  classId: string;
  className: string | null;
  classSubjectId: string;
  subjectName: string | null;
  date: string;
  startTime: string | null;
  content: string;
  homework: string | null;
  homeworkDueDate: string | null;
  author: string | null;
  canEdit: boolean;
  materials: Material[];
}

const capitalize = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Erreur');

function useFieldErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fromError = (e: unknown) => {
    if (e instanceof ApiError && e.fieldErrors.length)
      setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
  };
  return { errors, setErrors, fromError };
}

/** Saisie ou modification d'une séance : contenu et travail à faire. */
function LessonSheet({
  open,
  onClose,
  options,
  entry,
  defaultCs,
}: {
  open: boolean;
  onClose: () => void;
  options: ClassSubjectOption[];
  entry: Lesson | null;
  defaultCs: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const writable = options.filter((o) => o.canWrite);
  const blank = () => ({
    classSubjectId: entry?.classSubjectId ?? defaultCs ?? writable[0]?.id ?? '',
    date: entry?.date ?? todayIso(),
    startTime: entry?.startTime ?? '',
    content: entry?.content ?? '',
    homework: entry?.homework ?? '',
    homeworkDueDate: entry?.homeworkDueDate ?? '',
  });
  const [form, setForm] = useState(blank);
  const { errors, setErrors, fromError } = useFieldErrors();
  useEffect(() => {
    if (open) {
      setForm(blank());
      setErrors({});
    }
  }, [open, entry]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        startTime: form.startTime || undefined,
        homework: form.homework || undefined,
        homeworkDueDate: form.homeworkDueDate || undefined,
      };
      const parsed = lessonLogSchema.safeParse(body);
      if (!parsed.success) {
        setErrors(
          Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])),
        );
        throw new Error('Vérifiez les champs signalés');
      }
      return entry
        ? api<Lesson>(`/lessons/${entry.id}`, { method: 'PUT', body: parsed.data })
        : api<Lesson>('/lessons', { method: 'POST', body: parsed.data });
    },
    onSuccess: () => {
      toast(entry ? 'Séance modifiée' : 'Séance enregistrée');
      void queryClient.invalidateQueries({ queryKey: ['lessons'] });
      onClose();
    },
    onError: (e) => {
      fromError(e);
      toast(errorText(e), 'error');
    },
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={entry ? 'Modifier la séance' : 'Nouvelle séance'}
      footer={
        <Button block size="lg" loading={save.isPending} onClick={() => save.mutate()}>
          Enregistrer la séance
        </Button>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <SelectField
          label="Classe et matière"
          value={form.classSubjectId}
          onChange={set('classSubjectId')}
          disabled={!!entry}
          error={errors.classSubjectId}
        >
          {(entry ? options : writable).map((o) => (
            <option key={o.id} value={o.id}>
              {o.className} · {o.subjectName}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <InputField
            label="Date"
            type="date"
            value={form.date}
            onChange={set('date')}
            error={errors.date}
          />
          <InputField
            label="Heure"
            optional
            type="time"
            value={form.startTime}
            onChange={set('startTime')}
            error={errors.startTime}
          />
        </div>
        <TextareaField
          label="Contenu de la séance"
          value={form.content}
          onChange={set('content')}
          placeholder="Ex. Théorème de Pythagore : énoncé, démonstration, exemples"
          error={errors.content}
        />
        <TextareaField
          label="Travail à faire"
          optional
          value={form.homework}
          onChange={set('homework')}
          placeholder="Ex. Exercices 3 à 6 page 112"
          error={errors.homework}
        />
        <InputField
          label="Pour le"
          optional
          type="date"
          min={form.date}
          value={form.homeworkDueDate}
          onChange={set('homeworkDueDate')}
          error={errors.homeworkDueDate}
          hint="Les parents voient le travail à faire dans leur espace."
        />
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

/** Dépôt d'un support de cours (fiche, sujet, photo du tableau…). */
function MaterialSheet({
  open,
  onClose,
  options,
  lesson,
  defaultCs,
}: {
  open: boolean;
  onClose: () => void;
  options: ClassSubjectOption[];
  lesson: Lesson | null;
  defaultCs: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const writable = options.filter((o) => o.canWrite);
  const [cs, setCs] = useState('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { errors, setErrors, fromError } = useFieldErrors();
  useEffect(() => {
    if (open) {
      setCs(lesson?.classSubjectId ?? defaultCs ?? writable[0]?.id ?? '');
      setTitle('');
      setFile(null);
      setErrors({});
    }
  }, [open, lesson]);
  const save = useMutation({
    mutationFn: () =>
      uploadFile('/lessons/materials', file!, {
        classSubjectId: cs,
        title: title.trim(),
        lessonLogId: lesson?.id,
      }),
    onSuccess: () => {
      toast('Support de cours ajouté');
      void queryClient.invalidateQueries({ queryKey: ['lessons'] });
      onClose();
    },
    onError: (e) => {
      fromError(e);
      toast(errorText(e), 'error');
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ajouter un support de cours"
      footer={
        <Button
          block
          size="lg"
          disabled={!file || title.trim().length < 2 || !cs}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Partager le support
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {lesson ? (
          <p className="text-sm text-muted">
            Rattaché à la séance du {formatShortDate(lesson.date)} ({lesson.className} ·{' '}
            {lesson.subjectName}).
          </p>
        ) : (
          <SelectField label="Classe et matière" value={cs} onChange={(e) => setCs(e.target.value)}>
            {writable.map((o) => (
              <option key={o.id} value={o.id}>
                {o.className} · {o.subjectName}
              </option>
            ))}
          </SelectField>
        )}
        <InputField
          label="Titre"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ex. Fiche d’exercices sur Pythagore"
          error={errors.title}
        />
        <FilePicker label="Fichier" value={file} onChange={setFile} />
        <p className="text-[13px] text-muted">
          Visible des élèves de la classe et de leurs parents dans l’espace parents.
        </p>
      </div>
    </Sheet>
  );
}

function MaterialRow({ m, canDelete }: { m: Material; canDelete: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api(`/lessons/materials/${m.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Support retiré');
      void queryClient.invalidateQueries({ queryKey: ['lessons'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <li className="flex items-center gap-2 border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() =>
          openFile(`/lessons/materials/${m.id}/file`).catch((e) => toast(errorText(e), 'error'))
        }
        className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-left"
      >
        <FileText className="size-5 shrink-0 text-primary" aria-hidden />
        <span className="flex min-w-0 flex-col">
          <strong className="truncate text-sm">{m.title}</strong>
          <span className="text-[13px] text-muted">
            {[m.className, m.subjectName].filter(Boolean).join(' · ')}
            {m.file ? ` · ${formatFileSize(m.file.size)}` : ''}
          </span>
        </span>
      </button>
      {canDelete ? (
        <button
          type="button"
          aria-label={`Retirer le support ${m.title}`}
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Retirer le support « ${m.title} » ?`)) remove.mutate();
          }}
          className="flex size-11 shrink-0 items-center justify-center rounded-[10px] text-danger hover:bg-danger-soft"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

function LessonCard({
  l,
  onEdit,
  onAddMaterial,
}: {
  l: Lesson;
  onEdit: () => void;
  onAddMaterial: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api(`/lessons/${l.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Séance supprimée');
      void queryClient.invalidateQueries({ queryKey: ['lessons'] });
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <strong className="text-[15px]">
            {capitalize(formatWeekday(l.date))}
            {l.startTime ? ` · ${l.startTime}` : ''}
          </strong>
          <span className="text-[13px] text-muted">
            {l.className} · {l.subjectName}
            {l.author ? ` · ${l.author}` : ''}
          </span>
        </div>
        {l.homeworkDueDate ? (
          <Badge tone="info">Devoir pour le {formatShortDate(l.homeworkDueDate)}</Badge>
        ) : null}
      </div>
      <p className="text-sm whitespace-pre-line">{l.content}</p>
      {l.homework ? (
        <div className="rounded-[10px] bg-paper p-3 text-sm">
          <strong className="block text-[13px] text-muted">Travail à faire</strong>
          <span className="whitespace-pre-line">{l.homework}</span>
        </div>
      ) : null}
      {l.materials.length > 0 ? (
        <ul className="flex flex-col">
          {l.materials.map((m) => (
            <MaterialRow key={m.id} m={m} canDelete={l.canEdit} />
          ))}
        </ul>
      ) : null}
      {l.canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            <PenLine className="size-4" aria-hidden />
            Modifier
          </Button>
          <Button size="sm" variant="secondary" onClick={onAddMaterial}>
            <Paperclip className="size-4" aria-hidden />
            Joindre un support
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            loading={remove.isPending}
            onClick={() => {
              if (window.confirm('Supprimer cette séance du cahier de texte ?')) remove.mutate();
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            Supprimer
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function LessonsPage() {
  const params = useSearchParams();
  const [classId, setClassId] = useState('');
  const [csId, setCsId] = useState(params.get('cs') ?? '');
  const [lessonSheet, setLessonSheet] = useState<{ entry: Lesson | null } | null>(null);
  const [materialSheet, setMaterialSheet] = useState<{ lesson: Lesson | null } | null>(null);

  const options = useQuery({
    queryKey: ['lessons', 'class-subjects'],
    queryFn: () => api<ClassSubjectOption[]>('/lessons/class-subjects'),
  });
  const classes = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of options.data ?? []) map.set(o.classId, o.className);
    return [...map].map(([id, name]) => ({ id, name }));
  }, [options.data]);

  useEffect(() => {
    // Lien depuis « Ma journée » : la matière choisie fixe la classe.
    const cs = options.data?.find((o) => o.id === csId);
    if (cs && cs.classId !== classId) setClassId(cs.classId);
  }, [options.data]);

  const filter = new URLSearchParams();
  if (csId) filter.set('classSubjectId', csId);
  else if (classId) filter.set('classId', classId);
  const qs = filter.toString();
  const lessons = useQuery({
    queryKey: ['lessons', 'list', qs],
    queryFn: () => api<Lesson[]>(`/lessons${qs ? `?${qs}` : ''}`),
    enabled: options.isSuccess,
  });
  const materials = useQuery({
    queryKey: ['lessons', 'materials', qs],
    queryFn: () => api<Material[]>(`/lessons/materials${qs ? `?${qs}` : ''}`),
    enabled: options.isSuccess,
  });

  if (options.isPending) return <LoadingBlock />;
  if (options.isError)
    return <ErrorBlock error={options.error} onRetry={() => options.refetch()} />;
  const all = options.data;
  const writable = all.filter((o) => o.canWrite);
  const writableIds = new Set(writable.map((o) => o.id));
  const subjects = all.filter((o) => !classId || o.classId === classId);
  const defaultCs = writableIds.has(csId) ? csId : (writable[0]?.id ?? '');

  return (
    <>
      <PageHeader
        title="Cahier de texte"
        subtitle={
          writable.length > 0
            ? 'Contenu des séances, travail à faire et supports de cours de vos classes.'
            : 'Séances, devoirs donnés et supports de cours, par classe et par matière.'
        }
        actions={
          writable.length > 0 ? (
            <Button onClick={() => setLessonSheet({ entry: null })}>
              <Plus className="size-4" aria-hidden />
              Nouvelle séance
            </Button>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Classe"
          value={classId}
          onChange={(e) => {
            setClassId(e.target.value);
            setCsId('');
          }}
        >
          <option value="">Toutes les classes</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Matière" value={csId} onChange={(e) => setCsId(e.target.value)}>
          <option value="">Toutes les matières</option>
          {subjects.map((o) => (
            <option key={o.id} value={o.id}>
              {classId ? o.subjectName : `${o.className} · ${o.subjectName}`}
            </option>
          ))}
        </SelectField>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <section className="flex flex-col gap-3" aria-labelledby="seances">
          <h2 id="seances" className="text-lg font-bold">
            Séances
          </h2>
          {lessons.isPending ? (
            <LoadingBlock />
          ) : lessons.isError ? (
            <ErrorBlock error={lessons.error} onRetry={() => lessons.refetch()} />
          ) : lessons.data.length === 0 ? (
            <EmptyState title="Aucune séance saisie">
              {writable.length > 0
                ? 'Saisissez le contenu de votre séance et le travail à faire.'
                : 'Les enseignants n’ont encore rien saisi pour cette sélection.'}
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {lessons.data.map((l) => (
                <li key={l.id}>
                  <LessonCard
                    l={l}
                    onEdit={() => setLessonSheet({ entry: l })}
                    onAddMaterial={() => setMaterialSheet({ lesson: l })}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <Card className="flex flex-col gap-2">
          <CardHeader
            title="Supports de cours"
            action={
              writable.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMaterialSheet({ lesson: null })}
                >
                  <Plus className="size-4" aria-hidden />
                  Ajouter
                </Button>
              ) : null
            }
          />
          {materials.isPending ? (
            <LoadingBlock />
          ) : materials.isError ? (
            <ErrorBlock error={materials.error} />
          ) : materials.data.length === 0 ? (
            <p className="text-sm text-muted">Aucun support partagé.</p>
          ) : (
            <ul className="flex flex-col">
              {materials.data.map((m) => (
                <MaterialRow key={m.id} m={m} canDelete={writableIds.has(m.classSubjectId)} />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <LessonSheet
        open={!!lessonSheet}
        onClose={() => setLessonSheet(null)}
        options={all}
        entry={lessonSheet?.entry ?? null}
        defaultCs={defaultCs}
      />
      <MaterialSheet
        open={!!materialSheet}
        onClose={() => setMaterialSheet(null)}
        options={all}
        lesson={materialSheet?.lesson ?? null}
        defaultCs={defaultCs}
      />
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LessonsPage />
    </Suspense>
  );
}
