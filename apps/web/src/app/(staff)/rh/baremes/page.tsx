'use client';

import {
  formatFcfa,
  formatRateBp,
  type AmountBracket,
  type PayrollScale,
  type RateBracket,
} from '@ecole/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Plus, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui/card';
import { Checkbox, InputField, TextareaField } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatShortDate, todayIso } from '@/lib/format';

interface ScalesResponse {
  default: PayrollScale;
  versions: { id: string; effectiveFrom: string; label: string; config: PayrollScale }[];
}

const pct = (bp: number) => String(bp / 100).replace('.', ',');
/** « 4,2 » → 420 points de base. */
const toBp = (v: FormDataEntryValue | null) =>
  Math.round(Number(String(v ?? '').replace(',', '.')) * 100);
const int = (v: FormDataEntryValue | null) => Math.trunc(Number(v ?? 0));

function bracketsText(b: AmountBracket[]): string {
  return b.map((x) => `${x.upTo === null ? '*' : x.upTo} = ${x.amount}`).join('\n');
}
function parseBrackets(text: string): AmountBracket[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [upTo, amount] = l.split('=').map((p) => p.trim().replace(/\s/g, ''));
      return { upTo: upTo === '*' ? null : Number(upTo), amount: Number(amount) };
    });
}
function rateBracketsText(b: RateBracket[]): string {
  return b.map((x) => `${x.upTo === null ? '*' : x.upTo} = ${pct(x.rate)}`).join('\n');
}
function parseRateBrackets(text: string): RateBracket[] {
  return parseBrackets(text.replace(/,/g, '.')).map((b) => ({
    upTo: b.upTo,
    rate: Math.round(b.amount * 100),
  }));
}

function ScaleView({ scale }: { scale: PayrollScale }) {
  const rows: [string, string][] = [
    ['CNPS pension vieillesse, salarié', formatRateBp(scale.cnps.employeeRate)],
    ['CNPS pension vieillesse, employeur', formatRateBp(scale.cnps.employerPensionRate)],
    ['CNPS prestations familiales, employeur', formatRateBp(scale.cnps.familyRate)],
    ['CNPS risques professionnels, employeur', formatRateBp(scale.cnps.accidentRate)],
    ['Plafond mensuel CNPS', formatFcfa(scale.cnps.ceiling)],
    ['Crédit foncier, salarié', formatRateBp(scale.housing.employeeRate)],
    ['Crédit foncier, employeur', formatRateBp(scale.housing.employerRate)],
    ['Fonds national de l’emploi, employeur', formatRateBp(scale.employment.employerRate)],
    ['IRPP : abattement frais professionnels', formatRateBp(scale.irpp.professionalExpensesRate)],
    ['IRPP : abattement annuel', formatFcfa(scale.irpp.annualAllowance)],
    ['IRPP : exonération sous (brut mensuel)', formatFcfa(scale.irpp.monthlyExemption)],
    ['Centimes additionnels communaux', `${formatRateBp(scale.cac.rate)} de l’IRPP`],
  ];
  const range = (upTo: number | null, prev: number | null) =>
    upTo === null ? `au-delà de ${formatFcfa(prev ?? 0)}` : `jusqu’à ${formatFcfa(upTo)}`;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Cotisations et impôts" />
        <dl className="flex flex-col gap-1.5 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-muted">{label}</dt>
              <dd className="text-right font-semibold tabular">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card>
        <CardHeader title="IRPP : barème annuel" subtitle="Sur le revenu net imposable annuel." />
        <ul className="flex flex-col gap-1 text-sm">
          {scale.irpp.brackets.map((b, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="text-muted">
                {range(b.upTo, scale.irpp.brackets[i - 1]?.upTo ?? null)}
              </span>
              <span className="font-semibold tabular">{formatRateBp(b.rate)}</span>
            </li>
          ))}
        </ul>
      </Card>
      {(
        [
          ['Redevance audiovisuelle', 'Montant mensuel selon le brut taxable.', scale.audiovisual],
          ['Taxe communale', 'Montant mensuel selon le salaire de base.', scale.communal],
        ] as const
      ).map(([title, subtitle, brackets]) => (
        <Card key={title}>
          <CardHeader title={title} subtitle={subtitle} />
          <ul className="flex flex-col gap-1 text-sm">
            {brackets.map((b, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="text-muted">{range(b.upTo, brackets[i - 1]?.upTo ?? null)}</span>
                <span className="font-semibold tabular">{formatFcfa(b.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function NewVersionSheet({
  base,
  open,
  onClose,
}: {
  base: PayrollScale;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: PayrollScale) => api('/hr/scales', { method: 'POST', body }),
    onSuccess: () => {
      toast('Nouvelle version du barème enregistrée');
      void queryClient.invalidateQueries({ queryKey: ['hr', 'scales'] });
      setError(null);
      onClose();
    },
    onError: (e) => {
      const detail =
        e instanceof ApiError && e.fieldErrors.length
          ? e.fieldErrors.map((f) => `${f.path} : ${f.message}`).join(' ; ')
          : null;
      setError(detail ?? (e instanceof Error ? e.message : 'Erreur'));
    },
  });
  return (
    <Sheet open={open} onClose={onClose} title="Nouvelle version du barème">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          save.mutate({
            effectiveFrom: String(fd.get('effectiveFrom')),
            label: String(fd.get('label')),
            cnps: {
              employeeRate: toBp(fd.get('cnpsEmployee')),
              employerPensionRate: toBp(fd.get('cnpsPension')),
              familyRate: toBp(fd.get('cnpsFamily')),
              accidentRate: toBp(fd.get('cnpsAccident')),
              ceiling: int(fd.get('cnpsCeiling')),
            },
            housing: {
              employeeRate: toBp(fd.get('housingEmployee')),
              employerRate: toBp(fd.get('housingEmployer')),
            },
            employment: { employerRate: toBp(fd.get('employment')) },
            irpp: {
              professionalExpensesRate: toBp(fd.get('irppExpenses')),
              annualAllowance: int(fd.get('irppAllowance')),
              monthlyExemption: int(fd.get('irppExemption')),
              brackets: parseRateBrackets(String(fd.get('irppBrackets'))),
            },
            cac: { rate: toBp(fd.get('cac')) },
            audiovisual: parseBrackets(String(fd.get('audiovisual'))),
            communal: parseBrackets(String(fd.get('communal'))),
            toVerify: fd.get('toVerify') === 'on',
          });
        }}
      >
        <p className="text-[13px] text-muted">
          Taux en pourcentage (« 4,2 » pour 4,2 %), montants en FCFA. Tranches : une ligne par
          tranche, « plafond = valeur », la dernière ligne commence par « * ».
        </p>
        <InputField
          label="Applicable à partir du"
          name="effectiveFrom"
          type="date"
          required
          defaultValue={todayIso()}
        />
        <InputField label="Intitulé" name="label" required defaultValue={base.label} />
        <div className="grid grid-cols-2 gap-3">
          <InputField
            label="CNPS salarié (%)"
            name="cnpsEmployee"
            inputMode="decimal"
            defaultValue={pct(base.cnps.employeeRate)}
          />
          <InputField
            label="CNPS pension employeur (%)"
            name="cnpsPension"
            inputMode="decimal"
            defaultValue={pct(base.cnps.employerPensionRate)}
          />
          <InputField
            label="Prestations familiales (%)"
            name="cnpsFamily"
            inputMode="decimal"
            defaultValue={pct(base.cnps.familyRate)}
          />
          <InputField
            label="Risques professionnels (%)"
            name="cnpsAccident"
            inputMode="decimal"
            defaultValue={pct(base.cnps.accidentRate)}
          />
          <InputField
            label="Plafond CNPS (FCFA)"
            name="cnpsCeiling"
            type="number"
            inputMode="numeric"
            defaultValue={base.cnps.ceiling}
          />
          <InputField
            label="FNE employeur (%)"
            name="employment"
            inputMode="decimal"
            defaultValue={pct(base.employment.employerRate)}
          />
          <InputField
            label="Crédit foncier salarié (%)"
            name="housingEmployee"
            inputMode="decimal"
            defaultValue={pct(base.housing.employeeRate)}
          />
          <InputField
            label="Crédit foncier employeur (%)"
            name="housingEmployer"
            inputMode="decimal"
            defaultValue={pct(base.housing.employerRate)}
          />
          <InputField
            label="IRPP frais professionnels (%)"
            name="irppExpenses"
            inputMode="decimal"
            defaultValue={pct(base.irpp.professionalExpensesRate)}
          />
          <InputField
            label="CAC (% de l’IRPP)"
            name="cac"
            inputMode="decimal"
            defaultValue={pct(base.cac.rate)}
          />
          <InputField
            label="IRPP abattement annuel"
            name="irppAllowance"
            type="number"
            inputMode="numeric"
            defaultValue={base.irpp.annualAllowance}
          />
          <InputField
            label="IRPP exonération sous"
            name="irppExemption"
            type="number"
            inputMode="numeric"
            defaultValue={base.irpp.monthlyExemption}
          />
        </div>
        <TextareaField
          label="Barème IRPP annuel (plafond = taux %)"
          name="irppBrackets"
          rows={4}
          defaultValue={rateBracketsText(base.irpp.brackets)}
        />
        <TextareaField
          label="Redevance audiovisuelle (plafond = montant)"
          name="audiovisual"
          rows={6}
          defaultValue={bracketsText(base.audiovisual)}
        />
        <TextareaField
          label="Taxe communale (plafond = montant)"
          name="communal"
          rows={6}
          defaultValue={bracketsText(base.communal)}
        />
        <Checkbox
          name="toVerify"
          defaultChecked={base.toVerify}
          label="Taux encore à vérifier par un comptable"
        />
        {error ? (
          <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={save.isPending}>
          Enregistrer la nouvelle version
        </Button>
      </form>
    </Sheet>
  );
}

export default function ScalesPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['hr', 'scales'],
    queryFn: () => api<ScalesResponse>('/hr/scales'),
  });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => q.refetch()} />;
  const latest = q.data.versions[0]?.config ?? q.data.default;
  return (
    <>
      <Link
        href="/rh/paie"
        className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-primary"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Paie
      </Link>
      <PageHeader
        title="Barèmes de paie"
        subtitle="Cotisations sociales et impôts sur salaire, datés : chaque paie applique la version en vigueur pour son mois et la conserve."
        actions={
          can('hr.payroll.validate') ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Nouvelle version
            </Button>
          ) : undefined
        }
      />
      {latest.toVerify ? (
        <p
          role="note"
          className="flex items-start gap-2 rounded-[12px] bg-warn-soft p-3 text-sm text-warn"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          Valeurs camerounaises préremplies : chaque taux est à vérifier par un comptable avant la
          première paie (loi de finances de l’année, barèmes CNPS).
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-bold">{latest.label}</h2>
        <Badge tone="info">Depuis le {formatShortDate(latest.effectiveFrom)}</Badge>
      </div>
      <ScaleView scale={latest} />
      {q.data.versions.length > 0 ? (
        <Card>
          <CardHeader title="Historique des versions" />
          <ul className="flex flex-col gap-1 text-sm">
            {q.data.versions.map((v) => (
              <li key={v.id}>
                {formatShortDate(v.effectiveFrom)} · {v.label}
              </li>
            ))}
            <li className="text-muted">Barème prérempli par défaut · {q.data.default.label}</li>
          </ul>
        </Card>
      ) : null}
      <NewVersionSheet base={latest} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
