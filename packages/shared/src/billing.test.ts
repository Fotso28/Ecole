import { describe, expect, it } from 'vitest';
import {
  computeSubscriptionInvoice,
  schoolPeriod,
  subscriptionInvoiceState,
  subscriptionPlanSchema,
} from './billing';

describe('computeSubscriptionInvoice', () => {
  it('facture par élève inscrit', () => {
    const r = computeSubscriptionInvoice({
      pricing: 'PER_STUDENT',
      pricePerStudent: 1500,
      modulePrices: {},
      studentCount: 412,
      modules: ['students', 'grades'],
    });
    expect(r.total).toBe(618000);
    expect(r.lines).toEqual([
      {
        label: 'Abonnement annuel par élève inscrit',
        quantity: 412,
        unitPrice: 1500,
        amount: 618000,
      },
    ]);
  });

  it('facture par module activé, dans l’ordre du catalogue, modules sans prix inclus', () => {
    const r = computeSubscriptionInvoice({
      pricing: 'PER_MODULE',
      pricePerStudent: 0,
      modulePrices: { grades: 150000, finance: 200000, portal: 50000 },
      studentCount: 300,
      modules: ['portal', 'students', 'finance', 'grades', 'inconnu'],
    });
    expect(r.lines.map((l) => [l.label, l.amount])).toEqual([
      ['Module Élèves', 0],
      ['Module Notes et bulletins', 150000],
      ['Module Scolarité', 200000],
      ['Module Portail parents', 50000],
    ]);
    expect(r.total).toBe(400000);
  });

  it('refuse les montants décimaux ou négatifs', () => {
    const base = { modulePrices: {}, modules: [] as string[] };
    expect(() =>
      computeSubscriptionInvoice({
        ...base,
        pricing: 'PER_STUDENT',
        pricePerStudent: 10.5,
        studentCount: 3,
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSubscriptionInvoice({
        ...base,
        pricing: 'PER_STUDENT',
        pricePerStudent: 100,
        studentCount: -1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeSubscriptionInvoice({
        pricing: 'PER_MODULE',
        pricePerStudent: 0,
        modulePrices: { grades: -5 },
        studentCount: 3,
        modules: ['grades'],
      }),
    ).toThrow(RangeError);
  });

  it('facture zéro pour une école sans élève', () => {
    expect(
      computeSubscriptionInvoice({
        pricing: 'PER_STUDENT',
        pricePerStudent: 1000,
        modulePrices: {},
        studentCount: 0,
        modules: [],
      }).total,
    ).toBe(0);
  });
});

describe('subscriptionInvoiceState', () => {
  const base = { amount: 100000, dueDate: '2026-11-30', cancelled: false };
  it('distingue réglée, partielle, à régler, en retard et annulée', () => {
    expect(subscriptionInvoiceState({ ...base, paid: 100000, today: '2026-12-15' })).toBe('PAID');
    expect(subscriptionInvoiceState({ ...base, paid: 40000, today: '2026-11-30' })).toBe('PARTIAL');
    expect(subscriptionInvoiceState({ ...base, paid: 0, today: '2026-11-01' })).toBe('DUE');
    expect(subscriptionInvoiceState({ ...base, paid: 40000, today: '2026-12-01' })).toBe('OVERDUE');
    expect(
      subscriptionInvoiceState({ ...base, paid: 0, today: '2026-12-01', cancelled: true }),
    ).toBe('CANCELLED');
  });
});

describe('schémas de facturation', () => {
  it('valide l’année scolaire', () => {
    expect(schoolPeriod.safeParse('2026-2027').success).toBe(true);
    expect(schoolPeriod.safeParse('2026-2028').success).toBe(false);
    expect(schoolPeriod.safeParse('26-27').success).toBe(false);
  });

  it('exige un prix cohérent avec le mode de l’offre', () => {
    expect(
      subscriptionPlanSchema.safeParse({ name: 'Essentiel', pricing: 'PER_STUDENT' }).success,
    ).toBe(false);
    expect(
      subscriptionPlanSchema.safeParse({
        name: 'Essentiel',
        pricing: 'PER_STUDENT',
        pricePerStudent: 1500,
      }).success,
    ).toBe(true);
    expect(
      subscriptionPlanSchema.safeParse({
        name: 'Modules',
        pricing: 'PER_MODULE',
        modulePrices: { grades: 0 },
      }).success,
    ).toBe(false);
    expect(
      subscriptionPlanSchema.safeParse({
        name: 'Modules',
        pricing: 'PER_MODULE',
        modulePrices: { grades: 150000, inconnu: 1 },
      }).success,
    ).toBe(false);
  });
});
