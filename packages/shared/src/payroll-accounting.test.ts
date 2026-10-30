import { describe, expect, it } from 'vitest';
import {
  AccountingRuleError,
  isPostable,
  manualEntryNeedsApproval,
  REVENUE_ACCOUNTS,
  SYSCOHADA_CHART,
  sumLines,
  treasuryOutflow,
  tuitionPosting,
} from './accounting';
import { computePayslip, DEFAULT_PAYROLL_SCALE, type PayslipResult } from './payroll';
import {
  PAYROLL_ACCOUNTS,
  payrollPosting,
  STOCK_PURCHASE_ACCOUNTS,
  staffPayoutPosting,
  staffPayoutSchema,
  stockPurchasePosting,
  type PayslipAccountingInput,
} from './payroll-accounting';

const toInput = (r: PayslipResult, allowances = 0): PayslipAccountingInput => ({
  gross: r.gross,
  allowances,
  employee: {
    cnps: r.employee.cnps,
    housing: r.employee.housing,
    irpp: r.employee.irpp,
    cac: r.employee.cac,
    audiovisual: r.employee.audiovisual,
    communal: r.employee.communal,
  },
  employer: {
    pension: r.employer.pension,
    family: r.employer.family,
    accident: r.employer.accident,
    housing: r.employer.housing,
    employment: r.employer.employment,
  },
  advanceDeduction: r.advanceDeduction,
  net: r.net,
});

const slip = (over: Partial<Parameters<typeof computePayslip>[0]> = {}) =>
  computePayslip(
    {
      contractType: 'CDI',
      baseEarned: 200_000,
      overtimePay: 0,
      absenceDeduction: 0,
      elements: [],
      advanceDue: 0,
      ...over,
    },
    DEFAULT_PAYROLL_SCALE,
  );

const amountOn = (lines: { accountNumber: string; debit: number; credit: number }[], n: string) =>
  lines.filter((l) => l.accountNumber === n).reduce((s, l) => s + l.debit - l.credit, 0);

describe('plan comptable de la paie', () => {
  it('chaque compte utilisé existe dans le plan préchargé et est imputable', () => {
    const numbers = new Set(SYSCOHADA_CHART.map((a) => a.number));
    for (const n of [
      ...Object.values(PAYROLL_ACCOUNTS),
      ...Object.values(STOCK_PURCHASE_ACCOUNTS),
      '4011',
    ]) {
      expect(numbers.has(n), n).toBe(true);
      expect(isPostable(n)).toBe(true);
    }
  });
});

describe('écriture de paie', () => {
  it('ventile brut, charges patronales, organismes, avances et net, au franc près', () => {
    const r = slip({
      advanceDue: 30_000,
      elements: [
        { kind: 'ALLOWANCE', label: 'Transport', amount: 15_000, taxable: false },
        { kind: 'BONUS', label: 'Prime', amount: 10_000, taxable: true },
      ],
    });
    const p = payrollPosting('2026-10', [toInput(r, 15_000)]);
    expect(p.journal).toBe('OD');
    const { debit, credit } = sumLines(p.lines);
    expect(debit).toBe(credit);
    expect(p.total).toBe(r.gross + r.employer.total);
    expect(amountOn(p.lines, '661')).toBe(r.gross - 15_000);
    expect(amountOn(p.lines, '663')).toBe(15_000);
    expect(amountOn(p.lines, '664')).toBe(r.employer.total);
    expect(amountOn(p.lines, '431')).toBe(
      -(r.employee.cnps + r.employer.pension + r.employer.family + r.employer.accident),
    );
    expect(amountOn(p.lines, '4471')).toBe(-r.employee.irpp);
    expect(amountOn(p.lines, '4472')).toBe(-r.employee.cac);
    expect(amountOn(p.lines, '4473')).toBe(-(r.employee.housing + r.employer.housing));
    expect(amountOn(p.lines, '4474')).toBe(-r.employee.audiovisual);
    expect(amountOn(p.lines, '4475')).toBe(-r.employee.communal);
    expect(amountOn(p.lines, '4476')).toBe(-r.employer.employment);
    expect(amountOn(p.lines, '421')).toBe(-30_000);
    expect(amountOn(p.lines, '422')).toBe(-r.net);
    for (const l of p.lines) expect((l.debit === 0) !== (l.credit === 0)).toBe(true);
  });

  it('reste équilibrée sur de nombreux bulletins aux montants impairs', () => {
    const slips: PayslipAccountingInput[] = [];
    for (let i = 0; i < 60; i++) {
      const r = slip({
        contractType: i % 3 === 0 ? 'HOURLY' : 'CDI',
        baseEarned: 37_001 + i * 13_337,
        overtimePay: i % 4 === 0 ? 3_333 : 0,
        absenceDeduction: i % 5 === 0 ? 1_111 : 0,
        advanceDue: i % 7 === 0 ? 9_999 : 0,
      });
      slips.push(toInput(r));
    }
    const p = payrollPosting('2026-11', slips);
    const { debit, credit } = sumLines(p.lines);
    expect(debit).toBe(credit);
    for (const l of p.lines) {
      expect(Number.isSafeInteger(l.debit)).toBe(true);
      expect(Number.isSafeInteger(l.credit)).toBe(true);
    }
    expect(p.label).toBe('Paie de novembre 2026 (60 bulletins)');
  });

  it('une indemnité ne dépasse jamais le brut et les montants nuls sont omis', () => {
    const r = slip({ baseEarned: 40_000 });
    const p = payrollPosting('2026-10', [toInput(r, 999_999)]);
    expect(amountOn(p.lines, '661')).toBe(0);
    expect(amountOn(p.lines, '663')).toBe(r.gross);
    expect(p.lines.some((l) => l.debit === 0 && l.credit === 0)).toBe(false);
    expect(p.lines.some((l) => l.accountNumber === '4471')).toBe(false); // sous le seuil IRPP
  });

  it('refuse un bulletin incohérent, des montants décimaux ou une paie vide', () => {
    const r = toInput(slip());
    expect(() => payrollPosting('2026-10', [{ ...r, net: r.net + 1 }])).toThrow(
      AccountingRuleError,
    );
    expect(() => payrollPosting('2026-10', [{ ...r, gross: r.gross + 0.5 }])).toThrow(/entier/);
    expect(() => payrollPosting('2026-10', [])).toThrow(/Aucun bulletin/);
  });
});

describe('versements au personnel', () => {
  it('salaires : 422 au débit, trésorerie choisie au crédit, journal du mode', () => {
    const bank = staffPayoutPosting({
      kind: 'PAYROLL',
      amount: 1_234_567,
      method: 'BANK',
      label: 'Salaires',
    });
    expect(bank.journal).toBe('BQ');
    expect(bank.lines).toEqual([
      { accountNumber: '422', debit: 1_234_567, credit: 0 },
      { accountNumber: '521', debit: 0, credit: 1_234_567 },
    ]);
    expect(
      staffPayoutPosting({ kind: 'PAYROLL', amount: 5, method: 'CASH', label: 'x' }).journal,
    ).toBe('CA');
    const momo = staffPayoutPosting({
      kind: 'PAYROLL',
      amount: 5,
      method: 'ORANGE_MONEY',
      label: 'x',
    });
    expect([momo.journal, momo.lines[1]?.accountNumber]).toEqual(['MM', '5522']);
  });

  it('avance : 421 au débit, trésorerie au crédit ; montant positif obligatoire', () => {
    const p = staffPayoutPosting({
      kind: 'ADVANCE',
      amount: 60_000,
      method: 'MTN_MOMO',
      label: 'Avance',
    });
    expect(p.lines.map((l) => [l.accountNumber, l.debit, l.credit])).toEqual([
      ['421', 60_000, 0],
      ['5521', 0, 60_000],
    ]);
    expect(() =>
      staffPayoutPosting({ kind: 'ADVANCE', amount: 0, method: 'CASH', label: 'x' }),
    ).toThrow(AccountingRuleError);
    expect(() =>
      staffPayoutPosting({ kind: 'ADVANCE', amount: 10.5, method: 'CASH', label: 'x' }),
    ).toThrow(AccountingRuleError);
  });

  it('schéma de versement : date, mode et référence facultative', () => {
    expect(staffPayoutSchema.parse({ date: '2026-10-31', method: 'BANK', reference: '' })).toEqual({
      date: '2026-10-31',
      method: 'BANK',
    });
    expect(staffPayoutSchema.safeParse({ date: '31/10/2026', method: 'BANK' }).success).toBe(false);
    expect(staffPayoutSchema.safeParse({ date: '2026-10-31', method: 'CHEQUE' }).success).toBe(
      false,
    );
  });
});

describe('achats de stock', () => {
  it('fournitures en 604, tenues en 601, contre 4011, au journal des achats', () => {
    const supply = stockPurchasePosting({
      category: 'SUPPLY',
      quantity: 12,
      unitCost: 350,
      label: 'Cahiers',
    });
    expect(supply.journal).toBe('AC');
    expect(supply.lines).toEqual([
      { accountNumber: '604', debit: 4200, credit: 0 },
      { accountNumber: '4011', debit: 0, credit: 4200 },
    ]);
    const uniform = stockPurchasePosting({
      category: 'UNIFORM',
      quantity: 3,
      unitCost: 7_500,
      label: 'Tenues',
    });
    expect(uniform.lines[0]).toEqual({ accountNumber: '601', debit: 22_500, credit: 0 });
  });

  it('une correction d’achat contre-passe l’écriture ; un achat gratuit est refusé', () => {
    const p = stockPurchasePosting({
      category: 'SUPPLY',
      quantity: -12,
      unitCost: 350,
      label: 'Correction',
    });
    expect(p.lines).toEqual([
      { accountNumber: '604', debit: 0, credit: 4200 },
      { accountNumber: '4011', debit: 4200, credit: 0 },
    ]);
    expect(() =>
      stockPurchasePosting({ category: 'SUPPLY', quantity: 5, unitCost: 0, label: 'Don' }),
    ).toThrow(/sans montant/);
  });
});

describe('produits des services facturés par la scolarité', () => {
  it('ventes du stock en 701, transport en 7063, pénalités en 7071, scolarité inchangée', () => {
    const numbers = new Set(SYSCOHADA_CHART.map((a) => a.number));
    for (const n of Object.values(REVENUE_ACCOUNTS)) {
      expect(numbers.has(n), n).toBe(true);
      expect(isPostable(n)).toBe(true);
      expect(n.startsWith('7')).toBe(true);
    }
    expect(new Set(Object.values(REVENUE_ACCOUNTS)).has('7061')).toBe(false);
    const charge = (description: string, revenueAccount?: string) =>
      tuitionPosting({
        type: 'CHARGE',
        amount: 9000,
        description,
        studentName: 'Bello Awa',
        revenueAccount,
      }).lines.map((l) => [l.accountNumber, l.debit, l.credit]);
    expect(charge('Chemise uniforme (M) × 2', REVENUE_ACCOUNTS.stockSale)).toEqual([
      ['4111', 9000, 0],
      ['701', 0, 9000],
    ]);
    expect(charge('Transport scolaire – Ligne 1', REVENUE_ACCOUNTS.transport)[1]?.[0]).toBe('7063');
    expect(charge('Pénalité de retard', REVENUE_ACCOUNTS.libraryFine)[1]?.[0]).toBe('7071');
    expect(charge('Tranche 1')[1]?.[0]).toBe('7061');
    expect(charge('Frais d’inscription')[1]?.[0]).toBe('7062');
  });
});

describe('écritures manuelles de trésorerie', () => {
  const l = (accountNumber: string, debit: number, credit: number) => ({
    accountNumber,
    debit,
    credit,
  });
  it('mesure les sorties de caisse, banque et Mobile Money, quel que soit le journal', () => {
    expect(treasuryOutflow([l('6052', 150_000, 0), l('521', 0, 150_000)])).toBe(150_000);
    expect(treasuryOutflow([l('521', 80_000, 0), l('101', 0, 80_000)])).toBe(0);
    expect(treasuryOutflow([l('585', 120_000, 0), l('571', 0, 70_000), l('5521', 0, 50_000)])).toBe(
      120_000,
    );
  });
  it('au seuil ou au-delà, une sortie de trésorerie attend la validation ; un apport non', () => {
    expect(manualEntryNeedsApproval([l('658', 100_000, 0), l('571', 0, 100_000)], 100_000)).toBe(
      true,
    );
    expect(manualEntryNeedsApproval([l('658', 99_999, 0), l('571', 0, 99_999)], 100_000)).toBe(
      false,
    );
    expect(manualEntryNeedsApproval([l('521', 500_000, 0), l('101', 0, 500_000)], 100_000)).toBe(
      false,
    );
    expect(manualEntryNeedsApproval([l('658', 1, 0), l('571', 0, 1)], 0)).toBe(true);
  });
});
