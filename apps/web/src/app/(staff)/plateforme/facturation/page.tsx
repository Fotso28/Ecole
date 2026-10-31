'use client';

import {
  MODULES,
  SUBSCRIPTION_MODULE_LABELS,
  SUBSCRIPTION_PRICING_LABELS,
  type SubscriptionInvoiceState,
  type SubscriptionPricing,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PlatformError, StateBadge } from '@/components/billing';
import { Card, CardHeader, EmptyState, LoadingBlock, PageHeader, Stat } from '@/components/ui/card';
import { InputField, SelectField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { BillingWarning, Plan } from '@/lib/billing';
import { formatFcfa, plural } from '@/lib/format';

interface Overview {
  summary: { schools: number; invoiced: number; paid: number; due: number; overdue: number };
  schools: {
    id: string;
    name: string;
    city: string;
    status: 'ACTIVE' | 'SUSPENDED';
    modulesCount: number;
    studentCount: number;
    plan: { id: string; name: string } | null;
    estimate: number | null;
    invoiced: number;
    paid: number;
    due: number;
    latest: { number: string; state: SubscriptionInvoiceState } | null;
    warning: BillingWarning | null;
  }[];
}

function planSummary(plan: Plan): string {
  if (plan.pricing === 'PER_STUDENT')
    return `${formatFcfa(plan.pricePerStudent)} par élève et par an`;
  const priced = Object.entries(plan.modulePrices).filter(([, v]) => v > 0);
  return `${plural(priced.length, 'module payant', 'modules payants')} · ${formatFcfa(
    priced.reduce((s, [, v]) => s + v, 0),
  )} par an au total`;
}

function NewPlanSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pricing, setPricing] = useState<SubscriptionPricing>('PER_STUDENT');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Plan>('/platform/billing/plans', { method: 'POST', body }),
    onSuccess: (plan) => {
      toast(`Offre « ${plan.name} » créée`);
      void queryClient.invalidateQueries({ queryKey: ['billing-plans'] });
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Erreur'),
  });
  return (
    <Sheet open={open} onClose={onClose} title="Nouvelle offre">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const fd = new FormData(e.currentTarget);
          const modulePrices: Record<string, number> = {};
          for (const m of MODULES) {
            const v = Number(fd.get(`module-${m}`) || 0);
            if (v > 0) modulePrices[m] = v;
          }
          create.mutate({
            name: String(fd.get('name') ?? ''),
            pricing,
            ...(pricing === 'PER_STUDENT'
              ? { pricePerStudent: Number(fd.get('pricePerStudent') || 0) }
              : { modulePrices }),
          });
        }}
      >
        <InputField label="Nom de l’offre" name="name" required maxLength={80} />
        <SelectField
          label="Mode de tarification"
          value={pricing}
          onChange={(e) => setPricing(e.target.value as SubscriptionPricing)}
        >
          {Object.entries(SUBSCRIPTION_PRICING_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </SelectField>
        {pricing === 'PER_STUDENT' ? (
          <InputField
            label="Prix par élève et par an (FCFA)"
            name="pricePerStudent"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            required
          />
        ) : (
          <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">
              Prix annuel par module (FCFA, vide = inclus)
            </legend>
            {MODULES.map((m) => (
              <InputField
                key={m}
                label={SUBSCRIPTION_MODULE_LABELS[m]}
                name={`module-${m}`}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
              />
            ))}
          </fieldset>
        )}
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={create.isPending}>
          Créer l’offre
        </Button>
      </form>
    </Sheet>
  );
}

/** « Lycée Bilingue de Bafoussam » → « lycee-bilingue-de-bafoussam ». */
function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function NewSchoolSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ school: { name: string }; existingUser: boolean }>('/platform/schools', {
        method: 'POST',
        body,
      }),
    onSuccess: (r, body) => {
      const email = (body.director as { email: string }).email;
      toast(
        r.existingUser
          ? `Établissement « ${r.school.name} » créé · ${email} y est rattaché comme direction (mot de passe inchangé)`
          : `Établissement « ${r.school.name} » créé · la direction se connecte avec ${email}`,
      );
      void queryClient.invalidateQueries({ queryKey: ['billing-overview'] });
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Erreur'),
  });
  return (
    <Sheet open={open} onClose={onClose} title="Nouvel établissement">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const fd = new FormData(e.currentTarget);
          const text = (k: string) => String(fd.get(k) ?? '').trim();
          create.mutate({
            name: name.trim(),
            slug,
            city: text('city'),
            matriculePrefix: text('matriculePrefix').toUpperCase(),
            director: {
              firstName: text('firstName'),
              lastName: text('lastName'),
              email: text('email'),
              password: String(fd.get('password') ?? ''),
            },
          });
        }}
      >
        <InputField
          label="Nom de l’établissement"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
          required
          maxLength={80}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InputField label="Ville" name="city" required maxLength={80} />
          <InputField
            label="Préfixe des matricules"
            name="matriculePrefix"
            required
            pattern="[A-Za-z0-9]{1,6}"
            maxLength={6}
            hint="1 à 6 lettres ou chiffres, par exemple LBB"
            autoCapitalize="characters"
          />
        </div>
        <InputField
          label="Identifiant"
          value={slug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value.toLowerCase());
          }}
          required
          pattern="[a-z0-9\-]{3,40}"
          hint="Minuscules, chiffres et tirets ; unique sur la plateforme"
        />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Direction de l’établissement</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InputField label="Prénom" name="firstName" required maxLength={80} />
            <InputField label="Nom" name="lastName" required maxLength={80} />
          </div>
          <InputField
            label="Adresse e-mail"
            name="email"
            type="email"
            required
            autoComplete="off"
            hint="Un compte existant est rattaché tel quel, sans changer son mot de passe."
          />
          <InputField
            label="Mot de passe provisoire"
            name="password"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            hint="10 caractères au minimum, à transmettre à la direction."
          />
        </fieldset>
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={create.isPending}>
          Créer l’établissement
        </Button>
      </form>
    </Sheet>
  );
}

export default function PlatformBillingPage() {
  const [newPlan, setNewPlan] = useState(false);
  const [newSchool, setNewSchool] = useState(0);
  const q = useQuery({
    queryKey: ['billing-overview'],
    queryFn: () => api<Overview>('/platform/billing/schools'),
  });
  const plans = useQuery({
    queryKey: ['billing-plans'],
    queryFn: () => api<Plan[]>('/platform/billing/plans'),
  });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <PlatformError error={q.error} onRetry={() => q.refetch()} />;
  const { summary, schools } = q.data;
  return (
    <>
      <PageHeader
        title="Facturation des écoles"
        subtitle="Abonnements calculés sur les effectifs et les modules activés. Aucune donnée d’élève n’est consultée."
        actions={
          <Button onClick={() => setNewSchool((n) => n + 1)}>
            <Plus className="size-4" aria-hidden />
            Nouvel établissement
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Facturé" value={formatFcfa(summary.invoiced, false)} hint="FCFA" />
        <Stat label="Encaissé" value={formatFcfa(summary.paid, false)} hint="FCFA" />
        <Stat
          label="Reste à encaisser"
          value={formatFcfa(summary.due, false)}
          hint="FCFA"
          tone={summary.due > 0 ? 'danger' : 'default'}
        />
        <Stat label="Écoles en retard" value={summary.overdue} hint={`sur ${summary.schools}`} />
      </div>

      <Card>
        <CardHeader
          title="Offres"
          subtitle="Prix annuels en FCFA, par élève inscrit ou par module activé."
          action={
            <Button size="sm" variant="secondary" onClick={() => setNewPlan(true)}>
              Nouvelle offre
            </Button>
          }
        />
        {plans.data?.length ? (
          <ul className="flex flex-col">
            {plans.data.map((p) => (
              <li
                key={p.id}
                className="flex flex-col gap-0.5 border-t border-line py-2.5 text-sm first:border-t-0 sm:flex-row sm:items-center sm:gap-3"
              >
                <strong className="font-semibold sm:w-48">{p.name}</strong>
                <span className="flex-1 text-muted">{planSummary(p)}</span>
                {!p.active ? <Badge>Archivée</Badge> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Aucune offre pour l’instant.</p>
        )}
      </Card>

      <h2 className="text-lg font-bold">Établissements</h2>
      {schools.length === 0 ? (
        <EmptyState title="Aucun établissement">
          Créez un établissement avec le bouton « Nouvel établissement » pour le facturer.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2 md:hidden">
            {schools.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/plateforme/facturation/${s.id}`}
                  className="flex items-center gap-3 rounded-[14px] border border-line bg-white p-3"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="truncate text-[15px]">{s.name}</strong>
                    <span className="truncate text-[13px] text-muted">
                      {s.plan?.name ?? 'Sans offre'} · {plural(s.studentCount, 'élève', 'élèves')}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {s.latest ? <StateBadge state={s.latest.state} /> : <Badge>À facturer</Badge>}
                    {s.due > 0 ? (
                      <span className="text-[13px] font-semibold text-danger tabular">
                        {formatFcfa(s.due)}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-[14px] border border-line bg-white md:block">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-paper text-left text-xs tracking-[0.06em] text-muted uppercase">
                <tr>
                  <th className="px-4 py-3 font-semibold">Établissement</th>
                  <th className="px-3 py-3 font-semibold">Offre</th>
                  <th className="px-3 py-3 text-right font-semibold">Élèves</th>
                  <th className="px-3 py-3 text-right font-semibold">Estimation annuelle</th>
                  <th className="px-3 py-3 text-right font-semibold">Reste à payer</th>
                  <th className="px-4 py-3 font-semibold">Dernière facture</th>
                </tr>
              </thead>
              <tbody>
                {schools.map((s) => (
                  <tr key={s.id} className="border-t border-line hover:bg-paper/60">
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col">
                        <Link
                          href={`/plateforme/facturation/${s.id}`}
                          className="font-semibold hover:underline"
                        >
                          {s.name}
                        </Link>
                        <span className="text-xs text-muted">
                          {s.city} · {plural(s.modulesCount, 'module', 'modules')}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">{s.plan?.name ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular">{s.studentCount}</td>
                    <td className="px-3 py-2.5 text-right tabular">
                      {s.estimate === null ? '—' : formatFcfa(s.estimate)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular">
                      {s.due > 0 ? (
                        <span className="font-semibold text-danger">{formatFcfa(s.due)}</span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.latest ? (
                        <span className="flex items-center gap-2">
                          <span className="tabular">{s.latest.number}</span>
                          <StateBadge state={s.latest.state} />
                        </span>
                      ) : (
                        <Badge>À facturer</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <NewPlanSheet open={newPlan} onClose={() => setNewPlan(false)} />
      {/* Nouvelle clé à chaque ouverture : formulaire vide. */}
      <NewSchoolSheet key={newSchool} open={newSchool > 0} onClose={() => setNewSchool(0)} />
    </>
  );
}
