import { describe, expect, it } from 'vitest';
import {
  allocatePayment,
  changeToGive,
  formatFcfa,
  installmentStatus,
  isOverdue,
  ledgerBalance,
  recoveryRate,
  reminderDate,
  signedLedgerAmount,
} from './finance';

describe('formatFcfa', () => {
  it('sépare les milliers par une espace fine', () => {
    expect(formatFcfa(125000)).toBe('125\u202f000\u00a0FCFA');
    expect(formatFcfa(84860000, false)).toBe('84\u202f860\u202f000');
    expect(formatFcfa(0)).toBe('0\u00a0FCFA');
    expect(formatFcfa(-5000, false)).toBe('-5\u202f000');
  });

  it('refuse les décimales', () => {
    expect(() => formatFcfa(10.5)).toThrow(RangeError);
  });
});

describe('allocatePayment', () => {
  const lines = [
    { id: 't3', dueDate: '2027-01-15', outstanding: 30000 },
    { id: 't2', dueDate: '2026-11-15', outstanding: 35000 },
    { id: 'paid', dueDate: '2026-09-30', outstanding: 0 },
  ];

  it("impute d'abord l'échéance la plus ancienne", () => {
    expect(allocatePayment(35000, lines)).toEqual({
      allocations: [{ lineId: 't2', amount: 35000 }],
      remainder: 0,
    });
  });

  it('répartit sur plusieurs échéances', () => {
    expect(allocatePayment(50000, lines)).toEqual({
      allocations: [
        { lineId: 't2', amount: 35000 },
        { lineId: 't3', amount: 15000 },
      ],
      remainder: 0,
    });
  });

  it('renvoie le trop-perçu', () => {
    expect(allocatePayment(70000, lines).remainder).toBe(5000);
  });

  it("départage les lignes de même échéance par l'ordre", () => {
    const r = allocatePayment(10000, [
      { id: 'b', dueDate: '2026-09-30', outstanding: 10000, order: 2 },
      { id: 'a', dueDate: '2026-09-30', outstanding: 10000, order: 1 },
    ]);
    expect(r.allocations).toEqual([{ lineId: 'a', amount: 10000 }]);
  });

  it('refuse un montant non entier ou négatif', () => {
    expect(() => allocatePayment(-1, lines)).toThrow(RangeError);
    expect(() => allocatePayment(100.5, lines)).toThrow(RangeError);
  });

  it('conserve exactement le montant payé', () => {
    for (const amount of [1, 999, 35000, 64999, 65000, 100000]) {
      const r = allocatePayment(amount, lines);
      const allocated = r.allocations.reduce((s, a) => s + a.amount, 0);
      expect(allocated + r.remainder).toBe(amount);
    }
  });
});

describe('ledger', () => {
  it('calcule le solde à partir des écritures signées', () => {
    const entries = [
      { type: 'CHARGE' as const, amount: signedLedgerAmount('CHARGE', 185000) },
      { type: 'DISCOUNT' as const, amount: signedLedgerAmount('DISCOUNT', 10000) },
      { type: 'PAYMENT' as const, amount: signedLedgerAmount('PAYMENT', 110000) },
      { type: 'PAYMENT' as const, amount: signedLedgerAmount('PAYMENT', 20000) },
      { type: 'REVERSAL' as const, amount: signedLedgerAmount('REVERSAL', 20000) },
    ];
    expect(ledgerBalance(entries)).toBe(65000);
  });

  it('donne le bon signe à chaque type', () => {
    expect(signedLedgerAmount('CHARGE', 100)).toBe(100);
    expect(signedLedgerAmount('PAYMENT', 100)).toBe(-100);
    expect(signedLedgerAmount('DISCOUNT', 100)).toBe(-100);
    expect(signedLedgerAmount('REVERSAL', 100)).toBe(100);
  });
});

describe('échéances', () => {
  it("donne le statut d'une échéance", () => {
    expect(installmentStatus(50000, 50000)).toBe('PAID');
    expect(installmentStatus(50000, 15000)).toBe('PARTIAL');
    expect(installmentStatus(50000, 0)).toBe('UNPAID');
    expect(installmentStatus(0, 0)).toBe('PAID');
  });

  it('détecte les retards', () => {
    expect(isOverdue('2026-09-30', 5000, '2026-10-29')).toBe(true);
    expect(isOverdue('2026-11-15', 5000, '2026-10-29')).toBe(false);
    expect(isOverdue('2026-09-30', 0, '2026-10-29')).toBe(false);
    expect(isOverdue('2026-10-29', 5000, '2026-10-29')).toBe(false);
  });

  it('calcule la date de relance J+5', () => {
    expect(reminderDate('2026-11-15', 5)).toBe('2026-11-20');
    expect(reminderDate('2026-12-29', 5)).toBe('2027-01-03');
  });
});

describe('caisse', () => {
  it('calcule la monnaie à rendre', () => {
    expect(changeToGive(40000, 35000)).toBe(5000);
    expect(changeToGive(30000, 35000)).toBe(-5000);
  });

  it('calcule le taux de recouvrement sans le surestimer', () => {
    expect(recoveryRate(84860000, 124800000)).toBe(67); // 67,99… → 67
    expect(recoveryRate(0, 0)).toBe(100);
    expect(recoveryRate(10, 5)).toBe(100);
  });
});
