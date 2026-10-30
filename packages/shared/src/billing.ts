import { z } from 'zod';
import { MODULES, type Module } from './permissions';
import { isoDate } from './schemas';

/** Facturation de l'abonnement des établissements (montants annuels en FCFA entiers). */

export const SUBSCRIPTION_PRICINGS = ['PER_STUDENT', 'PER_MODULE'] as const;
export type SubscriptionPricing = (typeof SUBSCRIPTION_PRICINGS)[number];

export const SUBSCRIPTION_PRICING_LABELS: Record<SubscriptionPricing, string> = {
  PER_STUDENT: 'Par élève et par an',
  PER_MODULE: 'Par module activé',
};

export const SUBSCRIPTION_MODULE_LABELS: Record<Module, string> = {
  students: 'Élèves',
  attendance: 'Présences',
  grades: 'Notes et bulletins',
  finance: 'Scolarité',
  communication: 'Communication',
  portal: 'Portail parents',
  timetable: 'Emploi du temps',
  exams: 'Examens',
  documents: 'Documents',
  accounting: 'Comptabilité',
  hr: 'RH et paie',
};

export const SUBSCRIPTION_PAYMENT_METHODS = [
  'BANK_TRANSFER',
  'MOBILE_MONEY',
  'CASH',
  'CHECK',
] as const;
export type SubscriptionPaymentMethod = (typeof SUBSCRIPTION_PAYMENT_METHODS)[number];

export const SUBSCRIPTION_PAYMENT_METHOD_LABELS: Record<SubscriptionPaymentMethod, string> = {
  BANK_TRANSFER: 'Virement',
  MOBILE_MONEY: 'Mobile Money',
  CASH: 'Espèces',
  CHECK: 'Chèque',
};

export interface SubscriptionLine {
  label: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface SubscriptionPricingInput {
  pricing: SubscriptionPricing;
  pricePerStudent: number;
  modulePrices: Partial<Record<string, number>>;
  /** Effectif inscrit (chiffre agrégé, aucune donnée nominative). */
  studentCount: number;
  modules: readonly string[];
}

function assertWhole(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} : entier positif ou nul attendu`);
}

/**
 * Calcule les lignes et le total d'une facture d'abonnement.
 * Par élève : effectif × prix annuel. Par module : somme des prix des modules activés
 * (un module sans prix dans l'offre est inclus gratuitement).
 */
export function computeSubscriptionInvoice(input: SubscriptionPricingInput): {
  lines: SubscriptionLine[];
  total: number;
} {
  assertWhole(input.studentCount, 'Effectif');
  let lines: SubscriptionLine[];
  if (input.pricing === 'PER_STUDENT') {
    assertWhole(input.pricePerStudent, 'Prix par élève');
    lines = [
      {
        label: 'Abonnement annuel par élève inscrit',
        quantity: input.studentCount,
        unitPrice: input.pricePerStudent,
        amount: input.studentCount * input.pricePerStudent,
      },
    ];
  } else {
    const known = MODULES.filter((m) => input.modules.includes(m));
    lines = known.map((m) => {
      const price = input.modulePrices[m] ?? 0;
      assertWhole(price, `Prix du module ${m}`);
      return {
        label: `Module ${SUBSCRIPTION_MODULE_LABELS[m]}`,
        quantity: 1,
        unitPrice: price,
        amount: price,
      };
    });
  }
  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError('Total hors limites');
  return { lines, total };
}

export type SubscriptionInvoiceState = 'PAID' | 'PARTIAL' | 'DUE' | 'OVERDUE' | 'CANCELLED';

export const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionInvoiceState, string> = {
  PAID: 'Réglée',
  PARTIAL: 'Réglée en partie',
  DUE: 'À régler',
  OVERDUE: 'En retard',
  CANCELLED: 'Annulée',
};

/** État d'une facture à une date donnée (dates AAAA-MM-JJ). */
export function subscriptionInvoiceState(input: {
  amount: number;
  paid: number;
  dueDate: string;
  today: string;
  cancelled: boolean;
}): SubscriptionInvoiceState {
  if (input.cancelled) return 'CANCELLED';
  if (input.paid >= input.amount) return 'PAID';
  if (input.dueDate < input.today) return 'OVERDUE';
  return input.paid > 0 ? 'PARTIAL' : 'DUE';
}

/** Année scolaire « AAAA-AAAA » : la seconde année suit la première. */
export const schoolPeriod = z
  .string()
  .regex(/^\d{4}-\d{4}$/, 'Année scolaire au format AAAA-AAAA')
  .refine((p) => Number(p.slice(5)) === Number(p.slice(0, 4)) + 1, 'Années non consécutives');

const fcfa = z.number().int('Montant entier en FCFA').nonnegative();

export const subscriptionPlanSchema = z
  .object({
    name: z.string().trim().min(2, 'Nom de l’offre obligatoire').max(80),
    pricing: z.enum(SUBSCRIPTION_PRICINGS),
    pricePerStudent: fcfa.default(0),
    modulePrices: z.record(z.enum(MODULES), fcfa).default({}),
  })
  .refine((p) => p.pricing !== 'PER_STUDENT' || p.pricePerStudent > 0, {
    message: 'Indiquez le prix par élève',
    path: ['pricePerStudent'],
  })
  .refine((p) => p.pricing !== 'PER_MODULE' || Object.values(p.modulePrices).some((v) => v > 0), {
    message: 'Indiquez le prix d’au moins un module',
    path: ['modulePrices'],
  });

export const subscriptionAssignSchema = z.object({ planId: z.string().min(1) });

export const subscriptionInvoiceIssueSchema = z.object({
  period: schoolPeriod.optional(),
  dueDate: isoDate,
});

export const subscriptionPaymentSchema = z.object({
  amount: z.number().int('Montant entier en FCFA').positive('Le montant doit être positif'),
  method: z.enum(SUBSCRIPTION_PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional(),
  paidOn: isoDate,
  note: z.string().trim().max(300).optional(),
});

export const subscriptionReasonSchema = z.object({
  reason: z.string().trim().min(5, 'Motif de 5 caractères minimum').max(300),
});
