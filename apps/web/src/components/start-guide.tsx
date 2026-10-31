'use client';

import { useMutation } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, PageHeader } from '@/components/ui/card';
import { InputField } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { todayIso } from '@/lib/format';

/** Année scolaire proposée : rentrée en septembre, fin en juin. */
function proposedYear(today: string) {
  const y = Number(today.slice(0, 4));
  const start = Number(today.slice(5, 7)) >= 7 ? y : y - 1;
  return {
    name: `${start}-${start + 1}`,
    startDate: `${start}-09-07`,
    endDate: `${start + 1}-06-30`,
  };
}

const NEXT_STEPS = [
  {
    href: '/structure',
    title: 'Trimestres, classes et matières',
    text: 'Découpez l’année, créez les classes et attribuez les matières aux enseignants.',
    permission: 'academic.write',
  },
  {
    href: '/personnel',
    title: 'Personnel',
    text: 'Créez les comptes du secrétariat, de la comptabilité et des enseignants.',
    permission: 'staff.write',
  },
  {
    href: '/parametres',
    title: 'Paramètres de l’établissement',
    text: 'Coordonnées, modules, seuils d’absence et règles du conseil de classe.',
    permission: 'settings.write',
  },
  {
    href: '/eleves/nouveau',
    title: 'Premières inscriptions',
    text: 'Inscrivez les élèves un par un ou importez une liste.',
    permission: 'students.write',
  },
] as const;

/**
 * Premier écran d'une école neuve, sans année scolaire en cours : guide de démarrage au lieu d'un
 * message d'erreur. La première étape (créer l'année) se fait sur place.
 */
export function StartGuide() {
  const { me, can, reload } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState(() => proposedYear(todayIso()));
  const create = useMutation({
    mutationFn: async () => {
      const year = await api<{ id: string; name: string }>('/academic/years', {
        method: 'POST',
        body: form,
      });
      await api(`/academic/years/${year.id}/current`, { method: 'POST' });
      return year;
    },
    onSuccess: async (year) => {
      toast(`Année ${year.name} créée et définie comme année en cours`);
      await reload();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Erreur', 'error'),
  });
  const steps = NEXT_STEPS.filter((s) => can(s.permission));

  return (
    <>
      <PageHeader
        title={`Bienvenue, ${me?.user.firstName ?? ''}`}
        subtitle={`${me?.activeSchool?.name ?? 'Votre établissement'} est prêt à être configuré. Suivez ces étapes pour démarrer.`}
      />
      <Card>
        <CardHeader
          title="1. Créer l’année scolaire"
          subtitle="Toutes les pages (élèves, appel, notes, scolarité) s’appuient sur l’année en cours."
        />
        {can('academic.write') ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <InputField
                label="Nom de l’année"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="2026-2027"
                pattern="\d{4}-\d{4}"
                required
              />
              <InputField
                label="Rentrée"
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                required
              />
              <InputField
                label="Fin d’année"
                type="date"
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                required
              />
            </div>
            <Button type="submit" className="self-start" loading={create.isPending}>
              Créer l’année {form.name}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted">
            Aucune année scolaire en cours : la direction doit la créer.
          </p>
        )}
      </Card>
      {steps.length ? (
        <Card>
          <CardHeader title="Ensuite" />
          <ol className="flex flex-col">
            {steps.map((s, i) => (
              <li key={s.href} className="border-t border-line first:border-t-0">
                <Link href={s.href} className="flex min-h-14 items-center gap-3 py-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary">
                    {i + 2}
                  </span>
                  <span className="flex flex-1 flex-col">
                    <strong className="text-[15px] lg:text-sm">{s.title}</strong>
                    <span className="text-[13px] text-muted">{s.text}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </>
  );
}
