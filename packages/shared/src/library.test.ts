import { describe, expect, it } from 'vitest';
import {
  addIsoDays,
  belowThreshold,
  canBorrow,
  canIssue,
  daysLate,
  inventoryGaps,
  isValidIsbn,
  latePenalty,
  libraryBookSchema,
  libraryLoanSchema,
  librarySettings,
  reminderDue,
  renewal,
  signedStockQuantity,
  stockBySize,
  stockValuation,
} from './library';
import { hasPermission } from './permissions';

describe('retards', () => {
  it('compte les jours de retard', () => {
    expect(daysLate('2026-10-30', '2026-10-30')).toBe(0);
    expect(daysLate('2026-10-30', '2026-10-29')).toBe(0);
    expect(daysLate('2026-10-30', '2026-11-02')).toBe(3);
    expect(daysLate('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('calcule la pénalité, plafonnée', () => {
    expect(latePenalty(3, 100)).toBe(300);
    expect(latePenalty(30, 100, 1000)).toBe(1000);
    expect(latePenalty(0, 100)).toBe(0);
    expect(latePenalty(5, 0)).toBe(0);
  });

  it('relance au premier jour de retard puis chaque semaine', () => {
    expect(reminderDue('2026-10-30', null, '2026-10-30')).toBe(false);
    expect(reminderDue('2026-10-30', null, '2026-10-31')).toBe(true);
    expect(reminderDue('2026-10-30', '2026-10-31', '2026-11-06')).toBe(false);
    expect(reminderDue('2026-10-30', '2026-10-31', '2026-11-07')).toBe(true);
  });
});

describe('emprunts', () => {
  const settings = librarySettings({ maxRenewals: 1, loanDays: 14 });

  it('applique le plafond par lecteur', () => {
    expect(canBorrow(2, 3)).toBe(true);
    expect(canBorrow(3, 3)).toBe(false);
  });

  it('prolonge à partir de la date de retour prévue', () => {
    expect(renewal({ dueDate: '2026-11-10', renewals: 0 }, settings, '2026-11-01')).toEqual({
      ok: true,
      dueDate: '2026-11-24',
    });
  });

  it('refuse la prolongation d’un prêt en retard ou déjà prolongé', () => {
    expect(renewal({ dueDate: '2026-11-10', renewals: 1 }, settings, '2026-11-01').ok).toBe(false);
    expect(renewal({ dueDate: '2026-10-20', renewals: 0 }, settings, '2026-11-01').ok).toBe(false);
  });

  it('complète les réglages par défaut', () => {
    expect(librarySettings(null)).toMatchObject({ maxLoans: 3, loanDays: 14, lateFeePerDay: 0 });
    expect(addIsoDays('2026-12-25', 14)).toBe('2027-01-08');
  });

  it('exige un lecteur', () => {
    expect(libraryLoanSchema.safeParse({ copyId: 'c', borrowerType: 'STUDENT' }).success).toBe(
      false,
    );
    expect(
      libraryLoanSchema.safeParse({ copyId: 'c', borrowerType: 'STAFF', staffUserId: 'u' }).success,
    ).toBe(true);
  });
});

describe('catalogue', () => {
  it('valide les ISBN', () => {
    expect(isValidIsbn('978-2-07-036822-8')).toBe(true);
    expect(isValidIsbn('2-07-036822-X')).toBe(true);
    expect(isValidIsbn('2-07-036822-5')).toBe(false);
    expect(isValidIsbn('0-306-40615-2')).toBe(true);
    expect(isValidIsbn('978-2-07-036822-9')).toBe(false);
  });

  it('normalise l’ISBN et accepte son absence', () => {
    expect(
      libraryBookSchema.parse({ title: 'Une vie de boy', isbn: '978-2-07-036822-8' }).isbn,
    ).toBe('9782070368228');
    expect(libraryBookSchema.parse({ title: 'Une vie de boy', isbn: '' }).isbn).toBeNull();
    expect(libraryBookSchema.safeParse({ title: 'X', isbn: '123' }).success).toBe(false);
  });
});

describe('stock', () => {
  const movements = [
    { size: 'M', type: 'PURCHASE' as const, quantity: 10, unitCost: 3000 },
    { size: 'L', type: 'PURCHASE' as const, quantity: 10, unitCost: 4000 },
    { size: 'M', type: 'SALE' as const, quantity: -3 },
    { size: 'L', type: 'ALLOCATION' as const, quantity: -1 },
    { size: 'M', type: 'REVERSAL' as const, quantity: 1 },
  ];

  it('calcule le stock par taille', () => {
    const map = stockBySize(movements);
    expect(map.get('M')).toBe(8);
    expect(map.get('L')).toBe(9);
  });

  it('signe les quantités et refuse les quantités invalides', () => {
    expect(signedStockQuantity('PURCHASE', 5)).toBe(5);
    expect(signedStockQuantity('SALE', 5)).toBe(-5);
    expect(signedStockQuantity('ALLOCATION', 2)).toBe(-2);
    expect(() => signedStockQuantity('SALE', 0)).toThrow(RangeError);
    expect(() => signedStockQuantity('SALE', 1.5)).toThrow(RangeError);
  });

  it('interdit le stock négatif', () => {
    expect(canIssue(3, 3)).toBe(true);
    expect(canIssue(3, 4)).toBe(false);
    expect(canIssue(3, 0)).toBe(false);
  });

  it('valorise au coût moyen pondéré', () => {
    expect(stockValuation(movements)).toEqual({ onHand: 17, averageCost: 3500, value: 59500 });
    expect(stockValuation([])).toEqual({ onHand: 0, averageCost: 0, value: 0 });
    // Correction d'un achat erroné : la moyenne retrouve le seul achat restant.
    expect(
      stockValuation([
        { size: '', type: 'PURCHASE', quantity: 10, unitCost: 1000 },
        { size: '', type: 'PURCHASE', quantity: 5, unitCost: 4000 },
        { size: '', type: 'REVERSAL', quantity: -5, unitCost: 4000 },
      ]),
    ).toEqual({ onHand: 10, averageCost: 1000, value: 10000 });
  });

  it('signale le seuil d’alerte', () => {
    expect(belowThreshold(5, 5)).toBe(true);
    expect(belowThreshold(6, 5)).toBe(false);
    expect(belowThreshold(0, 0)).toBe(false);
  });

  it('exige une justification pour chaque écart d’inventaire', () => {
    const expected = new Map([
      ['a|M', 8],
      ['a|L', 9],
      ['b|', 4],
    ]);
    const r = inventoryGaps(expected, [
      { itemId: 'a', size: 'M', counted: 8 },
      { itemId: 'a', size: 'L', counted: 7, reason: 'Deux vestes abîmées' },
      { itemId: 'b', size: '', counted: 5 },
    ]);
    expect(r.gaps).toEqual([
      { itemId: 'a', size: 'L', expected: 9, counted: 7, gap: -2 },
      { itemId: 'b', size: '', expected: 4, counted: 5, gap: 1 },
    ]);
    expect(r.missingReasons).toEqual([{ itemId: 'b', size: '' }]);
  });
});

describe('permissions bibliothèque et stock', () => {
  it('répartit les droits par rôle', () => {
    expect(hasPermission(['SECRETARY'], 'library.loans')).toBe(true);
    expect(hasPermission(['ACCOUNTANT'], 'stock.inventory')).toBe(true);
    expect(hasPermission(['SECRETARY'], 'stock.inventory')).toBe(false);
    expect(hasPermission(['TEACHER'], 'library.loans')).toBe(false);
    expect(hasPermission(['DIRECTOR'], 'stock.inventory')).toBe(true);
  });
});
