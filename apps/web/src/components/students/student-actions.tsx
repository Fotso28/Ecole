'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, DoorOpen, PencilLine, RotateCcw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { enrollmentLabel, ENROLLMENT_BADGE } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InputField, SelectField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate, plural, todayIso } from '@/lib/format';
import { useClasses } from '@/lib/queries';
import { cn } from '@/lib/utils';

export interface StudentIdentity {
  id: string;
  firstName: string;
  lastName: string;
  gender: 'F' | 'M';
  birthDate: string;
  birthPlace: string | null;
  nationality: string;
}

export interface CurrentEnrollment {
  id: string;
  status: keyof typeof ENROLLMENT_BADGE;
  class: { id: string; name: string };
  exitDate?: string | null;
  exitReason?: string | null;
  destinationSchool?: string | null;
}

type Errors = Record<string, string>;

/** Erreurs de champ renvoyées par l'API, indexées par chemin. */
function fieldErrors(e: unknown): Errors {
  return e instanceof ApiError
    ? Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message]))
    : {};
}

/** Phrase de sortie : « Transférée le 30 octobre 2026 vers Lycée de Garoua ». */
export function exitSummary(e: CurrentEnrollment, gender: 'F' | 'M'): string | null {
  if (e.status !== 'TRANSFERRED' && e.status !== 'LEFT') return null;
  const label = enrollmentLabel(e.status, gender);
  const when = e.exitDate ? ` le ${formatDate(e.exitDate)}` : '';
  const where =
    e.status === 'TRANSFERRED' && e.destinationSchool ? ` vers ${e.destinationSchool}` : '';
  return `${label}${when}${where}`;
}

function useInvalidate(studentId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['student', studentId] });
    void queryClient.invalidateQueries({ queryKey: ['students'] });
    void queryClient.invalidateQueries({ queryKey: ['classes'] });
  };
}

/** Correction de l'identité : nom, prénoms, sexe, date et lieu de naissance, nationalité. */
function IdentitySheet({
  student,
  open,
  onClose,
}: {
  student: StudentIdentity;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate(student.id);
  const initial = () => ({
    lastName: student.lastName,
    firstName: student.firstName,
    gender: student.gender,
    birthDate: student.birthDate,
    birthPlace: student.birthPlace ?? '',
    nationality: student.nationality,
  });
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const save = useMutation({
    mutationFn: () => api(`/students/${student.id}`, { method: 'PATCH', body: form }),
    onSuccess: () => {
      toast('Identité corrigée');
      invalidate();
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  const close = () => {
    setForm(initial());
    setErrors({});
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Corriger l’identité"
      footer={
        <Button block size="lg" type="submit" form="identity-form" loading={save.isPending}>
          Enregistrer la correction
        </Button>
      }
    >
      <form
        id="identity-form"
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setErrors({});
          save.mutate();
        }}
      >
        <InputField
          label="Nom"
          autoComplete="off"
          value={form.lastName}
          onChange={(e) => setForm({ ...form, lastName: e.target.value })}
          error={errors.lastName}
        />
        <InputField
          label="Prénoms"
          autoComplete="off"
          value={form.firstName}
          onChange={(e) => setForm({ ...form, firstName: e.target.value })}
          error={errors.firstName}
        />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-semibold lg:text-[13px]">Sexe</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['F', 'M'] as const).map((g) => (
              <label
                key={g}
                className={cn(
                  'flex min-h-12 items-center gap-2 rounded-[10px] border px-3 text-[15px] font-semibold lg:min-h-11 lg:text-sm',
                  form.gender === g
                    ? 'border-2 border-primary bg-primary-soft'
                    : 'border-line-strong',
                )}
              >
                <input
                  type="radio"
                  name="identity-gender"
                  className="accent-primary"
                  checked={form.gender === g}
                  onChange={() => setForm({ ...form, gender: g })}
                />
                {g === 'F' ? 'Fille' : 'Garçon'}
              </label>
            ))}
          </div>
        </fieldset>
        <InputField
          label="Date de naissance"
          type="date"
          max={todayIso()}
          value={form.birthDate}
          onChange={(e) => setForm({ ...form, birthDate: e.target.value })}
          error={errors.birthDate}
        />
        <InputField
          label="Lieu de naissance"
          value={form.birthPlace}
          onChange={(e) => setForm({ ...form, birthPlace: e.target.value })}
          error={errors.birthPlace}
          optional
        />
        <InputField
          label="Nationalité"
          value={form.nationality}
          onChange={(e) => setForm({ ...form, nationality: e.target.value })}
          error={errors.nationality}
        />
        <p className="text-[13px] text-muted sm:col-span-2">
          La correction est enregistrée dans le journal d’audit. Les documents déjà délivrés et les
          bulletins publiés ne changent pas.
        </p>
      </form>
    </Sheet>
  );
}

/** Changement de classe en cours d'année (même année scolaire). */
function ClassChangeSheet({
  studentId,
  enrollment,
  open,
  onClose,
}: {
  studentId: string;
  enrollment: CurrentEnrollment;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate(studentId);
  const classes = useClasses();
  const [classId, setClassId] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/enrollments/${enrollment.id}`, { method: 'PATCH', body: { classId } }),
    onSuccess: () => {
      const name = classes.data?.find((c) => c.id === classId)?.name ?? '';
      toast(`Élève passé en ${name}`);
      setClassId('');
      invalidate();
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Changer de classe"
      footer={
        <Button
          block
          size="lg"
          disabled={!classId}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Changer de classe
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          Classe actuelle : <strong>{enrollment.class.name}</strong>
        </p>
        <SelectField
          label="Nouvelle classe"
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          hint="Les notes déjà saisies restent rattachées à l’ancienne classe."
        >
          <option value="">Choisir une classe</option>
          {classes.data
            ?.filter((c) => c.id !== enrollment.class.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {plural(c._count.enrollments, 'élève', 'élèves')}
              </option>
            ))}
        </SelectField>
      </div>
    </Sheet>
  );
}

/** Transfert vers un autre établissement ou sortie définitive, en cours d'année. */
function ExitSheet({
  student,
  enrollment,
  open,
  onClose,
}: {
  student: StudentIdentity;
  enrollment: CurrentEnrollment;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidate(student.id);
  const empty = () => ({
    status: 'TRANSFERRED' as 'TRANSFERRED' | 'LEFT',
    exitDate: todayIso(),
    exitReason: '',
    destinationSchool: '',
  });
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Errors>({});
  const female = student.gender === 'F';
  const save = useMutation({
    mutationFn: () =>
      api(`/enrollments/${enrollment.id}`, {
        method: 'PATCH',
        body: {
          status: form.status,
          exitDate: form.exitDate,
          exitReason: form.exitReason.trim(),
          destinationSchool:
            form.status === 'TRANSFERRED' ? form.destinationSchool.trim() || undefined : undefined,
        },
      }),
    onSuccess: () => {
      toast(form.status === 'TRANSFERRED' ? 'Transfert enregistré' : 'Sortie enregistrée');
      setForm(empty());
      invalidate();
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });
  return (
    <Sheet
      open={open}
      onClose={() => {
        setErrors({});
        onClose();
      }}
      title="Transfert ou sortie"
      footer={
        <Button
          block
          size="lg"
          variant="danger"
          type="submit"
          form="exit-form"
          loading={save.isPending}
        >
          {form.status === 'TRANSFERRED' ? 'Enregistrer le transfert' : 'Enregistrer la sortie'}
        </Button>
      }
    >
      <form
        id="exit-form"
        className="flex flex-col gap-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setErrors({});
          save.mutate();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-semibold lg:text-[13px]">Motif de départ</legend>
          {(
            [
              ['TRANSFERRED', 'Transfert vers un autre établissement'],
              ['LEFT', 'Sortie définitive (abandon, départ…)'],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className={cn(
                'flex min-h-12 items-center gap-2 rounded-[10px] border px-3 text-[15px] font-semibold lg:min-h-11 lg:text-sm',
                form.status === value
                  ? 'border-2 border-primary bg-primary-soft'
                  : 'border-line-strong',
              )}
            >
              <input
                type="radio"
                name="exit-status"
                className="accent-primary"
                checked={form.status === value}
                onChange={() => setForm({ ...form, status: value })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <InputField
          label="Date de départ"
          type="date"
          value={form.exitDate}
          onChange={(e) => setForm({ ...form, exitDate: e.target.value })}
          error={errors.exitDate}
        />
        {form.status === 'TRANSFERRED' ? (
          <InputField
            label="Établissement d’accueil"
            value={form.destinationSchool}
            maxLength={120}
            onChange={(e) => setForm({ ...form, destinationSchool: e.target.value })}
            error={errors.destinationSchool}
          />
        ) : null}
        <TextareaField
          label="Motif"
          value={form.exitReason}
          maxLength={300}
          onChange={(e) => setForm({ ...form, exitReason: e.target.value })}
          error={errors.exitReason}
          hint="Par exemple : mutation des parents, déménagement. Visible du secrétariat et de la direction seulement."
        />
        <p className="text-[13px] text-muted">
          {female ? 'L’élève sera retirée' : 'L’élève sera retiré'} des listes d’appel et de notes
          de la classe {enrollment.class.name}. Son dossier et son historique restent consultables.
        </p>
      </form>
    </Sheet>
  );
}

/** Boutons de la fiche : correction d'identité, changement de classe, transfert ou sortie. */
export function StudentActions({
  student,
  enrollment,
}: {
  student: StudentIdentity;
  enrollment: CurrentEnrollment | undefined;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidate(student.id);
  const [open, setOpen] = useState<'identity' | 'class' | 'exit' | null>(null);
  const active =
    enrollment && (enrollment.status === 'ENROLLED' || enrollment.status === 'REPEATING');
  const reinstate = useMutation({
    mutationFn: () =>
      api(`/enrollments/${enrollment?.id}`, { method: 'PATCH', body: { status: 'ENROLLED' } }),
    onSuccess: () => {
      toast(student.gender === 'F' ? 'Élève réintégrée' : 'Élève réintégré');
      invalidate();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const canIdentity = can('students.write');
  const canEnroll = can('enrollments.write') && !!enrollment;
  if (!canIdentity && !canEnroll) return null;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {canIdentity ? (
        <Button variant="secondary" onClick={() => setOpen('identity')}>
          <PencilLine className="size-4" aria-hidden />
          Corriger l’identité
        </Button>
      ) : null}
      {canEnroll && active ? (
        <>
          <Button variant="secondary" onClick={() => setOpen('class')}>
            <ArrowLeftRight className="size-4" aria-hidden />
            Changer de classe
          </Button>
          <Button variant="secondary" onClick={() => setOpen('exit')}>
            <DoorOpen className="size-4" aria-hidden />
            Transfert ou sortie
          </Button>
        </>
      ) : null}
      {canEnroll && !active ? (
        <Button
          variant="secondary"
          loading={reinstate.isPending}
          onClick={() => {
            if (
              window.confirm(
                `Réintégrer ${student.firstName} ${student.lastName} en ${enrollment.class.name} ?`,
              )
            )
              reinstate.mutate();
          }}
        >
          <RotateCcw className="size-4" aria-hidden />
          Réintégrer dans l’établissement
        </Button>
      ) : null}
      {canIdentity ? (
        <IdentitySheet student={student} open={open === 'identity'} onClose={() => setOpen(null)} />
      ) : null}
      {canEnroll && active ? (
        <>
          <ClassChangeSheet
            studentId={student.id}
            enrollment={enrollment}
            open={open === 'class'}
            onClose={() => setOpen(null)}
          />
          <ExitSheet
            student={student}
            enrollment={enrollment}
            open={open === 'exit'}
            onClose={() => setOpen(null)}
          />
        </>
      ) : null}
    </div>
  );
}
