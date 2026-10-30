import { z } from 'zod';
import { id, isoDate } from './schemas';

/** Bibliothèque (catalogue, emprunts, retards) et stock de fournitures et d'uniformes. */

// ---------------------------------------------------------------- Bibliothèque

export const BORROWER_TYPES = ['STUDENT', 'STAFF'] as const;
export type BorrowerType = (typeof BORROWER_TYPES)[number];

export const COPY_STATUSES = ['AVAILABLE', 'LOANED', 'LOST', 'WITHDRAWN'] as const;
export type CopyStatus = (typeof COPY_STATUSES)[number];

export const COPY_STATUS_LABELS: Record<CopyStatus, string> = {
  AVAILABLE: 'Disponible',
  LOANED: 'Prêté',
  LOST: 'Perdu',
  WITHDRAWN: 'Retiré',
};

export interface LibrarySettings {
  /** Plafond d'emprunts simultanés par lecteur. */
  maxLoans: number;
  /** Durée d'un prêt, en jours. */
  loanDays: number;
  /** Nombre de prolongations permises par prêt. */
  maxRenewals: number;
  /** Pénalité de retard par jour (FCFA), 0 pour ne pas en facturer. */
  lateFeePerDay: number;
  /** Plafond de la pénalité d'un prêt (FCFA), 0 pour aucun plafond. */
  lateFeeCap: number;
  /** Rappel par SMS au parent quand un prêt est en retard. */
  reminderSms: boolean;
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  maxLoans: 3,
  loanDays: 14,
  maxRenewals: 1,
  lateFeePerDay: 0,
  lateFeeCap: 0,
  reminderSms: true,
};

/** Réglages de l'école complétés par les valeurs par défaut. */
export function librarySettings(raw: Partial<LibrarySettings> | null | undefined): LibrarySettings {
  return { ...DEFAULT_LIBRARY_SETTINGS, ...(raw ?? {}) };
}

/** Ajoute `days` jours à une date ISO (AAAA-MM-JJ). */
export function addIsoDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Jours de retard d'un prêt à une date donnée (0 si rendu ou à temps). */
export function daysLate(dueDate: string, on: string): number {
  const diff = Math.round(
    (new Date(`${on}T00:00:00Z`).getTime() - new Date(`${dueDate}T00:00:00Z`).getTime()) /
      86_400_000,
  );
  return Math.max(0, diff);
}

/** Pénalité de retard (FCFA entiers), plafonnée si un plafond est défini. */
export function latePenalty(late: number, perDay: number, cap = 0): number {
  if (late <= 0 || perDay <= 0) return 0;
  const total = late * perDay;
  return cap > 0 ? Math.min(total, cap) : total;
}

/** Vrai si le lecteur peut emprunter un document de plus. */
export function canBorrow(activeLoans: number, maxLoans: number): boolean {
  return activeLoans < maxLoans;
}

/**
 * Nouvelle date de retour d'une prolongation, ou la raison du refus : prêt en retard, plafond de
 * prolongations atteint. La prolongation part de la date de retour prévue.
 */
export function renewal(
  loan: { dueDate: string; renewals: number },
  settings: Pick<LibrarySettings, 'loanDays' | 'maxRenewals'>,
  today: string,
): { ok: true; dueDate: string } | { ok: false; reason: string } {
  if (daysLate(loan.dueDate, today) > 0)
    return {
      ok: false,
      reason: 'Le prêt est en retard : rendez le document avant de le reprendre',
    };
  if (loan.renewals >= settings.maxRenewals)
    return { ok: false, reason: 'Nombre maximal de prolongations atteint' };
  return { ok: true, dueDate: addIsoDays(loan.dueDate, settings.loanDays) };
}

/** Le rappel de retard part au premier jour de retard puis tous les `every` jours. */
export function reminderDue(
  dueDate: string,
  lastReminderOn: string | null,
  today: string,
  every = 7,
): boolean {
  if (daysLate(dueDate, today) === 0) return false;
  return lastReminderOn === null || daysLate(lastReminderOn, today) >= every;
}

/** ISBN-10 ou ISBN-13 valide (tirets et espaces ignorés). */
export function isValidIsbn(raw: string): boolean {
  const s = raw.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  return false;
}

const text = (max: number) => z.string().trim().min(1, 'Champ obligatoire').max(max);

export const libraryBookSchema = z.object({
  title: text(200),
  authors: z.array(text(120)).max(10).default([]),
  isbn: z
    .string()
    .trim()
    .refine((v) => v === '' || isValidIsbn(v), 'ISBN invalide')
    .transform((v) => (v === '' ? null : v.replace(/[-\s]/g, '').toUpperCase()))
    .nullable()
    .optional(),
  callNumber: z.string().trim().max(40).nullable().optional(),
  publisher: z.string().trim().max(120).nullable().optional(),
  /** Nombre d'exemplaires à créer. */
  copies: z.number().int().min(0).max(200).default(1),
});

export const libraryCopiesSchema = z.object({ count: z.number().int().min(1).max(200) });

export const libraryLoanSchema = z
  .object({
    copyId: id,
    borrowerType: z.enum(BORROWER_TYPES),
    studentId: id.optional(),
    staffUserId: id.optional(),
    dueDate: isoDate.optional(),
  })
  .refine((v) => (v.borrowerType === 'STUDENT' ? !!v.studentId : !!v.staffUserId), {
    message: 'Choisissez le lecteur',
    path: ['borrower'],
  });

export const libraryReturnSchema = z.object({
  /** Ne pas facturer la pénalité de retard (décision du bibliothécaire). */
  waivePenalty: z.boolean().default(false),
  lost: z.boolean().default(false),
});

export const librarySettingsSchema = z.object({
  maxLoans: z.number().int().min(1).max(20),
  loanDays: z.number().int().min(1).max(120),
  maxRenewals: z.number().int().min(0).max(10),
  lateFeePerDay: z.number().int().min(0).max(10_000),
  lateFeeCap: z.number().int().min(0).max(1_000_000),
  reminderSms: z.boolean(),
});

// ---------------------------------------------------------------- Stock

export const STOCK_CATEGORIES = ['SUPPLY', 'UNIFORM'] as const;
export type StockCategory = (typeof STOCK_CATEGORIES)[number];
export const STOCK_CATEGORY_LABELS: Record<StockCategory, string> = {
  SUPPLY: 'Fourniture',
  UNIFORM: 'Uniforme',
};

export const STOCK_MOVEMENT_TYPES = [
  'PURCHASE',
  'SALE',
  'ALLOCATION',
  'ADJUSTMENT',
  'REVERSAL',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  PURCHASE: 'Achat',
  SALE: 'Vente à un élève',
  ALLOCATION: 'Dotation interne',
  ADJUSTMENT: 'Écart d’inventaire',
  REVERSAL: 'Correction',
};

export interface StockMovementLike {
  size: string;
  type: StockMovementType;
  /** Quantité signée : positive pour une entrée, négative pour une sortie. */
  quantity: number;
  unitCost?: number | null;
}

/** Quantité en stock par taille ('' pour un article sans taille). */
export function stockBySize(movements: readonly StockMovementLike[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of movements) map.set(m.size, (map.get(m.size) ?? 0) + m.quantity);
  return map;
}

/** Quantité signée d'un mouvement selon son type (sorties négatives). */
export function signedStockQuantity(
  type: Exclude<StockMovementType, 'ADJUSTMENT' | 'REVERSAL'>,
  quantity: number,
): number {
  if (!Number.isInteger(quantity) || quantity <= 0)
    throw new RangeError('Quantité entière positive attendue');
  return type === 'PURCHASE' ? quantity : -quantity;
}

/** Vrai si la sortie demandée laisse un stock positif ou nul. */
export function canIssue(onHand: number, quantity: number): boolean {
  return quantity > 0 && quantity <= onHand;
}

/** Vrai si le stock a atteint le seuil d'alerte. */
export function belowThreshold(onHand: number, threshold: number): boolean {
  return threshold > 0 && onHand <= threshold;
}

/**
 * Valorisation simple au coût moyen pondéré des achats : quantité en stock × coût moyen
 * (arrondi au franc). Les corrections d'achat (quantité et coût négatifs) entrent dans la moyenne.
 */
export function stockValuation(movements: readonly StockMovementLike[]): {
  onHand: number;
  averageCost: number;
  value: number;
} {
  const onHand = movements.reduce((s, m) => s + m.quantity, 0);
  let qty = 0;
  let cost = 0;
  for (const m of movements) {
    if (m.unitCost === null || m.unitCost === undefined) continue;
    if (m.type !== 'PURCHASE' && m.type !== 'REVERSAL') continue;
    qty += m.quantity;
    cost += m.quantity * m.unitCost;
  }
  const averageCost = qty > 0 ? Math.round(cost / qty) : 0;
  return { onHand, averageCost, value: Math.max(0, onHand) * averageCost };
}

export interface InventoryLineInput {
  itemId: string;
  size: string;
  counted: number;
  reason?: string | null;
}

/**
 * Écarts d'inventaire : quantité comptée moins quantité attendue. Chaque écart non nul doit être
 * justifié ; la fonction renvoie les lignes non justifiées dans `missingReasons`.
 */
export function inventoryGaps(
  expected: ReadonlyMap<string, number>,
  lines: readonly InventoryLineInput[],
): {
  gaps: { itemId: string; size: string; expected: number; counted: number; gap: number }[];
  missingReasons: { itemId: string; size: string }[];
} {
  const gaps: { itemId: string; size: string; expected: number; counted: number; gap: number }[] =
    [];
  const missingReasons: { itemId: string; size: string }[] = [];
  for (const l of lines) {
    const exp = expected.get(`${l.itemId}|${l.size}`) ?? 0;
    const gap = l.counted - exp;
    if (gap === 0) continue;
    gaps.push({ itemId: l.itemId, size: l.size, expected: exp, counted: l.counted, gap });
    if (!l.reason?.trim()) missingReasons.push({ itemId: l.itemId, size: l.size });
  }
  return { gaps, missingReasons };
}

export const stockItemSchema = z.object({
  name: text(120),
  category: z.enum(STOCK_CATEGORIES),
  /** Tailles proposées (uniformes) ; vide pour un article sans taille. */
  sizes: z.array(z.string().trim().min(1).max(10)).max(20).default([]),
  unitPrice: z.number().int().min(0),
  alertThreshold: z.number().int().min(0).max(100_000).default(0),
});

const quantity = z.number().int('Quantité entière').positive('Quantité positive');

export const stockPurchaseSchema = z.object({
  itemId: id,
  size: z.string().trim().max(10).default(''),
  quantity,
  unitCost: z.number().int().min(0),
  supplier: z.string().trim().min(1, 'Fournisseur obligatoire').max(120),
  reference: z.string().trim().max(60).nullable().optional(),
});

export const stockSaleSchema = z.object({
  itemId: id,
  size: z.string().trim().max(10).default(''),
  quantity,
  studentId: id,
  /** Clé d'idempotence : un nouvel envoi de la même vente ne facture pas deux fois. */
  requestId: z.string().trim().min(8).max(64),
});

export const stockAllocationSchema = z.object({
  itemId: id,
  size: z.string().trim().max(10).default(''),
  quantity,
  reason: z.string().trim().min(3, 'Motif obligatoire').max(200),
});

export const stockReversalSchema = z.object({
  reason: z.string().trim().min(3, 'Motif obligatoire').max(200),
});

export const stockInventorySchema = z.object({
  note: z.string().trim().max(300).nullable().optional(),
  lines: z
    .array(
      z.object({
        itemId: id,
        size: z.string().trim().max(10).default(''),
        counted: z.number().int().min(0),
        reason: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});
