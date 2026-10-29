/**
 * Règles financières. Les montants sont des entiers en FCFA (pas de décimales).
 */

export const PAYMENT_METHODS = ['CASH', 'BANK', 'MTN_MOMO', 'ORANGE_MONEY'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const MOBILE_MONEY_METHODS: readonly PaymentMethod[] = ['MTN_MOMO', 'ORANGE_MONEY'];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Espèces',
  BANK: 'Banque',
  MTN_MOMO: 'MTN MoMo',
  ORANGE_MONEY: 'Orange Money',
};

export function isMobileMoney(method: PaymentMethod): boolean {
  return MOBILE_MONEY_METHODS.includes(method);
}

export function assertAmount(amount: number, name = 'montant'): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`Le ${name} doit être un entier positif en FCFA`);
  }
}

/** 125000 → « 125 000 FCFA » (espace fine insécable comme séparateur). */
export function formatFcfa(amount: number, withUnit = true): string {
  if (!Number.isSafeInteger(amount)) throw new RangeError('Montant invalide');
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return withUnit ? `${sign}${digits}\u00a0FCFA` : `${sign}${digits}`;
}

export interface OutstandingLine<Id> {
  id: Id;
  /** Date d'échéance ISO (AAAA-MM-JJ). */
  dueDate: string;
  /** Montant restant dû sur la ligne. */
  outstanding: number;
  /** Ordre d'affichage, départage les lignes de même échéance. */
  order?: number;
}

export interface Allocation<Id> {
  lineId: Id;
  amount: number;
}

/**
 * Impute un paiement sur les échéances, de la plus ancienne à la plus récente.
 * Le reliquat éventuel (trop-perçu) est renvoyé à part : il devient un avoir.
 */
export function allocatePayment<Id>(
  amount: number,
  lines: readonly OutstandingLine<Id>[],
): { allocations: Allocation<Id>[]; remainder: number } {
  assertAmount(amount);
  const sorted = [...lines]
    .filter((l) => {
      assertAmount(l.outstanding, 'reste dû');
      return l.outstanding > 0;
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.order ?? 0) - (b.order ?? 0));
  let left = amount;
  const allocations: Allocation<Id>[] = [];
  for (const line of sorted) {
    if (left === 0) break;
    const take = Math.min(left, line.outstanding);
    allocations.push({ lineId: line.id, amount: take });
    left -= take;
  }
  return { allocations, remainder: left };
}

export type LedgerEntryType = 'CHARGE' | 'DISCOUNT' | 'PAYMENT' | 'REVERSAL' | 'ADJUSTMENT';

export interface LedgerEntryLike {
  type: LedgerEntryType;
  /** Montant signé : positif = augmente la dette de la famille, négatif = la diminue. */
  amount: number;
}

/** Solde dû par la famille : somme des écritures. Positif = reste à payer. */
export function ledgerBalance(entries: readonly LedgerEntryLike[]): number {
  let total = 0;
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount)) throw new RangeError('Écriture invalide');
    total += e.amount;
  }
  return total;
}

/** Signe attendu de chaque type d'écriture, pour contrôler les écritures avant insertion. */
export function signedLedgerAmount(type: LedgerEntryType, absoluteAmount: number): number {
  assertAmount(absoluteAmount);
  switch (type) {
    case 'CHARGE':
      return absoluteAmount;
    case 'DISCOUNT':
    case 'PAYMENT':
      return -absoluteAmount;
    case 'REVERSAL':
      // Annule un paiement : la dette réaugmente.
      return absoluteAmount;
    case 'ADJUSTMENT':
      return absoluteAmount;
  }
}

export type InstallmentStatus = 'PAID' | 'PARTIAL' | 'UNPAID';

export function installmentStatus(amountDue: number, paid: number): InstallmentStatus {
  assertAmount(amountDue);
  assertAmount(paid, 'montant payé');
  if (amountDue === 0 || paid >= amountDue) return 'PAID';
  if (paid > 0) return 'PARTIAL';
  return 'UNPAID';
}

/** Une échéance est en retard si sa date est dépassée et qu'il reste un montant dû. */
export function isOverdue(dueDate: string, outstanding: number, today: string): boolean {
  return outstanding > 0 && dueDate < today;
}

/** Monnaie à rendre ; négatif si le montant remis est insuffisant. */
export function changeToGive(given: number, due: number): number {
  assertAmount(given, 'montant remis');
  assertAmount(due);
  return given - due;
}

/** Taux de recouvrement en pourcentage entier (arrondi inférieur pour ne jamais surestimer). */
export function recoveryRate(collected: number, expected: number): number {
  assertAmount(collected);
  assertAmount(expected);
  if (expected === 0) return 100;
  return Math.min(100, Math.floor((collected * 100) / expected));
}

/** Date d'envoi d'une relance : J+n après l'échéance (dates ISO AAAA-MM-JJ). */
export function reminderDate(dueDate: string, offsetDays: number): string {
  const d = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError('Date invalide');
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
