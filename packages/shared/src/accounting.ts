/**
 * Comptabilité générale (SYSCOHADA révisé) : plan comptable, journaux, écritures en partie double
 * et états financiers simplifiés. Montants en FCFA entiers, jamais de virgule flottante.
 */
import { z } from 'zod';
import { assertAmount, PAYMENT_METHODS, type PaymentMethod } from './finance';
import { isoDate } from './schemas';

export class AccountingRuleError extends Error {
  override readonly name = 'AccountingRuleError';
}

// ---------------------------------------------------------------- Plan comptable

export const ACCOUNT_CLASS_LABELS: Record<number, string> = {
  1: 'Comptes de ressources durables',
  2: 'Comptes d’actif immobilisé',
  3: 'Comptes de stocks',
  4: 'Comptes de tiers',
  5: 'Comptes de trésorerie',
  6: 'Comptes de charges des activités ordinaires',
  7: 'Comptes de produits des activités ordinaires',
  8: 'Comptes des autres charges et des autres produits',
};

export interface ChartAccount {
  number: string;
  label: string;
}

/** Plan comptable préchargé : comptes utiles à un établissement scolaire privé. */
export const SYSCOHADA_CHART: readonly ChartAccount[] = [
  { number: '10', label: 'Capital' },
  { number: '101', label: 'Capital social' },
  { number: '103', label: 'Capital personnel' },
  { number: '104', label: 'Compte de l’exploitant' },
  { number: '11', label: 'Réserves' },
  { number: '111', label: 'Réserve légale' },
  { number: '118', label: 'Autres réserves' },
  { number: '12', label: 'Report à nouveau' },
  { number: '121', label: 'Report à nouveau créditeur' },
  { number: '129', label: 'Report à nouveau débiteur' },
  { number: '13', label: 'Résultat net de l’exercice' },
  { number: '131', label: 'Résultat net : bénéfice' },
  { number: '139', label: 'Résultat net : perte' },
  { number: '14', label: 'Subventions d’investissement' },
  { number: '141', label: 'Subventions d’équipement' },
  { number: '16', label: 'Emprunts et dettes assimilées' },
  { number: '162', label: 'Emprunts auprès des établissements de crédit' },
  { number: '19', label: 'Provisions pour risques et charges' },
  { number: '191', label: 'Provisions pour litiges' },

  { number: '21', label: 'Immobilisations incorporelles' },
  { number: '213', label: 'Logiciels et sites internet' },
  { number: '22', label: 'Terrains' },
  { number: '223', label: 'Terrains bâtis' },
  { number: '23', label: 'Bâtiments, installations techniques et agencements' },
  { number: '231', label: 'Bâtiments sur sol propre (salles de classe, administration)' },
  { number: '234', label: 'Aménagements, agencements et installations' },
  { number: '24', label: 'Matériel et mobilier' },
  { number: '2441', label: 'Matériel de bureau' },
  { number: '2442', label: 'Matériel informatique' },
  { number: '2444', label: 'Mobilier de bureau' },
  { number: '2448', label: 'Mobilier et matériel pédagogique (tables-bancs, laboratoire)' },
  { number: '2451', label: 'Matériel de transport (bus scolaire)' },
  { number: '28', label: 'Amortissements des immobilisations' },
  { number: '2831', label: 'Amortissements des bâtiments' },
  { number: '2844', label: 'Amortissements du matériel et mobilier' },
  { number: '2845', label: 'Amortissements du matériel de transport' },

  { number: '33', label: 'Autres approvisionnements' },
  { number: '331', label: 'Matières consommables' },
  { number: '336', label: 'Fournitures de bureau' },

  { number: '40', label: 'Fournisseurs et comptes rattachés' },
  { number: '401', label: 'Fournisseurs, dettes en compte' },
  { number: '4011', label: 'Fournisseurs' },
  { number: '408', label: 'Fournisseurs, factures non parvenues' },
  { number: '409', label: 'Fournisseurs débiteurs, avances versées' },
  { number: '41', label: 'Clients et comptes rattachés' },
  { number: '411', label: 'Clients' },
  { number: '4111', label: 'Élèves et familles : scolarité' },
  { number: '416', label: 'Créances douteuses' },
  { number: '419', label: 'Clients créditeurs' },
  { number: '4191', label: 'Avances reçues des familles' },
  { number: '42', label: 'Personnel' },
  { number: '421', label: 'Personnel, avances et acomptes' },
  { number: '422', label: 'Personnel, rémunérations dues' },
  { number: '43', label: 'Organismes sociaux' },
  { number: '431', label: 'Sécurité sociale (CNPS)' },
  { number: '44', label: 'État et collectivités publiques' },
  { number: '441', label: 'État, impôt sur les bénéfices' },
  { number: '447', label: 'État, impôts retenus à la source' },
  { number: '4471', label: 'État : IRPP retenu sur salaires' },
  { number: '4472', label: 'État : centimes additionnels communaux (CAC)' },
  { number: '4473', label: 'Crédit foncier (CFC) : parts salariale et patronale' },
  { number: '4474', label: 'Redevance audiovisuelle (CRTV)' },
  { number: '4475', label: 'Taxe communale (développement local)' },
  { number: '4476', label: 'Fonds national de l’emploi (FNE)' },
  { number: '47', label: 'Débiteurs et créditeurs divers' },
  { number: '471', label: 'Débiteurs et créditeurs divers' },
  { number: '476', label: 'Charges constatées d’avance' },
  { number: '477', label: 'Produits constatés d’avance' },

  { number: '52', label: 'Banques' },
  { number: '521', label: 'Banques locales' },
  { number: '55', label: 'Instruments de monnaie électronique' },
  { number: '552', label: 'Monnaie électronique : téléphone portable' },
  { number: '5521', label: 'MTN Mobile Money' },
  { number: '5522', label: 'Orange Money' },
  { number: '57', label: 'Caisse' },
  { number: '571', label: 'Caisse' },
  { number: '58', label: 'Régies d’avances et virements internes' },
  { number: '585', label: 'Virements de fonds' },

  { number: '60', label: 'Achats et variations de stocks' },
  { number: '601', label: 'Achats de marchandises (tenues revendues aux familles)' },
  { number: '604', label: 'Achats stockés de matières et fournitures consommables' },
  { number: '605', label: 'Autres achats' },
  { number: '6051', label: 'Eau' },
  { number: '6052', label: 'Électricité' },
  { number: '6053', label: 'Carburant et autres énergies' },
  { number: '6054', label: 'Fournitures d’entretien' },
  { number: '6055', label: 'Fournitures de bureau et pédagogiques' },
  { number: '6056', label: 'Petit matériel et outillage' },
  { number: '61', label: 'Transports' },
  { number: '618', label: 'Autres frais de transport (sorties pédagogiques)' },
  { number: '62', label: 'Services extérieurs' },
  { number: '622', label: 'Locations et charges locatives' },
  { number: '624', label: 'Entretien, réparations et maintenance' },
  { number: '625', label: 'Primes d’assurance' },
  { number: '627', label: 'Publicité, publications, relations publiques' },
  { number: '628', label: 'Frais de télécommunications' },
  { number: '63', label: 'Autres services extérieurs' },
  { number: '631', label: 'Frais bancaires' },
  { number: '632', label: 'Rémunérations d’intermédiaires et de conseils' },
  { number: '637', label: 'Personnel extérieur (vacataires)' },
  { number: '638', label: 'Autres charges externes' },
  { number: '64', label: 'Impôts et taxes' },
  { number: '641', label: 'Impôts et taxes directs' },
  { number: '65', label: 'Autres charges' },
  { number: '658', label: 'Charges diverses' },
  { number: '66', label: 'Charges de personnel' },
  { number: '661', label: 'Rémunérations directes versées au personnel' },
  { number: '663', label: 'Indemnités forfaitaires versées au personnel' },
  { number: '664', label: 'Charges sociales' },
  { number: '67', label: 'Frais financiers et charges assimilées' },
  { number: '671', label: 'Intérêts des emprunts' },
  { number: '68', label: 'Dotations aux amortissements' },
  { number: '681', label: 'Dotations aux amortissements d’exploitation' },

  { number: '70', label: 'Ventes' },
  { number: '706', label: 'Services vendus' },
  { number: '7061', label: 'Frais de scolarité' },
  { number: '7062', label: 'Frais d’inscription' },
  { number: '7068', label: 'Autres frais scolaires (examens, tenues, cantine)' },
  { number: '707', label: 'Produits accessoires' },
  { number: '709', label: 'Rabais, remises et ristournes accordés' },
  { number: '7091', label: 'Remises, réductions et bourses accordées' },
  { number: '71', label: 'Subventions d’exploitation' },
  { number: '718', label: 'Autres subventions d’exploitation' },
  { number: '75', label: 'Autres produits' },
  { number: '758', label: 'Produits divers (dons)' },
  { number: '77', label: 'Revenus financiers et produits assimilés' },
  { number: '771', label: 'Intérêts de prêts et placements' },

  { number: '81', label: 'Valeurs comptables des cessions d’immobilisations' },
  { number: '82', label: 'Produits des cessions d’immobilisations' },
  { number: '83', label: 'Charges hors activités ordinaires' },
  { number: '84', label: 'Produits hors activités ordinaires' },
  { number: '89', label: 'Impôts sur le résultat' },
  { number: '891', label: 'Impôts sur les bénéfices de l’exercice' },
];

/** Comptes utilisés par les écritures automatiques. */
export const ACCOUNTS = {
  tuitionReceivable: '4111',
  tuitionRevenue: '7061',
  registrationRevenue: '7062',
  discounts: '7091',
  suppliers: '4011',
  profit: '131',
  loss: '139',
} as const;

export const PAYMENT_METHOD_ACCOUNTS: Record<PaymentMethod, string> = {
  CASH: '571',
  BANK: '521',
  MTN_MOMO: '5521',
  ORANGE_MONEY: '5522',
};

export const ACCOUNT_NUMBER_RE = /^[1-8]\d{1,9}$/;

/** Classe d'un compte : premier chiffre (1 à 8). */
export function accountClass(number: string): number {
  if (!ACCOUNT_NUMBER_RE.test(number)) throw new AccountingRuleError(`Compte invalide : ${number}`);
  return Number(number[0]);
}

/** Les comptes à deux chiffres sont des rubriques : on imputera sur un compte à 3 chiffres ou plus. */
export function isPostable(number: string): boolean {
  return ACCOUNT_NUMBER_RE.test(number) && number.length >= 3;
}

/** Contrôle d'un sous-compte créé par l'école : il prolonge le numéro du compte parent. */
export function validateSubAccount(
  parent: string,
  number: string,
  existing: readonly string[],
): void {
  if (!ACCOUNT_NUMBER_RE.test(parent)) throw new AccountingRuleError('Compte parent invalide');
  if (!/^\d+$/.test(number) || number.length > 10)
    throw new AccountingRuleError('Le numéro de compte ne contient que des chiffres (10 au plus)');
  if (!number.startsWith(parent) || number.length <= parent.length)
    throw new AccountingRuleError(`Un sous-compte de ${parent} commence par ${parent}`);
  if (existing.includes(number)) throw new AccountingRuleError(`Le compte ${number} existe déjà`);
}

// ---------------------------------------------------------------- Journaux

export const JOURNAL_CODES = ['VT', 'CA', 'BQ', 'MM', 'AC', 'OD', 'AN'] as const;
export type JournalCode = (typeof JOURNAL_CODES)[number];

export const JOURNAL_LABELS: Record<JournalCode, string> = {
  VT: 'Recettes de scolarité',
  CA: 'Caisse',
  BQ: 'Banque',
  MM: 'Mobile Money',
  AC: 'Achats',
  OD: 'Opérations diverses',
  AN: 'À-nouveaux',
};

/** Journaux ouverts à la saisie manuelle (les à-nouveaux sont réservés à la clôture). */
export const MANUAL_JOURNALS: readonly JournalCode[] = ['VT', 'CA', 'BQ', 'MM', 'AC', 'OD'];

export const PAYMENT_METHOD_JOURNALS: Record<PaymentMethod, JournalCode> = {
  CASH: 'CA',
  BANK: 'BQ',
  MTN_MOMO: 'MM',
  ORANGE_MONEY: 'MM',
};

// ---------------------------------------------------------------- Écritures

export interface EntryLine {
  accountNumber: string;
  debit: number;
  credit: number;
  label?: string;
}

export function sumLines(lines: readonly EntryLine[]): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debit;
    credit += l.credit;
  }
  return { debit, credit };
}

/**
 * Partie double : au moins deux lignes, chacune au débit ou au crédit (montant entier positif),
 * total des débits égal au total des crédits. Renvoie le total de l'écriture.
 */
export function assertBalancedEntry(lines: readonly EntryLine[]): number {
  if (lines.length < 2) throw new AccountingRuleError('Une écriture compte au moins deux lignes');
  for (const l of lines) {
    if (!isPostable(l.accountNumber))
      throw new AccountingRuleError(`Compte non imputable : ${l.accountNumber}`);
    if (
      !Number.isSafeInteger(l.debit) ||
      !Number.isSafeInteger(l.credit) ||
      l.debit < 0 ||
      l.credit < 0
    )
      throw new AccountingRuleError('Les montants sont des entiers positifs en FCFA');
    if ((l.debit === 0) === (l.credit === 0))
      throw new AccountingRuleError('Chaque ligne porte soit un débit, soit un crédit');
  }
  const { debit, credit } = sumLines(lines);
  if (debit !== credit)
    throw new AccountingRuleError(
      `Écriture déséquilibrée : ${debit} au débit, ${credit} au crédit`,
    );
  return debit;
}

/** Contre-passation : mêmes comptes, débit et crédit inversés. */
export function reverseLines(lines: readonly EntryLine[]): EntryLine[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

/** Numéro suivant d'un journal sur un exercice : 1 pour la première écriture. */
export function nextEntryNumber(last: number | null | undefined): number {
  if (last === null || last === undefined) return 1;
  if (!Number.isSafeInteger(last) || last < 1) throw new AccountingRuleError('Numéro invalide');
  return last + 1;
}

/** Numéros manquants dans une séquence qui doit commencer à 1 et ne compter aucun trou. */
export function findNumberGaps(numbers: readonly number[]): number[] {
  const sorted = [...numbers].sort((a, b) => a - b);
  const seen = new Set<number>();
  for (const n of sorted) {
    if (seen.has(n)) throw new AccountingRuleError(`Numéro en double : ${n}`);
    seen.add(n);
  }
  const max = sorted.at(-1) ?? 0;
  const gaps: number[] = [];
  for (let i = 1; i <= max; i++) if (!seen.has(i)) gaps.push(i);
  return gaps;
}

/** Référence lisible : « VT-2026-000012 ». */
export function entryReference(journal: string, fiscalYearStart: string, number: number): string {
  return `${journal}-${fiscalYearStart.slice(0, 4)}-${String(number).padStart(6, '0')}`;
}

// ---------------------------------------------------------------- Écritures automatiques

export type TuitionOperation = 'CHARGE' | 'DISCOUNT' | 'PAYMENT' | 'REVERSAL' | 'ADJUSTMENT';

export interface TuitionPosting {
  journal: JournalCode;
  label: string;
  lines: EntryLine[];
}

/** Frais d'inscription ou de scolarité, d'après le libellé de l'échéance. */
export function tuitionRevenueAccount(label: string): string {
  return /inscription/i.test(label) ? ACCOUNTS.registrationRevenue : ACCOUNTS.tuitionRevenue;
}

/**
 * Écriture comptable d'une opération du grand livre de scolarité.
 * - facture (CHARGE) : 4111 au débit, produit (7061 ou 7062) au crédit, journal des recettes ;
 * - réduction (DISCOUNT) : 7091 au débit, 4111 au crédit ;
 * - paiement : trésorerie (caisse, banque, Mobile Money) au débit, 4111 au crédit ;
 * - annulation d'un paiement : contre-passation du paiement dans le même journal ;
 * - ajustement : selon le signe, comme une facture ou comme une réduction (opérations diverses).
 */
export function tuitionPosting(op: {
  type: TuitionOperation;
  /** Montant signé du grand livre de scolarité. */
  amount: number;
  description: string;
  studentName: string;
  method?: PaymentMethod | null;
}): TuitionPosting {
  if (!Number.isSafeInteger(op.amount) || op.amount === 0)
    throw new AccountingRuleError('Montant d’opération invalide');
  const amount = Math.abs(op.amount);
  const label = `${op.description} · ${op.studentName}`.slice(0, 200);
  const receivable = ACCOUNTS.tuitionReceivable;
  const d = (accountNumber: string): EntryLine => ({ accountNumber, debit: amount, credit: 0 });
  const c = (accountNumber: string): EntryLine => ({ accountNumber, debit: 0, credit: amount });
  switch (op.type) {
    case 'CHARGE':
      return {
        journal: 'VT',
        label,
        lines: [d(receivable), c(tuitionRevenueAccount(op.description))],
      };
    case 'DISCOUNT':
      return { journal: 'VT', label, lines: [d(ACCOUNTS.discounts), c(receivable)] };
    case 'PAYMENT':
    case 'REVERSAL': {
      if (!op.method) throw new AccountingRuleError('Moyen de paiement inconnu');
      const treasury = PAYMENT_METHOD_ACCOUNTS[op.method];
      const lines = [d(treasury), c(receivable)];
      return {
        journal: PAYMENT_METHOD_JOURNALS[op.method],
        label,
        lines: op.type === 'PAYMENT' ? lines : reverseLines(lines),
      };
    }
    case 'ADJUSTMENT':
      return {
        journal: 'OD',
        label,
        lines:
          op.amount > 0
            ? [d(receivable), c(ACCOUNTS.tuitionRevenue)]
            : [d(ACCOUNTS.discounts), c(receivable)],
      };
  }
}

/**
 * Dépense : facture du fournisseur au journal des achats (charge au débit, 4011 au crédit),
 * puis règlement au journal de trésorerie (4011 au débit, trésorerie au crédit).
 */
export function expensePostings(e: {
  amount: number;
  chargeAccount: string;
  method: PaymentMethod;
  label: string;
}): TuitionPosting[] {
  assertAmount(e.amount);
  if (e.amount === 0) throw new AccountingRuleError('Le montant de la dépense doit être positif');
  if (accountClass(e.chargeAccount) !== 6 || !isPostable(e.chargeAccount))
    throw new AccountingRuleError('Une dépense s’impute sur un compte de charge (classe 6)');
  const supplier = ACCOUNTS.suppliers;
  return [
    {
      journal: 'AC',
      label: e.label,
      lines: [
        { accountNumber: e.chargeAccount, debit: e.amount, credit: 0 },
        { accountNumber: supplier, debit: 0, credit: e.amount },
      ],
    },
    {
      journal: PAYMENT_METHOD_JOURNALS[e.method],
      label: `Règlement : ${e.label}`.slice(0, 200),
      lines: [
        { accountNumber: supplier, debit: e.amount, credit: 0 },
        { accountNumber: PAYMENT_METHOD_ACCOUNTS[e.method], debit: 0, credit: e.amount },
      ],
    },
  ];
}

/** Une dépense doit être validée par une autre personne à partir du seuil (0 : toujours). */
export function expenseNeedsApproval(amount: number, threshold: number): boolean {
  assertAmount(amount);
  assertAmount(threshold, 'seuil');
  return amount >= threshold;
}

export const DEFAULT_EXPENSE_APPROVAL_THRESHOLD = 100_000;

// ---------------------------------------------------------------- Exercices

export interface FiscalYearRange {
  startDate: string;
  endDate: string;
}

/** Exercice calendaire (1er janvier au 31 décembre), la règle par défaut de l'OHADA. */
export function defaultFiscalYear(date: string): FiscalYearRange & { name: string } {
  const year = date.slice(0, 4);
  return { name: `Exercice ${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

export function assertFiscalYearRange(r: FiscalYearRange): void {
  if (r.endDate <= r.startDate)
    throw new AccountingRuleError('La fin de l’exercice doit suivre son début');
  const start = new Date(`${r.startDate}T00:00:00Z`);
  const limit = new Date(start);
  limit.setUTCMonth(limit.getUTCMonth() + 24);
  if (new Date(`${r.endDate}T00:00:00Z`) >= limit)
    throw new AccountingRuleError('Un exercice dure au plus 24 mois');
}

export function fiscalYearsOverlap(a: FiscalYearRange, b: FiscalYearRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

export function dateInFiscalYear(date: string, r: FiscalYearRange): boolean {
  return date >= r.startDate && date <= r.endDate;
}

// ---------------------------------------------------------------- États

export interface AccountMovement {
  accountNumber: string;
  label: string;
  /** Mouvements antérieurs à la période (à-nouveaux compris). */
  openingDebit: number;
  openingCredit: number;
  /** Mouvements de la période. */
  debit: number;
  credit: number;
}

export interface TrialBalanceRow extends AccountMovement {
  balanceDebit: number;
  balanceCredit: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totals: Omit<TrialBalanceRow, 'accountNumber' | 'label'>;
}

const byAccount = <T extends { accountNumber: string }>(a: T, b: T) =>
  a.accountNumber.localeCompare(b.accountNumber);

/** Balance générale : soldes débiteurs et créditeurs, totaux égaux si les écritures le sont. */
export function trialBalance(movements: readonly AccountMovement[]): TrialBalance {
  const totals = {
    openingDebit: 0,
    openingCredit: 0,
    debit: 0,
    credit: 0,
    balanceDebit: 0,
    balanceCredit: 0,
  };
  const rows: TrialBalanceRow[] = [];
  for (const m of [...movements].sort(byAccount)) {
    for (const v of [m.openingDebit, m.openingCredit, m.debit, m.credit]) assertAmount(v);
    if (m.openingDebit + m.openingCredit + m.debit + m.credit === 0) continue;
    const net = m.openingDebit + m.debit - m.openingCredit - m.credit;
    const row = { ...m, balanceDebit: Math.max(net, 0), balanceCredit: Math.max(-net, 0) };
    rows.push(row);
    totals.openingDebit += row.openingDebit;
    totals.openingCredit += row.openingCredit;
    totals.debit += row.debit;
    totals.credit += row.credit;
    totals.balanceDebit += row.balanceDebit;
    totals.balanceCredit += row.balanceCredit;
  }
  return { rows, totals };
}

export interface LedgerLine {
  accountNumber: string;
  date: string;
  reference: string;
  label: string;
  debit: number;
  credit: number;
}

export interface GeneralLedgerAccount {
  accountNumber: string;
  label: string;
  opening: number;
  lines: (LedgerLine & { balance: number })[];
  totalDebit: number;
  totalCredit: number;
  closing: number;
}

/**
 * Grand livre : par compte, solde d'ouverture, lignes de la période avec solde progressif
 * (positif = débiteur), totaux et solde de clôture.
 */
export function generalLedger(
  accounts: readonly { accountNumber: string; label: string; opening: number }[],
  lines: readonly LedgerLine[],
): GeneralLedgerAccount[] {
  const map = new Map<string, GeneralLedgerAccount>();
  for (const a of accounts) {
    map.set(a.accountNumber, {
      accountNumber: a.accountNumber,
      label: a.label,
      opening: a.opening,
      lines: [],
      totalDebit: 0,
      totalCredit: 0,
      closing: a.opening,
    });
  }
  const sorted = [...lines].sort(
    (a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference),
  );
  for (const l of sorted) {
    const acc = map.get(l.accountNumber);
    if (!acc) throw new AccountingRuleError(`Compte absent du grand livre : ${l.accountNumber}`);
    acc.totalDebit += l.debit;
    acc.totalCredit += l.credit;
    acc.closing += l.debit - l.credit;
    acc.lines.push({ ...l, balance: acc.closing });
  }
  return [...map.values()].filter((a) => a.opening !== 0 || a.lines.length > 0).sort(byAccount);
}

export interface StatementGroup {
  code: string;
  label: string;
  amount: number;
}

export interface IncomeStatement {
  products: StatementGroup[];
  charges: StatementGroup[];
  totalProducts: number;
  totalCharges: number;
  /** Positif : bénéfice ; négatif : perte. */
  result: number;
}

const groupLabel = (code: string) =>
  SYSCOHADA_CHART.find((a) => a.number === code)?.label ?? `Comptes ${code}`;

/** Comptes de produits : classe 7 et comptes 82, 84, 86, 88 (HAO). */
export function isProductAccount(number: string): boolean {
  const c = accountClass(number);
  return c === 7 || (c === 8 && Number(number[1]) % 2 === 0);
}

/** Comptes de charges : classe 6 et comptes 81, 83, 85, 87, 89. */
export function isChargeAccount(number: string): boolean {
  const c = accountClass(number);
  return c === 6 || (c === 8 && Number(number[1]) % 2 === 1);
}

export interface AccountBalance {
  accountNumber: string;
  label: string;
  /** Solde net : positif = débiteur, négatif = créditeur. */
  balance: number;
}

/** Compte de résultat simplifié, regroupé par rubrique à deux chiffres. */
export function incomeStatement(balances: readonly AccountBalance[]): IncomeStatement {
  const products = new Map<string, number>();
  const charges = new Map<string, number>();
  for (const b of balances) {
    if (!Number.isSafeInteger(b.balance)) throw new AccountingRuleError('Solde invalide');
    const code = b.accountNumber.slice(0, 2);
    if (isProductAccount(b.accountNumber))
      products.set(code, (products.get(code) ?? 0) - b.balance);
    else if (isChargeAccount(b.accountNumber))
      charges.set(code, (charges.get(code) ?? 0) + b.balance);
  }
  const toGroups = (m: Map<string, number>) =>
    [...m.entries()]
      .filter(([, amount]) => amount !== 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, amount]) => ({ code, label: groupLabel(code), amount }));
  const p = toGroups(products);
  const c = toGroups(charges);
  const totalProducts = p.reduce((s, g) => s + g.amount, 0);
  const totalCharges = c.reduce((s, g) => s + g.amount, 0);
  return {
    products: p,
    charges: c,
    totalProducts,
    totalCharges,
    result: totalProducts - totalCharges,
  };
}

export interface BalanceSheet {
  assets: StatementGroup[];
  liabilities: StatementGroup[];
  totalAssets: number;
  totalLiabilities: number;
  result: number;
}

/**
 * Bilan simplifié. Actif : immobilisations nettes (classe 2), stocks (3), créances (soldes
 * débiteurs de la classe 4), trésorerie (soldes débiteurs de la classe 5). Passif : capitaux
 * propres et ressources durables (classe 1), résultat de la période, dettes (soldes créditeurs
 * de la classe 4), trésorerie passive (soldes créditeurs de la classe 5).
 */
export function balanceSheet(balances: readonly AccountBalance[]): BalanceSheet {
  const result = incomeStatement(balances).result;
  let fixed = 0;
  let stocks = 0;
  let receivables = 0;
  let cash = 0;
  let equity = 0;
  let debts = 0;
  let overdraft = 0;
  for (const b of balances) {
    switch (accountClass(b.accountNumber)) {
      case 1:
        equity -= b.balance;
        break;
      case 2:
        fixed += b.balance;
        break;
      case 3:
        stocks += b.balance;
        break;
      case 4:
        if (b.balance > 0) receivables += b.balance;
        else debts -= b.balance;
        break;
      case 5:
        if (b.balance > 0) cash += b.balance;
        else overdraft -= b.balance;
        break;
      default:
        break;
    }
  }
  const assets = [
    { code: 'AI', label: 'Actif immobilisé net', amount: fixed },
    { code: 'ST', label: 'Stocks', amount: stocks },
    { code: 'CR', label: 'Créances (familles, avances)', amount: receivables },
    { code: 'TA', label: 'Trésorerie : caisse, banque, Mobile Money', amount: cash },
  ];
  const liabilities = [
    { code: 'CP', label: 'Capitaux propres et ressources durables', amount: equity },
    { code: 'RN', label: 'Résultat de la période', amount: result },
    { code: 'DT', label: 'Dettes (fournisseurs, personnel, État, avances reçues)', amount: debts },
    { code: 'TP', label: 'Trésorerie passive (découverts)', amount: overdraft },
  ];
  return {
    assets,
    liabilities,
    totalAssets: assets.reduce((s, g) => s + g.amount, 0),
    totalLiabilities: liabilities.reduce((s, g) => s + g.amount, 0),
    result,
  };
}

/**
 * Report à nouveau : soldes des comptes de bilan (classes 1 à 5) repris à l'ouverture de
 * l'exercice suivant, résultat de l'exercice porté en 131 (bénéfice) ou 139 (perte).
 */
export function carryForwardLines(balances: readonly AccountBalance[]): EntryLine[] {
  const lines: EntryLine[] = [];
  for (const b of [...balances].sort(byAccount)) {
    if (b.balance === 0 || accountClass(b.accountNumber) > 5) continue;
    lines.push({
      accountNumber: b.accountNumber,
      debit: Math.max(b.balance, 0),
      credit: Math.max(-b.balance, 0),
      label: 'Report à nouveau',
    });
  }
  const { result } = incomeStatement(balances);
  if (result > 0)
    lines.push({
      accountNumber: ACCOUNTS.profit,
      debit: 0,
      credit: result,
      label: 'Résultat de l’exercice',
    });
  if (result < 0)
    lines.push({
      accountNumber: ACCOUNTS.loss,
      debit: -result,
      credit: 0,
      label: 'Résultat de l’exercice',
    });
  return lines;
}

// ---------------------------------------------------------------- Schémas

const fcfa = z.number().int().min(0).max(10_000_000_000);
const accountNumber = z.string().trim().regex(ACCOUNT_NUMBER_RE, 'Numéro de compte invalide');

export const accountCreateSchema = z.object({
  parentNumber: accountNumber,
  number: z
    .string()
    .trim()
    .regex(/^\d{3,10}$/, 'Numéro de compte invalide'),
  label: z.string().trim().min(2).max(120),
});

export const entryLineSchema = z.object({
  accountNumber,
  debit: fcfa.default(0),
  credit: fcfa.default(0),
  label: z.string().trim().max(200).optional(),
});

export const manualEntrySchema = z.object({
  journal: z.enum(JOURNAL_CODES).refine((j) => MANUAL_JOURNALS.includes(j), {
    message: 'Journal réservé',
  }),
  date: isoDate,
  label: z.string().trim().min(2).max(200),
  pieceRef: z.string().trim().max(60).optional(),
  lines: z.array(entryLineSchema).min(2).max(50),
});

export const entryReverseSchema = z.object({
  reason: z.string().trim().min(5).max(200),
  date: isoDate.optional(),
});

export const supplierCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional(),
  taxId: z.string().trim().max(30).optional(),
});

export const expenseCreateSchema = z
  .object({
    supplierId: z.string().min(1).optional(),
    supplierName: z.string().trim().min(2).max(120).optional(),
    date: isoDate,
    label: z.string().trim().min(2).max(200),
    amount: fcfa.refine((v) => v > 0, 'Le montant doit être positif'),
    accountNumber,
    method: z.enum(PAYMENT_METHODS),
    pieceRef: z.string().trim().min(1).max(60),
  })
  .refine((e) => e.supplierId || e.supplierName, {
    message: 'Indiquez le fournisseur',
    path: ['supplierName'],
  });

export const expenseRejectSchema = z.object({ reason: z.string().trim().min(5).max(200) });

export const fiscalYearOpenSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  startDate: isoDate,
  endDate: isoDate,
});

export const accountingSettingsSchema = z.object({ expenseApprovalThreshold: fcfa });

export const accountingPeriodSchema = z.object({
  from: isoDate,
  to: isoDate,
  journal: z.enum(JOURNAL_CODES).optional(),
  account: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional(),
});

export const ACCOUNTING_REPORTS = [
  'journal',
  'grand-livre',
  'balance',
  'compte-de-resultat',
  'bilan',
] as const;
export type AccountingReport = (typeof ACCOUNTING_REPORTS)[number];

export const ACCOUNTING_REPORT_LABELS: Record<AccountingReport, string> = {
  journal: 'Journal',
  'grand-livre': 'Grand livre',
  balance: 'Balance générale',
  'compte-de-resultat': 'Compte de résultat',
  bilan: 'Bilan',
};
