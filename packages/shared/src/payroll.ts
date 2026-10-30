import { z } from 'zod';
import { isoDate } from './schemas';

/**
 * Paie simplifiée (Cameroun) : montants en FCFA entiers, taux en points de base
 * (1 point = 0,01 % : 420 = 4,20 %). Aucun calcul en virgule flottante.
 */

export const CONTRACT_TYPES = ['CDI', 'CDD', 'HOURLY'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  CDI: 'CDI',
  CDD: 'CDD',
  HOURLY: 'Vacataire (payé à l’heure)',
};

export const PAYOUT_METHODS = ['BANK', 'MOBILE_MONEY', 'CASH'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  BANK: 'Virement bancaire',
  MOBILE_MONEY: 'Mobile Money',
  CASH: 'Espèces',
};

export const PAYROLL_STATUSES = ['DRAFT', 'PREPARED', 'VALIDATED'] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export const PAYROLL_STATUS_LABELS: Record<PayrollStatus, string> = {
  DRAFT: 'En préparation',
  PREPARED: 'En attente de validation',
  VALIDATED: 'Validée',
};

export const PAY_ELEMENT_KINDS = ['BONUS', 'ALLOWANCE', 'RECALL'] as const;
export type PayElementKind = (typeof PAY_ELEMENT_KINDS)[number];

export const PAY_ELEMENT_LABELS: Record<PayElementKind, string> = {
  BONUS: 'Prime',
  ALLOWANCE: 'Indemnité',
  RECALL: 'Rappel',
};

/** Tranche d'un barème progressif : `upTo` inclus, `null` pour la dernière tranche. */
export interface RateBracket {
  upTo: number | null;
  rate: number;
}

/** Tranche d'un barème forfaitaire (montant fixe selon le salaire). */
export interface AmountBracket {
  upTo: number | null;
  amount: number;
}

/** Barème de paie daté et paramétrable par école. */
export interface PayrollScale {
  /** Premier jour d'application (AAAA-MM-JJ). */
  effectiveFrom: string;
  label: string;
  cnps: {
    /** Pension vieillesse (PVID), part salariale. */
    employeeRate: number;
    /** Pension vieillesse (PVID), part patronale. */
    employerPensionRate: number;
    /** Prestations familiales, part patronale. */
    familyRate: number;
    /** Risques professionnels (accidents du travail), part patronale, sans plafond. */
    accidentRate: number;
    /** Plafond mensuel des cotisations PVID et prestations familiales. */
    ceiling: number;
  };
  /** Crédit foncier (CFC). */
  housing: { employeeRate: number; employerRate: number };
  /** Fonds national de l'emploi, part patronale. */
  employment: { employerRate: number };
  irpp: {
    /** Abattement forfaitaire pour frais professionnels. */
    professionalExpensesRate: number;
    /** Abattement annuel fixe. */
    annualAllowance: number;
    /** Salaire brut taxable mensuel en dessous duquel l'IRPP n'est pas dû. */
    monthlyExemption: number;
    /** Barème annuel progressif sur le revenu net imposable. */
    brackets: RateBracket[];
  };
  /** Centimes additionnels communaux : pourcentage de l'IRPP. */
  cac: { rate: number };
  /** Redevance audiovisuelle : montant mensuel selon le salaire brut taxable. */
  audiovisual: AmountBracket[];
  /** Taxe communale (taxe de développement local) : montant mensuel selon le salaire de base. */
  communal: AmountBracket[];
  /** Taux à faire vérifier par un comptable avant usage. */
  toVerify: boolean;
}

/**
 * Valeurs camerounaises connues à la rédaction (loi de finances et barèmes CNPS), à vérifier
 * par un comptable avant la première paie : elles évoluent avec chaque loi de finances.
 */
export const DEFAULT_PAYROLL_SCALE: PayrollScale = {
  effectiveFrom: '2026-01-01',
  label: 'Barème Cameroun 2026 (valeurs préremplies, à vérifier par un comptable)',
  cnps: {
    employeeRate: 420,
    employerPensionRate: 420,
    // Régime de l'enseignement privé ; 700 (7 %) pour le régime général.
    familyRate: 370,
    // Groupe A (risque faible).
    accidentRate: 175,
    ceiling: 750_000,
  },
  housing: { employeeRate: 100, employerRate: 150 },
  employment: { employerRate: 100 },
  irpp: {
    professionalExpensesRate: 3000,
    annualAllowance: 500_000,
    monthlyExemption: 62_000,
    brackets: [
      { upTo: 2_000_000, rate: 1000 },
      { upTo: 3_000_000, rate: 1500 },
      { upTo: 5_000_000, rate: 2500 },
      { upTo: null, rate: 3500 },
    ],
  },
  cac: { rate: 1000 },
  audiovisual: [
    { upTo: 50_000, amount: 0 },
    { upTo: 100_000, amount: 750 },
    { upTo: 200_000, amount: 1950 },
    { upTo: 300_000, amount: 3250 },
    { upTo: 400_000, amount: 4550 },
    { upTo: 500_000, amount: 5850 },
    { upTo: 600_000, amount: 7150 },
    { upTo: 700_000, amount: 8450 },
    { upTo: 800_000, amount: 9750 },
    { upTo: 900_000, amount: 11_050 },
    { upTo: 1_000_000, amount: 12_350 },
    { upTo: null, amount: 13_000 },
  ],
  communal: [
    { upTo: 62_000, amount: 0 },
    { upTo: 75_000, amount: 250 },
    { upTo: 100_000, amount: 500 },
    { upTo: 125_000, amount: 750 },
    { upTo: 150_000, amount: 1000 },
    { upTo: 200_000, amount: 1250 },
    { upTo: 250_000, amount: 1500 },
    { upTo: 300_000, amount: 2000 },
    { upTo: 500_000, amount: 2250 },
    { upTo: null, amount: 2500 },
  ],
  toVerify: true,
};

/** Libellés des taux du barème, pour l'affichage et le bulletin. */
export const PAYROLL_CONTRIBUTION_LABELS = {
  cnpsEmployee: 'CNPS pension vieillesse (salarié)',
  housingEmployee: 'Crédit foncier (salarié)',
  irpp: 'IRPP',
  cac: 'Centimes additionnels communaux',
  audiovisual: 'Redevance audiovisuelle',
  communal: 'Taxe communale',
  cnpsPension: 'CNPS pension vieillesse (employeur)',
  cnpsFamily: 'CNPS prestations familiales',
  cnpsAccident: 'CNPS risques professionnels',
  housingEmployer: 'Crédit foncier (employeur)',
  employment: 'Fonds national de l’emploi',
} as const;

// ---------------------------------------------------------------------------------------------
// Arithmétique entière
// ---------------------------------------------------------------------------------------------

function assertInt(value: number, name: string, { signed = false } = {}): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} doit être un entier`);
  if (!signed && value < 0) throw new RangeError(`${name} ne peut pas être négatif`);
}

/** Division entière arrondie au plus proche (demi vers le haut, symétrique pour les négatifs). */
export function roundDiv(numerator: number, denominator: number): number {
  assertInt(numerator, 'numérateur', { signed: true });
  assertInt(denominator, 'dénominateur');
  if (denominator === 0) throw new RangeError('Division par zéro');
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const q = Math.floor(abs / denominator);
  const r = abs - q * denominator;
  return sign * (r * 2 >= denominator ? q + 1 : q);
}

/** Applique un taux en points de base à un montant, arrondi au franc le plus proche. */
export function applyRate(amount: number, rateBp: number): number {
  assertInt(amount, 'montant', { signed: true });
  assertInt(rateBp, 'taux');
  return roundDiv(amount * rateBp, 10_000);
}

/** Impôt progressif par tranches (taux marginaux). */
export function progressiveTax(base: number, brackets: readonly RateBracket[]): number {
  assertInt(base, 'base imposable');
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    if (base <= lower) break;
    const upper = b.upTo === null ? base : Math.min(base, b.upTo);
    // Somme exacte en points de base, arrondie une seule fois à la fin.
    tax += (upper - lower) * b.rate;
    if (b.upTo === null) break;
    lower = b.upTo;
  }
  return roundDiv(tax, 10_000);
}

/** Montant forfaitaire de la tranche contenant `base` (bornes supérieures incluses). */
export function bracketAmount(base: number, brackets: readonly AmountBracket[]): number {
  assertInt(base, 'base');
  for (const b of brackets) if (b.upTo === null || base <= b.upTo) return b.amount;
  return 0;
}

/** Salaire mensuel au prorata des jours calendaires couverts par le contrat. */
export function prorateMonthly(monthly: number, activeDays: number, daysInMonth: number): number {
  assertInt(monthly, 'salaire');
  assertInt(activeDays, 'jours');
  assertInt(daysInMonth, 'jours du mois');
  if (activeDays >= daysInMonth) return monthly;
  return roundDiv(monthly * activeDays, daysInMonth);
}

/** Rémunération d'une durée en minutes à un taux horaire. */
export function payForMinutes(hourlyRate: number, minutes: number): number {
  assertInt(hourlyRate, 'taux horaire');
  assertInt(minutes, 'durée');
  return roundDiv(hourlyRate * minutes, 60);
}

/**
 * Retenue pour absences non justifiées d'un salarié : prorata des heures de cours prévues
 * manquées, plus 1/30 du salaire par journée d'absence. Plafonnée au salaire.
 */
export function absenceDeduction(input: {
  base: number;
  plannedMinutes: number;
  unjustifiedMinutes: number;
  unjustifiedDays: number;
}): number {
  const { base, plannedMinutes, unjustifiedMinutes, unjustifiedDays } = input;
  assertInt(base, 'salaire');
  assertInt(plannedMinutes, 'heures prévues');
  assertInt(unjustifiedMinutes, 'heures manquées');
  assertInt(unjustifiedDays, 'jours d’absence');
  const byHours =
    plannedMinutes > 0
      ? roundDiv(base * Math.min(unjustifiedMinutes, plannedMinutes), plannedMinutes)
      : 0;
  const byDays = roundDiv(base * unjustifiedDays, 30);
  return Math.min(base, byHours + byDays);
}

// ---------------------------------------------------------------------------------------------
// Bulletin de paie
// ---------------------------------------------------------------------------------------------

export interface PayElement {
  kind: PayElementKind;
  label: string;
  /** Montant en FCFA ; seul un rappel peut être négatif (trop-perçu du mois précédent). */
  amount: number;
  /** Soumis aux cotisations et à l'impôt (sinon versé en net, ex. remboursement de frais). */
  taxable: boolean;
}

export interface PayslipInput {
  contractType: ContractType;
  /** Salaire de base du mois (déjà proratisé) ou rémunération des heures faites (vacataire). */
  baseEarned: number;
  overtimePay: number;
  absenceDeduction: number;
  elements: readonly PayElement[];
  /** Retenue d'avance demandée ce mois (limitée au net disponible). */
  advanceDue: number;
}

export interface PayslipResult {
  baseEarned: number;
  overtimePay: number;
  absenceDeduction: number;
  taxableElements: number;
  nonTaxableElements: number;
  grossTaxable: number;
  gross: number;
  cnpsBase: number;
  employee: {
    cnps: number;
    housing: number;
    irpp: number;
    cac: number;
    audiovisual: number;
    communal: number;
    total: number;
  };
  /** Revenu net imposable annuel retenu pour l'IRPP. */
  irppAnnualBase: number;
  employer: {
    pension: number;
    family: number;
    accident: number;
    housing: number;
    employment: number;
    total: number;
  };
  netBeforeAdvance: number;
  advanceDeduction: number;
  net: number;
  employerCost: number;
}

/**
 * Calcule un bulletin de paie mensuel.
 *
 * - Brut taxable = base + heures supplémentaires − absences + éléments imposables (≥ 0).
 * - CNPS salarié : taux sur le brut taxable plafonné.
 * - IRPP : revenu net imposable annuel = 70 % du brut taxable annualisé − CNPS salarié annuelle
 *   − abattement annuel ; barème progressif annuel, puis douzième arrondi au franc.
 *   Exonéré sous le seuil mensuel.
 * - CAC : pourcentage de l'IRPP. Redevance audiovisuelle sur le brut taxable,
 *   taxe communale sur le salaire de base.
 * - L'avance est retenue sur le net, sans jamais le rendre négatif.
 */
export function computePayslip(input: PayslipInput, scale: PayrollScale): PayslipResult {
  assertInt(input.baseEarned, 'salaire de base');
  assertInt(input.overtimePay, 'heures supplémentaires');
  assertInt(input.absenceDeduction, 'retenue pour absences');
  assertInt(input.advanceDue, 'avance');
  let taxableElements = 0;
  let nonTaxableElements = 0;
  for (const e of input.elements) {
    assertInt(e.amount, e.label || 'élément', { signed: e.kind === 'RECALL' });
    if (e.taxable) taxableElements += e.amount;
    else nonTaxableElements += e.amount;
  }
  const grossTaxable = Math.max(
    0,
    input.baseEarned + input.overtimePay - input.absenceDeduction + taxableElements,
  );
  const gross = Math.max(0, grossTaxable + nonTaxableElements);

  const cnpsBase = Math.min(grossTaxable, scale.cnps.ceiling);
  const cnps = applyRate(cnpsBase, scale.cnps.employeeRate);
  const housing = applyRate(grossTaxable, scale.housing.employeeRate);

  let irpp = 0;
  let irppAnnualBase = 0;
  if (grossTaxable >= scale.irpp.monthlyExemption) {
    const monthlyAfterExpenses =
      grossTaxable - applyRate(grossTaxable, scale.irpp.professionalExpensesRate);
    irppAnnualBase = Math.max(
      0,
      monthlyAfterExpenses * 12 - cnps * 12 - scale.irpp.annualAllowance,
    );
    irpp = roundDiv(progressiveTax(irppAnnualBase, scale.irpp.brackets), 12);
  }
  const cac = applyRate(irpp, scale.cac.rate);
  const audiovisual = bracketAmount(grossTaxable, scale.audiovisual);
  const communal = bracketAmount(
    Math.max(0, input.baseEarned - input.absenceDeduction),
    scale.communal,
  );
  const employeeTotal = cnps + housing + irpp + cac + audiovisual + communal;

  const pension = applyRate(cnpsBase, scale.cnps.employerPensionRate);
  const family = applyRate(cnpsBase, scale.cnps.familyRate);
  const accident = applyRate(grossTaxable, scale.cnps.accidentRate);
  const housingEmployer = applyRate(grossTaxable, scale.housing.employerRate);
  const employment = applyRate(grossTaxable, scale.employment.employerRate);
  const employerTotal = pension + family + accident + housingEmployer + employment;

  const netBeforeAdvance = gross - employeeTotal;
  const advanceDeduction = Math.max(0, Math.min(input.advanceDue, netBeforeAdvance));
  return {
    baseEarned: input.baseEarned,
    overtimePay: input.overtimePay,
    absenceDeduction: input.absenceDeduction,
    taxableElements,
    nonTaxableElements,
    grossTaxable,
    gross,
    cnpsBase,
    employee: { cnps, housing, irpp, cac, audiovisual, communal, total: employeeTotal },
    irppAnnualBase,
    employer: {
      pension,
      family,
      accident,
      housing: housingEmployer,
      employment,
      total: employerTotal,
    },
    netBeforeAdvance,
    advanceDeduction,
    net: netBeforeAdvance - advanceDeduction,
    employerCost: gross + employerTotal,
  };
}

/** Répartit la retenue réellement possible entre les avances, de la plus ancienne à la plus récente. */
export function allocateAdvanceDeduction<Id>(
  available: number,
  dues: readonly { id: Id; due: number }[],
): { id: Id; amount: number }[] {
  assertInt(available, 'retenue');
  let left = available;
  const out: { id: Id; amount: number }[] = [];
  for (const d of dues) {
    assertInt(d.due, 'échéance');
    const amount = Math.min(left, d.due);
    if (amount > 0) out.push({ id: d.id, amount });
    left -= amount;
  }
  return out;
}

/** Mensualité d'une avance : le reste dû, dans la limite de la mensualité convenue. */
export function advanceInstallment(amount: number, installments: number, repaid: number): number {
  assertInt(amount, 'avance');
  assertInt(installments, 'mensualités');
  assertInt(repaid, 'déjà remboursé');
  if (installments < 1) throw new RangeError('Au moins une mensualité');
  const monthly = Math.ceil(amount / installments);
  return Math.max(0, Math.min(monthly, amount - repaid));
}

// ---------------------------------------------------------------------------------------------
// Mois, heures prévues, échéances
// ---------------------------------------------------------------------------------------------

export const payrollMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mois attendu au format AAAA-MM');

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function payrollMonthBounds(month: string): { first: string; last: string } {
  return { first: `${month}-01`, last: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };
}

/** Mois suivant (AAAA-MM). */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];

export function formatPayrollMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Nombre de jours du mois couverts par un contrat [start, end]. */
export function contractDaysInMonth(month: string, start: string, end: string | null): number {
  const { first, last } = payrollMonthBounds(month);
  const from = start > first ? start : first;
  const to = end && end < last ? end : last;
  if (from > to) return 0;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

export interface WeeklySlot {
  id: string;
  /** 1 = lundi … 6 = samedi. */
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface PlannedLesson {
  slotId: string;
  date: string;
  minutes: number;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * Cours prévus d'un mois à partir de l'emploi du temps hebdomadaire, éventuellement limités à
 * une période (année scolaire) et privés des jours fériés ou de vacances fournis.
 */
export function plannedLessons(
  slots: readonly WeeklySlot[],
  month: string,
  options: { from?: string; to?: string; closedDays?: ReadonlySet<string> } = {},
): PlannedLesson[] {
  const { first, last } = payrollMonthBounds(month);
  const out: PlannedLesson[] = [];
  for (let d = 1; d <= daysInMonth(month); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (date < first || date > last) continue;
    if (options.from && date < options.from) continue;
    if (options.to && date > options.to) continue;
    if (options.closedDays?.has(date)) continue;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    for (const s of slots) {
      if (s.dayOfWeek !== dow) continue;
      out.push({ slotId: s.id, date, minutes: minutesOf(s.endTime) - minutesOf(s.startTime) });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
}

/** Jours restants avant la fin d'un contrat (négatif s'il est échu). */
export function daysUntil(date: string, today: string): number {
  return (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
}

/** Délai d'alerte avant l'échéance d'un CDD. */
export const CDD_ALERT_DAYS = 30;

export function isContractEndingSoon(
  contract: { type: ContractType; endDate: string | null },
  today: string,
  withinDays = CDD_ALERT_DAYS,
): boolean {
  if (contract.type !== 'CDD' || !contract.endDate) return false;
  return daysUntil(contract.endDate, today) <= withinDays;
}

/** Format des heures (minutes → « 12 h 30 »). */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}`;
}

/** Taux en points de base → « 4,2 % ». */
export function formatRateBp(rateBp: number): string {
  const whole = Math.floor(rateBp / 100);
  const frac = String(rateBp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${frac ? `,${frac}` : ''} %`;
}

// ---------------------------------------------------------------------------------------------
// Schémas de validation
// ---------------------------------------------------------------------------------------------

const fcfa = z.number().int('Montant entier en FCFA').nonnegative();
const rate = z.number().int('Taux en points de base (420 = 4,2 %)').min(0).max(10_000);
const text = (max: number) => z.string().trim().min(1, 'Champ obligatoire').max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const rateBrackets = z
  .array(z.object({ upTo: fcfa.nullable(), rate }))
  .min(1)
  .refine((b) => b[b.length - 1]?.upTo === null, 'La dernière tranche doit être ouverte');
const amountBrackets = z
  .array(z.object({ upTo: fcfa.nullable(), amount: fcfa }))
  .min(1)
  .refine((b) => b[b.length - 1]?.upTo === null, 'La dernière tranche doit être ouverte');

export const payrollScaleSchema = z.object({
  effectiveFrom: isoDate,
  label: text(120),
  cnps: z.object({
    employeeRate: rate,
    employerPensionRate: rate,
    familyRate: rate,
    accidentRate: rate,
    ceiling: fcfa,
  }),
  housing: z.object({ employeeRate: rate, employerRate: rate }),
  employment: z.object({ employerRate: rate }),
  irpp: z.object({
    professionalExpensesRate: rate,
    annualAllowance: fcfa,
    monthlyExemption: fcfa,
    brackets: rateBrackets,
  }),
  cac: z.object({ rate }),
  audiovisual: amountBrackets,
  communal: amountBrackets,
  toVerify: z.boolean().default(true),
});

export const diplomaSchema = z.object({
  title: text(120),
  year: z.number().int().min(1950).max(2100).optional(),
  institution: optionalText(120),
});

/** Données sensibles du dossier : chiffrées en base, consultation journalisée. */
export const employeeSensitiveSchema = z.object({
  idNumber: optionalText(40),
  cnpsNumber: optionalText(40),
  birthDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
  address: optionalText(200),
  personalPhone: optionalText(30),
  emergencyContact: optionalText(120),
  bankName: optionalText(80),
  bankAccount: optionalText(60),
  mobileMoneyNumber: optionalText(30),
  mobileMoneyOperator: z.enum(['MTN', 'ORANGE']).optional(),
});
export type EmployeeSensitive = z.infer<typeof employeeSensitiveSchema>;

export const employeeCreateSchema = z.object({
  userId: z.string().min(1),
  position: text(80),
  hireDate: isoDate,
  diplomas: z.array(diplomaSchema).max(20).default([]),
  payoutMethod: z.enum(PAYOUT_METHODS).default('CASH'),
  sensitive: employeeSensitiveSchema.default({}),
});

export const employeeUpdateSchema = z.object({
  position: text(80).optional(),
  hireDate: isoDate.optional(),
  diplomas: z.array(diplomaSchema).max(20).optional(),
  payoutMethod: z.enum(PAYOUT_METHODS).optional(),
  /** Champs sensibles fournis : remplacent les valeurs existantes (chaîne vide : effacement). */
  sensitive: employeeSensitiveSchema.partial().optional(),
});

export const contractCreateSchema = z
  .object({
    type: z.enum(CONTRACT_TYPES),
    startDate: isoDate,
    endDate: isoDate.optional(),
    baseSalary: fcfa.optional(),
    hourlyRate: fcfa.optional(),
    overtimeRate: fcfa.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.type === 'CDD' && !c.endDate)
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'Date de fin obligatoire pour un CDD',
      });
    if (c.endDate && c.endDate < c.startDate)
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'La fin doit suivre le début' });
    if (c.type === 'HOURLY' && !c.hourlyRate)
      ctx.addIssue({ code: 'custom', path: ['hourlyRate'], message: 'Taux horaire obligatoire' });
    if (c.type !== 'HOURLY' && !c.baseSalary)
      ctx.addIssue({
        code: 'custom',
        path: ['baseSalary'],
        message: 'Salaire de base obligatoire',
      });
  });

export const contractEndSchema = z.object({ endDate: isoDate, reason: text(300) });

export const lessonMarkSchema = z
  .object({
    timetableEntryId: z.string().min(1),
    date: isoDate,
    status: z.enum(['DONE', 'ABSENT']),
    justified: z.boolean().default(false),
    reason: optionalText(300),
  })
  .refine((v) => v.status === 'DONE' || !!v.reason, {
    path: ['reason'],
    message: 'Motif obligatoire pour une absence',
  });

export const overtimeSchema = z.object({
  teacherId: z.string().min(1),
  date: isoDate,
  minutes: z.number().int().min(15).max(600),
  reason: text(300),
});

export const hoursConfirmSchema = z.object({ teacherId: z.string().min(1), month: payrollMonth });

export const payElementSchema = z
  .object({
    kind: z.enum(PAY_ELEMENT_KINDS),
    label: text(80),
    amount: z.number().int('Montant entier en FCFA'),
    taxable: z.boolean().default(true),
  })
  .refine((e) => e.kind === 'RECALL' || e.amount >= 0, {
    path: ['amount'],
    message: 'Seul un rappel peut être négatif',
  });

export const payslipUpdateSchema = z.object({
  elements: z.array(payElementSchema).max(30),
  absenceDays: z.number().int().min(0).max(31).default(0),
});

export const payrollRejectSchema = z.object({ reason: text(500) });

export const advanceCreateSchema = z.object({
  employeeId: z.string().min(1),
  amount: z.number().int('Montant entier en FCFA').positive('Le montant doit être positif'),
  installments: z.number().int().min(1).max(12),
  firstMonth: payrollMonth,
  reason: text(300),
});

export const advanceDecisionSchema = z.object({ reason: optionalText(300) });

export const sensitiveReadSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Motif de consultation obligatoire (5 caractères minimum)')
    .max(200),
});
