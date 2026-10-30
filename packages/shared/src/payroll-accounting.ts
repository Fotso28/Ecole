/**
 * Raccordement de la paie, des avances sur salaire et des achats de stock à la comptabilité
 * générale (SYSCOHADA révisé). Montants en FCFA entiers, écritures toujours équilibrées.
 *
 * Les numéros de comptes sont des choix par défaut, à faire valider par un comptable.
 */
import { z } from 'zod';
import {
  AccountingRuleError,
  assertBalancedEntry,
  PAYMENT_METHOD_ACCOUNTS,
  PAYMENT_METHOD_JOURNALS,
  reverseLines,
  type EntryLine,
  type TuitionPosting,
} from './accounting';
import { PAYMENT_METHODS, type PaymentMethod } from './finance';
import { formatPayrollMonth } from './payroll';
import { isoDate } from './schemas';

export type AutomaticPosting = TuitionPosting;

/** Comptes des écritures de paie. */
export const PAYROLL_ACCOUNTS = {
  directPay: '661',
  allowances: '663',
  socialCharges: '664',
  advances: '421',
  salariesDue: '422',
  cnps: '431',
  irpp: '4471',
  cac: '4472',
  housing: '4473',
  audiovisual: '4474',
  communal: '4475',
  employment: '4476',
} as const;

/** Catégories d'articles de stock et compte d'achat correspondant. */
export const STOCK_PURCHASE_ACCOUNTS = {
  SUPPLY: '604',
  UNIFORM: '601',
} as const;
export type StockPurchaseCategory = keyof typeof STOCK_PURCHASE_ACCOUNTS;

/** Données comptables d'un bulletin validé (issues du résultat de `computePayslip`). */
export interface PayslipAccountingInput {
  gross: number;
  /** Indemnités (éléments de type « Indemnité ») comprises dans le brut. */
  allowances: number;
  employee: {
    cnps: number;
    housing: number;
    irpp: number;
    cac: number;
    audiovisual: number;
    communal: number;
  };
  employer: {
    pension: number;
    family: number;
    accident: number;
    housing: number;
    employment: number;
  };
  advanceDeduction: number;
  net: number;
}

function assertInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value))
    throw new AccountingRuleError(`${name} : montant entier en FCFA attendu`);
}

/** Lignes signées (positif = débit) regroupées par compte et libellé, montants nuls omis. */
function signedLines(items: readonly { account: string; label: string; amount: number }[]) {
  const map = new Map<string, { account: string; label: string; amount: number }>();
  for (const i of items) {
    const key = `${i.account}|${i.label}`;
    const cur = map.get(key);
    if (cur) cur.amount += i.amount;
    else map.set(key, { ...i });
  }
  const lines: EntryLine[] = [];
  for (const { account, label, amount } of map.values()) {
    if (amount === 0) continue;
    lines.push({
      accountNumber: account,
      debit: Math.max(amount, 0),
      credit: Math.max(-amount, 0),
      label,
    });
  }
  return lines;
}

/**
 * Écriture de paie d'un mois (journal des opérations diverses) :
 * - débit 661 (rémunérations directes) et 663 (indemnités) pour le brut ;
 * - débit 664 pour les charges patronales, détaillées par organisme ;
 * - crédit 431 (CNPS, parts salariale et patronale), 447x (impôts et taxes retenus par organisme),
 *   421 (avances retenues) et 422 (net à payer).
 * Chaque bulletin est contrôlé (brut − retenues − avance = net) avant l'agrégation.
 */
export function payrollPosting(month: string, slips: readonly PayslipAccountingInput[]) {
  if (slips.length === 0) throw new AccountingRuleError('Aucun bulletin à comptabiliser');
  const A = PAYROLL_ACCOUNTS;
  const items: { account: string; label: string; amount: number }[] = [];
  for (const s of slips) {
    const values = [
      s.gross,
      s.allowances,
      s.advanceDeduction,
      s.net,
      ...Object.values(s.employee),
      ...Object.values(s.employer),
    ];
    for (const v of values) assertInt(v, 'Bulletin');
    const employeeTotal = Object.values(s.employee).reduce((n, v) => n + v, 0);
    if (s.gross - employeeTotal - s.advanceDeduction !== s.net)
      throw new AccountingRuleError(
        'Bulletin incohérent : le net ne correspond pas au brut diminué des retenues',
      );
    const allowances = Math.min(Math.max(s.allowances, 0), Math.max(s.gross, 0));
    const e = s.employee;
    const r = s.employer;
    items.push(
      { account: A.directPay, label: 'Salaires bruts', amount: s.gross - allowances },
      { account: A.allowances, label: 'Indemnités', amount: allowances },
      {
        account: A.socialCharges,
        label: 'Charges patronales CNPS',
        amount: r.pension + r.family + r.accident,
      },
      { account: A.socialCharges, label: 'Crédit foncier patronal', amount: r.housing },
      { account: A.socialCharges, label: 'Fonds national de l’emploi', amount: r.employment },
      {
        account: A.cnps,
        label:
          'CNPS : pension (salarié et employeur), prestations familiales, risques professionnels',
        amount: -(e.cnps + r.pension + r.family + r.accident),
      },
      { account: A.irpp, label: 'IRPP retenu', amount: -e.irpp },
      { account: A.cac, label: 'Centimes additionnels communaux', amount: -e.cac },
      { account: A.housing, label: 'Crédit foncier', amount: -(e.housing + r.housing) },
      { account: A.audiovisual, label: 'Redevance audiovisuelle', amount: -e.audiovisual },
      { account: A.communal, label: 'Taxe communale', amount: -e.communal },
      { account: A.employment, label: 'Fonds national de l’emploi', amount: -r.employment },
      { account: A.advances, label: 'Avances retenues sur salaire', amount: -s.advanceDeduction },
      { account: A.salariesDue, label: 'Net à payer', amount: -s.net },
    );
  }
  const lines = signedLines(items);
  if (lines.length < 2) throw new AccountingRuleError('Paie sans montant à comptabiliser');
  const total = assertBalancedEntry(lines);
  return {
    journal: 'OD' as const,
    label: `Paie de ${formatPayrollMonth(month)} (${slips.length} bulletin${slips.length > 1 ? 's' : ''})`,
    lines,
    total,
  };
}

/** Versement : dette (422 salaires ou 421 avance) au débit, trésorerie choisie au crédit. */
export function staffPayoutPosting(p: {
  kind: StaffPayoutKind;
  amount: number;
  method: PaymentMethod;
  label: string;
}): AutomaticPosting {
  assertInt(p.amount, 'Versement');
  if (p.amount <= 0) throw new AccountingRuleError('Le montant du versement doit être positif');
  const debit = p.kind === 'PAYROLL' ? PAYROLL_ACCOUNTS.salariesDue : PAYROLL_ACCOUNTS.advances;
  const lines: EntryLine[] = [
    { accountNumber: debit, debit: p.amount, credit: 0 },
    { accountNumber: PAYMENT_METHOD_ACCOUNTS[p.method], debit: 0, credit: p.amount },
  ];
  assertBalancedEntry(lines);
  return { journal: PAYMENT_METHOD_JOURNALS[p.method], label: p.label.slice(0, 200), lines };
}

/**
 * Achat de stock auprès d'un fournisseur (journal des achats) : compte 60x selon la catégorie au
 * débit, 4011 au crédit. Une correction d'achat (quantité négative) contre-passe l'écriture.
 * Les ventes ne sont pas concernées : elles sont facturées et comptabilisées par la scolarité.
 */
export function stockPurchasePosting(p: {
  category: StockPurchaseCategory;
  quantity: number;
  unitCost: number;
  label: string;
}): AutomaticPosting {
  assertInt(p.quantity, 'Quantité');
  assertInt(p.unitCost, 'Coût unitaire');
  const amount = p.quantity * p.unitCost;
  assertInt(amount, 'Achat');
  if (amount === 0) throw new AccountingRuleError('Achat sans montant');
  const abs = Math.abs(amount);
  const lines: EntryLine[] = [
    { accountNumber: STOCK_PURCHASE_ACCOUNTS[p.category], debit: abs, credit: 0 },
    { accountNumber: '4011', debit: 0, credit: abs },
  ];
  return {
    journal: 'AC',
    label: p.label.slice(0, 200),
    lines: amount > 0 ? lines : reverseLines(lines),
  };
}

export const STAFF_PAYOUT_KINDS = ['PAYROLL', 'ADVANCE'] as const;
export type StaffPayoutKind = (typeof STAFF_PAYOUT_KINDS)[number];

export const STAFF_PAYOUT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Caisse (espèces)',
  BANK: 'Banque (virement)',
  MTN_MOMO: 'MTN Mobile Money',
  ORANGE_MONEY: 'Orange Money',
};

export const staffPayoutSchema = z.object({
  date: isoDate,
  method: z.enum(PAYMENT_METHODS),
  reference: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((v) => (v ? v : undefined)),
});
