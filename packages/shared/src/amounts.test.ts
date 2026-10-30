import { describe, expect, it } from 'vitest';
import {
  creditNoteSchema,
  feeItemCreateSchema,
  MAX_AMOUNT_FCFA,
  paymentCreateSchema,
  stockItemSchema,
  stockSaleSchema,
  subscriptionPaymentSchema,
  transportLineSchema,
} from './index';

describe('plafond des montants', () => {
  const tooBig = 2_147_483_648; // dépasse les entiers 32 bits de la base

  it('refuse un montant au-delà du plafond, accepte le plafond lui-même', () => {
    const payment = {
      studentId: 'eleve',
      method: 'CASH' as const,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    };
    expect(paymentCreateSchema.safeParse({ ...payment, amount: MAX_AMOUNT_FCFA }).success).toBe(
      true,
    );
    expect(paymentCreateSchema.safeParse({ ...payment, amount: MAX_AMOUNT_FCFA + 1 }).success).toBe(
      false,
    );
    expect(paymentCreateSchema.safeParse({ ...payment, amount: tooBig }).success).toBe(false);
  });

  it('plafonne frais, transport, stock, avoirs et abonnement de la plateforme', () => {
    const cases: [{ safeParse: (v: unknown) => { success: boolean } }, object, string][] = [
      [
        feeItemCreateSchema,
        { academicYearId: 'annee', name: 'Tranche 1', amount: 70000, dueDate: '2026-09-30' },
        'amount',
      ],
      [transportLineSchema, { name: 'Ligne A', fee: 90000, oneWayFee: 50000 }, 'fee'],
      [stockItemSchema, { name: 'Cahier', category: 'SUPPLY', unitPrice: 500 }, 'unitPrice'],
      [
        stockSaleSchema,
        { itemId: 'article', quantity: 3, studentId: 'eleve', requestId: 'vente-0001' },
        'quantity',
      ],
      [creditNoteSchema, { amount: 10000, reason: 'Geste commercial' }, 'amount'],
      [
        subscriptionPaymentSchema,
        { amount: 150000, method: 'BANK_TRANSFER', paidOn: '2026-10-01' },
        'amount',
      ],
    ];
    for (const [schema, valid, field] of cases) {
      expect(schema.safeParse(valid).success, field).toBe(true);
      expect(schema.safeParse({ ...valid, [field]: tooBig }).success, field).toBe(false);
    }
  });
});
