import { describe, expect, it } from 'vitest';
import {
  accountClass,
  AccountingRuleError,
  assertBalancedEntry,
  assertFiscalYearRange,
  balanceSheet,
  carryForwardLines,
  CASH_DIFFERENCE_ACCOUNTS,
  cashDifferencePosting,
  dateInFiscalYear,
  defaultFiscalYear,
  entryReference,
  expenseCreateSchema,
  expenseNeedsApproval,
  expensePostings,
  findNumberGaps,
  fiscalYearsOverlap,
  generalLedger,
  incomeStatement,
  isPostable,
  manualEntrySchema,
  nextEntryNumber,
  reverseLines,
  SYSCOHADA_CHART,
  trialBalance,
  tuitionPosting,
  validateSubAccount,
  type AccountBalance,
  type EntryLine,
} from './accounting';
import { hasPermission, MODULES } from './permissions';

const d = (accountNumber: string, debit: number): EntryLine => ({
  accountNumber,
  debit,
  credit: 0,
});
const c = (accountNumber: string, credit: number): EntryLine => ({
  accountNumber,
  debit: 0,
  credit,
});

describe('plan comptable SYSCOHADA', () => {
  it('couvre les classes 1 à 8 sans doublon, avec des numéros valides', () => {
    const numbers = SYSCOHADA_CHART.map((a) => a.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(new Set(numbers.map(accountClass))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    for (const n of [
      '4111',
      '7061',
      '7062',
      '7091',
      '571',
      '521',
      '5521',
      '5522',
      '4011',
      '131',
      '139',
    ])
      expect(numbers).toContain(n);
  });

  it('chaque compte détaillé a sa rubrique à deux chiffres', () => {
    const numbers = new Set(SYSCOHADA_CHART.map((a) => a.number));
    for (const n of numbers) expect(numbers.has(n.slice(0, 2))).toBe(true);
  });

  it('classe et imputabilité', () => {
    expect(accountClass('4111')).toBe(4);
    expect(() => accountClass('9')).toThrow(AccountingRuleError);
    expect(() => accountClass('0123')).toThrow(AccountingRuleError);
    expect(isPostable('41')).toBe(false);
    expect(isPostable('411')).toBe(true);
  });

  it('sous-comptes : prolongent le parent, numéro libre', () => {
    expect(() => validateSubAccount('4011', '40111', ['4011'])).not.toThrow();
    expect(() => validateSubAccount('4011', '4012', [])).toThrow(/commence par 4011/);
    expect(() => validateSubAccount('4011', '4011', [])).toThrow(/commence par 4011/);
    expect(() => validateSubAccount('4011', '40111', ['40111'])).toThrow(/existe déjà/);
    expect(() => validateSubAccount('4011', '4011a', [])).toThrow(/chiffres/);
    expect(() => validateSubAccount('4011', '40111111111', [])).toThrow(/chiffres/);
  });
});

describe('partie double', () => {
  it('accepte une écriture équilibrée et renvoie son total', () => {
    expect(assertBalancedEntry([d('4111', 50_000), c('7061', 30_000), c('7062', 20_000)])).toBe(
      50_000,
    );
  });

  it('refuse une écriture déséquilibrée', () => {
    expect(() => assertBalancedEntry([d('4111', 50_000), c('7061', 49_999)])).toThrow(
      /déséquilibrée : 50000 au débit, 49999 au crédit/,
    );
  });

  it('refuse moins de deux lignes, les lignes vides ou mixtes, les montants non entiers', () => {
    expect(() => assertBalancedEntry([d('4111', 1)])).toThrow(/deux lignes/);
    expect(() => assertBalancedEntry([d('4111', 0), c('7061', 0)])).toThrow(/soit un débit/);
    expect(() =>
      assertBalancedEntry([{ accountNumber: '4111', debit: 5, credit: 5 }, c('7061', 0)]),
    ).toThrow(/soit un débit/);
    expect(() => assertBalancedEntry([d('4111', 10.5), c('7061', 10.5)])).toThrow(/entiers/);
    expect(() => assertBalancedEntry([d('4111', -10), c('7061', -10)])).toThrow(/entiers/);
  });

  it('refuse une rubrique non imputable', () => {
    expect(() => assertBalancedEntry([d('41', 10), c('7061', 10)])).toThrow(/non imputable/);
  });

  it('la contre-passation inverse débit et crédit et reste équilibrée', () => {
    const lines = [d('571', 25_000), c('4111', 25_000)];
    const rev = reverseLines(lines);
    expect(rev).toEqual([c('571', 25_000), d('4111', 25_000)]);
    expect(assertBalancedEntry(rev)).toBe(25_000);
  });
});

describe('numérotation sans trou', () => {
  it('commence à 1 et incrémente', () => {
    expect(nextEntryNumber(null)).toBe(1);
    expect(nextEntryNumber(41)).toBe(42);
    expect(() => nextEntryNumber(0)).toThrow(AccountingRuleError);
  });

  it('détecte trous et doublons', () => {
    expect(findNumberGaps([])).toEqual([]);
    expect(findNumberGaps([3, 1, 2])).toEqual([]);
    expect(findNumberGaps([1, 2, 5])).toEqual([3, 4]);
    expect(findNumberGaps([2])).toEqual([1]);
    expect(() => findNumberGaps([1, 2, 2])).toThrow(/double/);
  });

  it('référence lisible par journal et exercice', () => {
    expect(entryReference('VT', '2026-01-01', 12)).toBe('VT-2026-000012');
  });
});

describe('écritures automatiques de la scolarité', () => {
  const base = { description: 'Tranche 1', studentName: 'Ngono Marie-Claire' };

  it('facture : 4111 au débit, scolarité ou inscription au crédit', () => {
    expect(tuitionPosting({ ...base, type: 'CHARGE', amount: 75_000 })).toEqual({
      journal: 'VT',
      label: 'Tranche 1 · Ngono Marie-Claire',
      lines: [d('4111', 75_000), c('7061', 75_000)],
    });
    expect(
      tuitionPosting({ ...base, description: 'Inscription', type: 'CHARGE', amount: 25_000 }).lines,
    ).toEqual([d('4111', 25_000), c('7062', 25_000)]);
  });

  it('réduction : 7091 au débit, 4111 au crédit (montant signé négatif)', () => {
    expect(tuitionPosting({ ...base, type: 'DISCOUNT', amount: -10_000 }).lines).toEqual([
      d('7091', 10_000),
      c('4111', 10_000),
    ]);
  });

  it('paiement : trésorerie selon le moyen, journal correspondant', () => {
    const cases = [
      ['CASH', 'CA', '571'],
      ['BANK', 'BQ', '521'],
      ['MTN_MOMO', 'MM', '5521'],
      ['ORANGE_MONEY', 'MM', '5522'],
    ] as const;
    for (const [method, journal, account] of cases) {
      const p = tuitionPosting({ ...base, type: 'PAYMENT', amount: -40_000, method });
      expect(p.journal).toBe(journal);
      expect(p.lines).toEqual([d(account, 40_000), c('4111', 40_000)]);
    }
    expect(() => tuitionPosting({ ...base, type: 'PAYMENT', amount: -1 })).toThrow(/Moyen/);
  });

  it('annulation : contre-passation du paiement dans le même journal', () => {
    const pay = tuitionPosting({ ...base, type: 'PAYMENT', amount: -40_000, method: 'CASH' });
    const rev = tuitionPosting({ ...base, type: 'REVERSAL', amount: 40_000, method: 'CASH' });
    expect(rev.journal).toBe(pay.journal);
    expect(rev.lines).toEqual(reverseLines(pay.lines));
  });

  it('ajustement selon le signe, refus du montant nul', () => {
    expect(tuitionPosting({ ...base, type: 'ADJUSTMENT', amount: 500 }).lines).toEqual([
      d('4111', 500),
      c('7061', 500),
    ]);
    expect(tuitionPosting({ ...base, type: 'ADJUSTMENT', amount: -500 }).lines).toEqual([
      d('7091', 500),
      c('4111', 500),
    ]);
    expect(() => tuitionPosting({ ...base, type: 'CHARGE', amount: 0 })).toThrow();
  });

  it('toutes les écritures produites sont équilibrées', () => {
    for (const type of ['CHARGE', 'DISCOUNT', 'PAYMENT', 'REVERSAL', 'ADJUSTMENT'] as const) {
      const p = tuitionPosting({ ...base, type, amount: 1234, method: 'BANK' });
      expect(assertBalancedEntry(p.lines)).toBe(1234);
    }
  });
});

describe('dépenses', () => {
  it('facture au journal des achats puis règlement au journal de trésorerie', () => {
    const [invoice, payment] = expensePostings({
      amount: 85_000,
      chargeAccount: '6052',
      method: 'BANK',
      label: 'Facture ENEO octobre',
    });
    expect(invoice).toEqual({
      journal: 'AC',
      label: 'Facture ENEO octobre',
      lines: [d('6052', 85_000), c('4011', 85_000)],
    });
    expect(payment?.journal).toBe('BQ');
    expect(payment?.lines).toEqual([d('4011', 85_000), c('521', 85_000)]);
  });

  it('refuse un compte hors classe 6 et un montant nul', () => {
    expect(() =>
      expensePostings({ amount: 1, chargeAccount: '2442', method: 'CASH', label: 'x' }),
    ).toThrow(/classe 6/);
    expect(() =>
      expensePostings({ amount: 0, chargeAccount: '6052', method: 'CASH', label: 'x' }),
    ).toThrow(/positif/);
  });

  it('écart de caisse : manquant en 6588, excédent en 7588, au journal de caisse', () => {
    expect(cashDifferencePosting({ expected: 25_000, counted: 24_500, label: 'Manquant' })).toEqual(
      { journal: 'CA', label: 'Manquant', lines: [d('6588', 500), c('571', 500)] },
    );
    expect(cashDifferencePosting({ expected: 10_000, counted: 10_250, label: 'Excédent' })).toEqual(
      { journal: 'CA', label: 'Excédent', lines: [d('571', 250), c('7588', 250)] },
    );
    expect(cashDifferencePosting({ expected: 0, counted: 0, label: 'x' })).toBeNull();
    expect(cashDifferencePosting({ expected: 5000, counted: 5000, label: 'x' })).toBeNull();
    expect(() => cashDifferencePosting({ expected: 1.5, counted: 0, label: 'x' })).toThrow(
      RangeError,
    );
    expect(() => cashDifferencePosting({ expected: 0, counted: -1, label: 'x' })).toThrow(
      RangeError,
    );
    const numbers = SYSCOHADA_CHART.map((a) => a.number);
    for (const n of Object.values(CASH_DIFFERENCE_ACCOUNTS)) expect(numbers).toContain(n);
  });

  it('validation par une autre personne à partir du seuil', () => {
    expect(expenseNeedsApproval(99_999, 100_000)).toBe(false);
    expect(expenseNeedsApproval(100_000, 100_000)).toBe(true);
    expect(expenseNeedsApproval(1, 0)).toBe(true);
  });

  it('schéma : fournisseur et pièce obligatoires', () => {
    const ok = {
      supplierName: 'ENEO',
      date: '2026-10-15',
      label: 'Électricité',
      amount: 85_000,
      accountNumber: '6052',
      method: 'BANK',
      pieceRef: 'F-2026-118',
    };
    expect(expenseCreateSchema.safeParse(ok).success).toBe(true);
    expect(expenseCreateSchema.safeParse({ ...ok, supplierName: undefined }).success).toBe(false);
    expect(expenseCreateSchema.safeParse({ ...ok, pieceRef: '' }).success).toBe(false);
    expect(expenseCreateSchema.safeParse({ ...ok, amount: 10.5 }).success).toBe(false);
  });

  it('schéma de saisie : journal des à-nouveaux réservé', () => {
    const entry = {
      journal: 'AN',
      date: '2026-10-15',
      label: 'Essai',
      lines: [d('571', 1), c('4111', 1)],
    };
    expect(manualEntrySchema.safeParse(entry).success).toBe(false);
    expect(manualEntrySchema.safeParse({ ...entry, journal: 'OD' }).success).toBe(true);
  });
});

describe('exercices', () => {
  it('exercice calendaire par défaut', () => {
    expect(defaultFiscalYear('2026-10-30')).toEqual({
      name: 'Exercice 2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
  });

  it('bornes, chevauchement, appartenance', () => {
    expect(() => assertFiscalYearRange({ startDate: '2026-01-01', endDate: '2026-01-01' })).toThrow(
      /suivre/,
    );
    expect(() => assertFiscalYearRange({ startDate: '2026-01-01', endDate: '2028-01-01' })).toThrow(
      /24 mois/,
    );
    expect(() =>
      assertFiscalYearRange({ startDate: '2026-07-01', endDate: '2027-12-31' }),
    ).not.toThrow();
    const y2026 = { startDate: '2026-01-01', endDate: '2026-12-31' };
    expect(fiscalYearsOverlap(y2026, { startDate: '2026-12-31', endDate: '2027-12-31' })).toBe(
      true,
    );
    expect(fiscalYearsOverlap(y2026, { startDate: '2027-01-01', endDate: '2027-12-31' })).toBe(
      false,
    );
    expect(dateInFiscalYear('2026-12-31', y2026)).toBe(true);
    expect(dateInFiscalYear('2027-01-01', y2026)).toBe(false);
  });
});

describe('états', () => {
  // Exercice type : 3 factures, une remise, des encaissements, une dépense.
  const balances: AccountBalance[] = [
    { accountNumber: '4111', label: 'Élèves', balance: 120_000 },
    { accountNumber: '571', label: 'Caisse', balance: 60_000 },
    { accountNumber: '521', label: 'Banque', balance: 95_000 },
    { accountNumber: '4011', label: 'Fournisseurs', balance: -15_000 },
    { accountNumber: '101', label: 'Capital', balance: -100_000 },
    { accountNumber: '7061', label: 'Scolarité', balance: -250_000 },
    { accountNumber: '7062', label: 'Inscription', balance: -30_000 },
    { accountNumber: '7091', label: 'Remises', balance: 20_000 },
    { accountNumber: '6052', label: 'Électricité', balance: 85_000 },
    { accountNumber: '661', label: 'Salaires', balance: 15_000 },
  ];

  it('balance : totaux débit et crédit égaux, soldes nets', () => {
    const tb = trialBalance([
      {
        accountNumber: '571',
        label: 'Caisse',
        openingDebit: 10_000,
        openingCredit: 0,
        debit: 50_000,
        credit: 20_000,
      },
      {
        accountNumber: '4111',
        label: 'Élèves',
        openingDebit: 0,
        openingCredit: 10_000,
        debit: 70_000,
        credit: 50_000,
      },
      {
        accountNumber: '7061',
        label: 'Scolarité',
        openingDebit: 0,
        openingCredit: 0,
        debit: 0,
        credit: 70_000,
      },
      {
        accountNumber: '6052',
        label: 'Électricité',
        openingDebit: 0,
        openingCredit: 0,
        debit: 20_000,
        credit: 0,
      },
      {
        accountNumber: '622',
        label: 'Vide',
        openingDebit: 0,
        openingCredit: 0,
        debit: 0,
        credit: 0,
      },
    ]);
    expect(tb.rows.map((r) => r.accountNumber)).toEqual(['4111', '571', '6052', '7061']);
    expect(tb.rows.find((r) => r.accountNumber === '571')).toMatchObject({
      balanceDebit: 40_000,
      balanceCredit: 0,
    });
    expect(tb.rows.find((r) => r.accountNumber === '4111')).toMatchObject({
      balanceDebit: 10_000,
      balanceCredit: 0,
    });
    expect(tb.totals).toEqual({
      openingDebit: 10_000,
      openingCredit: 10_000,
      debit: 140_000,
      credit: 140_000,
      balanceDebit: 70_000,
      balanceCredit: 70_000,
    });
  });

  it('grand livre : solde progressif et de clôture', () => {
    const gl = generalLedger(
      [
        { accountNumber: '571', label: 'Caisse', opening: 10_000 },
        { accountNumber: '622', label: 'Locations', opening: 0 },
      ],
      [
        {
          accountNumber: '571',
          date: '2026-10-02',
          reference: 'CA-2026-000002',
          label: 'B',
          debit: 0,
          credit: 4_000,
        },
        {
          accountNumber: '571',
          date: '2026-10-01',
          reference: 'CA-2026-000001',
          label: 'A',
          debit: 25_000,
          credit: 0,
        },
      ],
    );
    expect(gl).toHaveLength(1);
    expect(gl[0]?.lines.map((l) => [l.reference, l.balance])).toEqual([
      ['CA-2026-000001', 35_000],
      ['CA-2026-000002', 31_000],
    ]);
    expect(gl[0]).toMatchObject({ totalDebit: 25_000, totalCredit: 4_000, closing: 31_000 });
    expect(() =>
      generalLedger(
        [],
        [{ accountNumber: '571', date: '', reference: '', label: '', debit: 1, credit: 0 }],
      ),
    ).toThrow(/absent/);
  });

  it('compte de résultat : produits nets des remises, charges, résultat', () => {
    const is = incomeStatement(balances);
    expect(is.products).toEqual([{ code: '70', label: 'Ventes', amount: 260_000 }]);
    expect(is.charges).toEqual([
      { code: '60', label: 'Achats et variations de stocks', amount: 85_000 },
      { code: '66', label: 'Charges de personnel', amount: 15_000 },
    ]);
    expect(is.totalProducts).toBe(260_000);
    expect(is.totalCharges).toBe(100_000);
    expect(is.result).toBe(160_000);
  });

  it('comptes HAO de la classe 8 : impairs en charges, pairs en produits', () => {
    const is = incomeStatement([
      { accountNumber: '891', label: 'Impôt', balance: 5_000 },
      { accountNumber: '84', label: 'Produits HAO', balance: -2_000 },
    ]);
    expect(is.totalCharges).toBe(5_000);
    expect(is.totalProducts).toBe(2_000);
    expect(is.result).toBe(-3_000);
  });

  it('bilan équilibré : actif = passif, résultat inclus', () => {
    const bs = balanceSheet(balances);
    expect(bs.totalAssets).toBe(275_000);
    expect(bs.totalLiabilities).toBe(275_000);
    expect(bs.result).toBe(160_000);
    expect(bs.assets.find((g) => g.code === 'TA')?.amount).toBe(155_000);
    expect(bs.liabilities.find((g) => g.code === 'DT')?.amount).toBe(15_000);
  });

  it('report à nouveau : comptes de bilan et résultat en 131, écriture équilibrée', () => {
    const lines = carryForwardLines(balances);
    expect(lines.map((l) => l.accountNumber)).toEqual(['101', '4011', '4111', '521', '571', '131']);
    expect(lines.find((l) => l.accountNumber === '131')).toMatchObject({ credit: 160_000 });
    expect(assertBalancedEntry(lines)).toBe(275_000);
  });

  it('report à nouveau d’une perte en 139', () => {
    const lines = carryForwardLines([
      { accountNumber: '571', label: 'Caisse', balance: 10_000 },
      { accountNumber: '101', label: 'Capital', balance: -50_000 },
      { accountNumber: '6052', label: 'Électricité', balance: 40_000 },
    ]);
    expect(lines.at(-1)).toMatchObject({ accountNumber: '139', debit: 40_000, credit: 0 });
    expect(assertBalancedEntry(lines)).toBe(50_000);
  });
});

describe('module et permissions', () => {
  it('module activable et droits de la comptabilité et de la direction', () => {
    expect(MODULES).toContain('accounting');
    for (const p of ['accounting.read', 'accounting.write', 'accounting.close'] as const) {
      expect(hasPermission(['ACCOUNTANT'], p)).toBe(true);
      expect(hasPermission(['DIRECTOR'], p)).toBe(true);
      expect(hasPermission(['SECRETARY'], p)).toBe(false);
      expect(hasPermission(['TEACHER'], p)).toBe(false);
    }
  });
});
