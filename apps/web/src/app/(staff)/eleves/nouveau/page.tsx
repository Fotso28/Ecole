'use client';

import {
  guardianInputSchema,
  normalizeCameroonPhone,
  sameGuardianName,
  studentCreateSchema,
} from '@ecole/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Info, Link2, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox, InputField, SelectField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { formatDate, plural } from '@/lib/format';
import { useClasses } from '@/lib/queries';
import { cn } from '@/lib/utils';

interface Guardian {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  relationship: 'FATHER' | 'MOTHER' | 'TUTOR' | 'OTHER';
  isPrimary: boolean;
  isEmergencyContact: boolean;
  canPickUp: boolean;
  /** Choix explicite de rattacher l'élève au parent déjà enregistré avec ce numéro. */
  linkExistingGuardian: boolean;
}

/** Parent déjà enregistré sous un numéro saisi (réponse de l'API). */
interface KnownGuardian {
  phone: string;
  id: string;
  firstName: string;
  lastName: string;
  label: string;
}

interface Candidate {
  id: string;
  matricule: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  className: string | null;
  reasons: string[];
}

const REASONS: Record<string, string> = {
  same_name: 'Même nom',
  similar_name: 'Nom très proche',
  same_birth_date: 'Même date de naissance',
  same_birth_place: 'Même lieu de naissance',
  same_guardian_phone: 'Même téléphone de parent',
};

const STEPS = ['Identité', 'Parents', 'Classe', 'Vérification'] as const;
const identitySchema = studentCreateSchema.pick({
  firstName: true,
  lastName: true,
  gender: true,
  birthDate: true,
  birthPlace: true,
});
const emptyGuardian = (primary: boolean): Guardian => ({
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  relationship: 'FATHER',
  isPrimary: primary,
  isEmergencyContact: primary,
  canPickUp: true,
  linkExistingGuardian: false,
});

type Errors = Record<string, string>;

/** L'adresse e-mail est facultative : un champ vide n'est pas envoyé. */
const withoutEmptyEmail = (g: Guardian) => ({ ...g, email: g.email.trim() || undefined });

export default function NewStudentPage() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const classes = useClasses();
  const [step, setStep] = useState(0);
  const [identity, setIdentity] = useState({
    lastName: '',
    firstName: '',
    gender: '' as '' | 'F' | 'M',
    birthDate: '',
    birthPlace: '',
    nationality: 'Camerounaise',
    previousSchool: '',
    photoConsent: false,
  });
  const [guardians, setGuardians] = useState<Guardian[]>([emptyGuardian(true)]);
  const [classId, setClassId] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Parent déjà enregistré sous le numéro de chaque parent saisi (par rang). */
  const [known, setKnown] = useState<Record<number, KnownGuardian>>({});
  const phoneRefs = useRef<(HTMLInputElement | null)[]>([]);

  const payload = () => ({
    ...identity,
    gender: identity.gender || undefined,
    birthPlace: identity.birthPlace || undefined,
    previousSchool: identity.previousSchool || undefined,
    guardians: guardians.map(withoutEmptyEmail),
    classId: classId || undefined,
    confirmNotDuplicate: dismissed,
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; matricule: string }>('/students', { method: 'POST', body: payload() }),
    onSuccess: (st) => {
      void queryClient.invalidateQueries({ queryKey: ['students'] });
      toast(`Inscription enregistrée · matricule ${st.matricule}`);
      router.push(`/eleves/${st.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') {
        setCandidates((e.body.candidates as Candidate[]) ?? []);
        setStep(0);
        return;
      }
      if (e instanceof ApiError && e.code === 'GUARDIAN_PHONE_TAKEN') {
        const conflicts = (e.body.conflicts ?? []) as { index: number; existing: KnownGuardian }[];
        setKnown(Object.fromEntries(conflicts.map((c) => [c.index, c.existing])));
        setStep(1);
        return;
      }
      if (e instanceof ApiError && e.fieldErrors.length) {
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path, f.message])));
      }
      toast(e instanceof Error ? e.message : 'Erreur', 'error');
    },
  });

  const validateStep = (): boolean => {
    const next: Errors = {};
    if (step === 0) {
      const r = identitySchema.safeParse({
        ...identity,
        gender: identity.gender || undefined,
        birthPlace: identity.birthPlace || undefined,
      });
      if (!r.success)
        for (const i of r.error.issues)
          next[String(i.path[0])] = i.path[0] === 'gender' ? 'Choisissez le sexe' : i.message;
    }
    if (step === 1) {
      guardians.forEach((g, idx) => {
        const r = guardianInputSchema.safeParse(withoutEmptyEmail(g));
        if (!r.success)
          for (const i of r.error.issues) next[`guardians.${idx}.${String(i.path[0])}`] = i.message;
      });
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const goNext = async () => {
    if (!validateStep()) return;
    if (step === 0 && !dismissed) {
      setChecking(true);
      try {
        const found = await api<Candidate[]>('/students/check-duplicates', {
          method: 'POST',
          body: {
            firstName: identity.firstName,
            lastName: identity.lastName,
            birthDate: identity.birthDate,
            birthPlace: identity.birthPlace || undefined,
            guardianPhones: [],
          },
        });
        setCandidates(found);
        if (found.length > 0) return;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Vérification impossible', 'error');
        return;
      } finally {
        setChecking(false);
      }
    }
    if (step === 1) {
      // Numéro déjà connu : jamais de rattachement silencieux à une autre famille.
      setChecking(true);
      try {
        const found = await api<KnownGuardian[]>('/students/check-guardian-phones', {
          method: 'POST',
          body: { phones: guardians.map((g) => g.phone) },
        });
        const next: Record<number, KnownGuardian> = {};
        guardians.forEach((g, idx) => {
          const match = found.find((k) => k.phone === normalizeCameroonPhone(g.phone));
          if (match) next[idx] = match;
        });
        setKnown(next);
        if (guardians.some((g, idx) => next[idx] && needsChoice(g, next[idx]))) return;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Vérification impossible', 'error');
        return;
      } finally {
        setChecking(false);
      }
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
    window.scrollTo({ top: 0 });
  };

  const updateGuardian = (idx: number, patch: Partial<Guardian>) =>
    setGuardians((list) =>
      list.map((g, i) =>
        i === idx ? { ...g, ...patch } : patch.isPrimary ? { ...g, isPrimary: false } : g,
      ),
    );
  /** Nouveau numéro : le choix fait pour l'ancien ne vaut plus. */
  const changePhone = (idx: number, phone: string) => {
    updateGuardian(idx, { phone, linkExistingGuardian: false });
    setKnown(({ [idx]: _, ...rest }) => rest);
  };
  const err = (k: string) => errors[k];
  const selectedClass = classes.data?.find((c) => c.id === classId);

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-[26px] leading-tight font-bold lg:text-3xl">
            Nouvelle inscription
          </h1>
          <p className="text-sm text-muted">
            Étape {step + 1} sur {STEPS.length} · {STEPS[step]}
          </p>
        </div>
        <Link
          href="/eleves"
          className="flex min-h-11 items-center gap-1 text-sm font-semibold text-primary"
        >
          <X className="size-4" aria-hidden />
          Annuler
        </Link>
      </div>

      <ol aria-label="Étapes" className="grid grid-cols-4 gap-1.5">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? 'step' : undefined}
            className="flex flex-col gap-1.5"
          >
            <span className={cn('h-1.5 rounded-full', i <= step ? 'bg-primary' : 'bg-line')} />
            <span
              className={cn('hidden text-[13px] sm:block', i === step ? 'font-bold' : 'text-muted')}
            >
              {label}
            </span>
          </li>
        ))}
      </ol>

      {candidates.length > 0 && !dismissed ? (
        <section
          aria-live="polite"
          className="flex flex-col gap-3 rounded-[16px] border border-[#f1d99a] bg-warn-soft p-4"
        >
          <div className="flex gap-2.5">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden />
            <div>
              <h2 className="font-bold">Ce dossier existe peut-être déjà</h2>
              <p className="text-sm text-muted">Vérifiez avant de créer un second matricule.</p>
            </div>
          </div>
          {candidates.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 rounded-[12px] bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>
                  {c.lastName} {c.firstName}
                </strong>
                <span className="text-xs text-muted tabular">
                  {c.matricule}
                  {c.className ? ` · ${c.className}` : ''} · né(e) le {formatDate(c.birthDate)}
                </span>
              </div>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                {c.reasons.map((r) => (
                  <li key={r} className="flex items-center gap-1">
                    <Check className="size-3.5 text-primary" aria-hidden />
                    {REASONS[r] ?? r}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link
              href={`/eleves/${candidates[0]?.id}`}
              className="flex min-h-12 items-center justify-center rounded-[10px] bg-primary px-4 text-sm font-semibold text-white lg:min-h-10"
            >
              Ouvrir le dossier existant
            </Link>
            <Button
              variant="secondary"
              onClick={() => {
                setDismissed(true);
                setStep((s) => (s === 0 ? 1 : s));
              }}
            >
              Ce n’est pas la même personne
            </Button>
          </div>
        </section>
      ) : null}

      <Card className="flex flex-col gap-4">
        {step === 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <InputField
              label="Nom"
              autoComplete="off"
              value={identity.lastName}
              onChange={(e) => setIdentity({ ...identity, lastName: e.target.value })}
              error={err('lastName')}
            />
            <InputField
              label="Prénoms"
              autoComplete="off"
              value={identity.firstName}
              onChange={(e) => setIdentity({ ...identity, firstName: e.target.value })}
              error={err('firstName')}
            />
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-semibold lg:text-[13px]">Sexe</legend>
              <div className="grid grid-cols-2 gap-2">
                {(['F', 'M'] as const).map((g) => (
                  <label
                    key={g}
                    className={cn(
                      'flex min-h-12 items-center gap-2 rounded-[10px] border px-3 text-[15px] font-semibold lg:min-h-10 lg:text-sm',
                      identity.gender === g
                        ? 'border-2 border-primary bg-primary-soft'
                        : 'border-line-strong',
                    )}
                  >
                    <input
                      type="radio"
                      name="gender"
                      className="accent-primary"
                      checked={identity.gender === g}
                      onChange={() => setIdentity({ ...identity, gender: g })}
                    />
                    {g === 'F' ? 'Fille' : 'Garçon'}
                  </label>
                ))}
              </div>
              {err('gender') ? (
                <span className="text-[13px] font-medium text-danger">{err('gender')}</span>
              ) : null}
            </fieldset>
            <InputField
              label="Date de naissance"
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={identity.birthDate}
              onChange={(e) => setIdentity({ ...identity, birthDate: e.target.value })}
              error={err('birthDate')}
            />
            <InputField
              label="Lieu de naissance"
              value={identity.birthPlace}
              onChange={(e) => setIdentity({ ...identity, birthPlace: e.target.value })}
              optional
            />
            <InputField
              label="Nationalité"
              value={identity.nationality}
              onChange={(e) => setIdentity({ ...identity, nationality: e.target.value })}
            />
            <InputField
              label="Établissement d’origine"
              value={identity.previousSchool}
              onChange={(e) => setIdentity({ ...identity, previousSchool: e.target.value })}
              optional
              containerClassName="sm:col-span-2"
            />
            <Checkbox
              className="sm:col-span-2"
              label="Les parents autorisent l’usage de la photo pour la carte d’élève et le dossier scolaire."
              checked={identity.photoConsent}
              onChange={(e) => setIdentity({ ...identity, photoConsent: e.target.checked })}
            />
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            {guardians.map((g, idx) => (
              <fieldset
                key={idx}
                className="flex flex-col gap-3 rounded-[12px] border border-line p-3 lg:p-4"
              >
                <legend className="px-1 text-sm font-bold">Parent ou tuteur {idx + 1}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <InputField
                    label="Nom"
                    value={g.lastName}
                    onChange={(e) => updateGuardian(idx, { lastName: e.target.value })}
                    error={err(`guardians.${idx}.lastName`)}
                  />
                  <InputField
                    label="Prénom"
                    value={g.firstName}
                    onChange={(e) => updateGuardian(idx, { firstName: e.target.value })}
                    error={err(`guardians.${idx}.firstName`)}
                  />
                  <InputField
                    ref={(el) => {
                      phoneRefs.current[idx] = el;
                    }}
                    label="Téléphone"
                    type="tel"
                    inputMode="tel"
                    placeholder="6 77 12 34 56"
                    value={g.phone}
                    onChange={(e) => changePhone(idx, e.target.value)}
                    error={err(`guardians.${idx}.phone`)}
                    hint="Sert à la connexion au portail par SMS."
                  />
                  <InputField
                    label="Adresse e-mail"
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    optional
                    value={g.email}
                    onChange={(e) => updateGuardian(idx, { email: e.target.value })}
                    error={err(`guardians.${idx}.email`)}
                    hint="Pour recevoir les notifications par e-mail."
                  />
                  <SelectField
                    label="Lien"
                    value={g.relationship}
                    onChange={(e) =>
                      updateGuardian(idx, {
                        relationship: e.target.value as Guardian['relationship'],
                      })
                    }
                  >
                    <option value="FATHER">Père</option>
                    <option value="MOTHER">Mère</option>
                    <option value="TUTOR">Tuteur</option>
                    <option value="OTHER">Autre</option>
                  </SelectField>
                </div>
                {known[idx] ? (
                  <KnownGuardianNotice
                    guardian={g}
                    known={known[idx]}
                    onLink={() =>
                      updateGuardian(idx, {
                        linkExistingGuardian: true,
                        firstName: known[idx]!.firstName,
                        lastName: known[idx]!.lastName,
                      })
                    }
                    onUnlink={() => updateGuardian(idx, { linkExistingGuardian: false })}
                    onFix={() => {
                      setKnown(({ [idx]: _, ...rest }) => rest);
                      phoneRefs.current[idx]?.focus();
                      phoneRefs.current[idx]?.select();
                    }}
                  />
                ) : null}
                <div className="grid gap-1 sm:grid-cols-3">
                  <Checkbox
                    label="Contact principal"
                    checked={g.isPrimary}
                    onChange={(e) =>
                      updateGuardian(idx, { isPrimary: e.target.checked || guardians.length === 1 })
                    }
                  />
                  <Checkbox
                    label="À prévenir en urgence"
                    checked={g.isEmergencyContact}
                    onChange={(e) => updateGuardian(idx, { isEmergencyContact: e.target.checked })}
                  />
                  <Checkbox
                    label="Peut récupérer l’enfant"
                    checked={g.canPickUp}
                    onChange={(e) => updateGuardian(idx, { canPickUp: e.target.checked })}
                  />
                </div>
                {guardians.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-start text-danger"
                    onClick={() => {
                      setKnown({});
                      setGuardians((l) => {
                        const rest = l.filter((_, i) => i !== idx);
                        if (!rest.some((x) => x.isPrimary) && rest[0])
                          rest[0] = { ...rest[0], isPrimary: true };
                        return rest;
                      });
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    Retirer
                  </Button>
                ) : null}
              </fieldset>
            ))}
            {guardians.length < 4 ? (
              <Button
                variant="secondary"
                onClick={() => setGuardians((l) => [...l, emptyGuardian(false)])}
              >
                <Plus className="size-4" aria-hidden />
                Ajouter un parent ou tuteur
              </Button>
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-3">
            <SelectField
              label="Classe pour l’année en cours"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              hint="L’échéancier de scolarité est créé automatiquement à partir de la grille de frais du niveau."
            >
              <option value="">Inscrire plus tard</option>
              {classes.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {plural(c._count.enrollments, 'élève', 'élèves')}
                </option>
              ))}
            </SelectField>
          </div>
        ) : null}

        {step === 3 ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex flex-col">
              <dt className="text-muted">Élève</dt>
              <dd className="font-semibold">
                {identity.lastName.toUpperCase()} {identity.firstName} ·{' '}
                {identity.gender === 'F' ? 'fille' : 'garçon'}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted">Naissance</dt>
              <dd className="font-semibold">
                {identity.birthDate ? formatDate(identity.birthDate) : '—'}
                {identity.birthPlace ? ` à ${identity.birthPlace}` : ''}
              </dd>
            </div>
            <div className="flex flex-col sm:col-span-2">
              <dt className="text-muted">Parents</dt>
              {guardians.map((g, i) => (
                <dd key={i} className="font-semibold">
                  {g.firstName} {g.lastName} · {g.phone}
                  {g.isPrimary ? ' · contact principal' : ''}
                  {known[i] ? ' · parent déjà enregistré' : ''}
                </dd>
              ))}
            </div>
            <div className="flex flex-col">
              <dt className="text-muted">Classe</dt>
              <dd className="font-semibold">{selectedClass?.name ?? 'À inscrire plus tard'}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted">Matricule</dt>
              <dd className="font-semibold">Attribué à la validation</dd>
            </div>
          </dl>
        ) : null}
      </Card>

      <div className="sticky bottom-20 z-20 -mx-4 flex gap-2 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0">
        {step > 0 ? (
          <Button
            variant="secondary"
            onClick={() => setStep((s) => s - 1)}
            className="flex-1 lg:flex-none"
          >
            Précédent
          </Button>
        ) : null}
        {step < STEPS.length - 1 ? (
          <Button
            onClick={() => void goNext()}
            loading={checking}
            className="flex-[2] lg:ml-auto lg:flex-none"
          >
            Continuer : {STEPS[step + 1]?.toLowerCase()}
          </Button>
        ) : (
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            className="flex-[2] lg:ml-auto lg:flex-none"
          >
            Valider l’inscription
          </Button>
        )}
      </div>
    </>
  );
}

/** Le nom saisi diffère de celui du parent déjà enregistré, et aucun choix n'a été fait. */
function needsChoice(g: Guardian, known: KnownGuardian): boolean {
  return !g.linkExistingGuardian && !sameGuardianName(g, known);
}

/**
 * Numéro déjà attribué à un parent : rattachement explicite à ce parent, ou correction du
 * numéro. Un même nom (frère ou sœur déjà inscrit) est simplement signalé.
 */
function KnownGuardianNotice({
  guardian,
  known,
  onLink,
  onUnlink,
  onFix,
}: {
  guardian: Guardian;
  known: KnownGuardian;
  onLink: () => void;
  onUnlink: () => void;
  onFix: () => void;
}) {
  if (guardian.linkExistingGuardian)
    return (
      <div
        aria-live="polite"
        className="flex flex-col gap-2 rounded-[12px] bg-primary-soft p-3 text-sm sm:flex-row sm:items-center"
      >
        <Link2 className="size-5 shrink-0 text-primary" aria-hidden />
        <p className="flex-1">
          L’élève sera rattaché au parent déjà enregistré : <strong>{known.label}</strong>.
        </p>
        <Button variant="ghost" size="sm" onClick={onUnlink}>
          Annuler le rattachement
        </Button>
      </div>
    );
  if (!needsChoice(guardian, known))
    return (
      <p aria-live="polite" className="flex gap-2 rounded-[12px] bg-primary-soft p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span>
          Parent déjà enregistré : <strong>{known.label}</strong>. L’élève lui sera rattaché.
        </span>
      </p>
    );
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-[12px] border border-[#f1d99a] bg-warn-soft p-3 text-sm"
    >
      <p className="flex gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
        <span>
          Ce numéro appartient déjà à <strong>{known.label}</strong>. Rattachez l’élève à ce parent,
          ou corrigez le numéro s’il a été mal saisi.
        </span>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="sm" onClick={onLink}>
          Rattacher à {known.firstName} {known.lastName}
        </Button>
        <Button size="sm" variant="secondary" onClick={onFix}>
          Corriger le numéro
        </Button>
      </div>
    </div>
  );
}
