import { describe, expect, it } from 'vitest';
import {
  absenceDeduction,
  advanceInstallment,
  allocateAdvanceDeduction,
  applyRate,
  bracketAmount,
  computePayslip,
  contractCreateSchema,
  contractDaysInMonth,
  DEFAULT_PAYROLL_SCALE,
  daysInMonth,
  formatMinutes,
  formatPayrollMonth,
  ofPayrollMonth,
  advanceShareTooHigh,
  advanceRejectSchema,
  formatRateBp,
  isContractEndingSoon,
  nextMonth,
  payElementSchema,
  payForMinutes,
  payrollScaleSchema,
  plannedLessons,
  progressiveTax,
  prorateMonthly,
  roundDiv,
  type PayslipInput,
} from './payroll';

const scale = DEFAULT_PAYROLL_SCALE;
const base = (overrides: Partial<PayslipInput> = {}): PayslipInput => ({
  contractType: 'CDI',
  baseEarned: 0,
  overtimePay: 0,
  absenceDeduction: 0,
  elements: [],
  advanceDue: 0,
  ...overrides,
});

describe('arithmétique entière', () => {
  it('arrondit au franc le plus proche, demi vers le haut', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(4, 3)).toBe(1);
    expect(roundDiv(5, 3)).toBe(2);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(0, 7)).toBe(0);
    expect(applyRate(12_345, 420)).toBe(518); // 518,49
    expect(applyRate(12_350, 420)).toBe(519); // 518,70
    expect(applyRate(12_500, 420)).toBe(525);
    expect(applyRate(11_250, 1000)).toBe(1125);
    expect(applyRate(5, 1000)).toBe(1); // 0,5 → 1
  });

  it('refuse les montants non entiers ou négatifs', () => {
    expect(() => applyRate(10.5, 420)).toThrow(RangeError);
    expect(() => applyRate(1000, 4.2)).toThrow(RangeError);
    expect(() => roundDiv(1, 0)).toThrow(RangeError);
    expect(() => prorateMonthly(-1, 10, 30)).toThrow(RangeError);
    expect(() => computePayslip(base({ baseEarned: 100_000.5 }), scale)).toThrow(RangeError);
    expect(() =>
      computePayslip(
        base({ elements: [{ kind: 'BONUS', label: 'Prime', amount: -10, taxable: true }] }),
        scale,
      ),
    ).toThrow(RangeError);
  });

  it('applique un barème progressif par tranches marginales', () => {
    const brackets = scale.irpp.brackets;
    expect(progressiveTax(0, brackets)).toBe(0);
    expect(progressiveTax(2_000_000, brackets)).toBe(200_000);
    expect(progressiveTax(2_000_001, brackets)).toBe(200_000); // 0,15 arrondi
    expect(progressiveTax(3_000_000, brackets)).toBe(350_000);
    expect(progressiveTax(5_000_000, brackets)).toBe(850_000);
    expect(progressiveTax(7_522_000, brackets)).toBe(1_732_700);
  });

  it('choisit la tranche forfaitaire, bornes supérieures incluses', () => {
    expect(bracketAmount(50_000, scale.audiovisual)).toBe(0);
    expect(bracketAmount(50_001, scale.audiovisual)).toBe(750);
    expect(bracketAmount(1_000_000, scale.audiovisual)).toBe(12_350);
    expect(bracketAmount(5_000_000, scale.audiovisual)).toBe(13_000);
    expect(bracketAmount(62_000, scale.communal)).toBe(0);
    expect(bracketAmount(62_001, scale.communal)).toBe(250);
    expect(bracketAmount(900_000, scale.communal)).toBe(2500);
  });

  it('proratise et rémunère les heures sans virgule flottante', () => {
    expect(prorateMonthly(300_000, 30, 30)).toBe(300_000);
    expect(prorateMonthly(300_000, 15, 30)).toBe(150_000);
    expect(prorateMonthly(100_000, 10, 31)).toBe(32_258); // 32 258,06
    expect(prorateMonthly(100_000, 0, 31)).toBe(0);
    expect(payForMinutes(2500, 1230)).toBe(51_250); // 20 h 30
    expect(payForMinutes(2999, 50)).toBe(2499); // 2 499,17
    expect(payForMinutes(1000, 90)).toBe(1500);
  });
});

describe('computePayslip : cas de référence', () => {
  it('CDI à 200 000 FCFA', () => {
    const r = computePayslip(base({ baseEarned: 200_000 }), scale);
    expect(r.grossTaxable).toBe(200_000);
    expect(r.gross).toBe(200_000);
    expect(r.employee).toEqual({
      cnps: 8400,
      housing: 2000,
      irpp: 8993, // (140 000 × 12 − 100 800 − 500 000) × 10 % / 12 = 8 993,33
      cac: 899,
      audiovisual: 1950,
      communal: 1250,
      total: 23_492,
    });
    expect(r.irppAnnualBase).toBe(1_079_200);
    expect(r.employer).toEqual({
      pension: 8400,
      family: 7400,
      accident: 3500,
      housing: 3000,
      employment: 2000,
      total: 24_300,
    });
    expect(r.net).toBe(176_508);
    expect(r.employerCost).toBe(224_300);
  });

  it('salaire de 1 000 000 FCFA : plafond CNPS et toutes les tranches de l’IRPP', () => {
    const r = computePayslip(base({ baseEarned: 1_000_000 }), scale);
    expect(r.cnpsBase).toBe(750_000);
    expect(r.employee.cnps).toBe(31_500);
    expect(r.employee.housing).toBe(10_000);
    expect(r.irppAnnualBase).toBe(7_522_000);
    expect(r.employee.irpp).toBe(144_392); // 1 732 700 / 12 = 144 391,67
    expect(r.employee.cac).toBe(14_439);
    expect(r.employee.audiovisual).toBe(12_350);
    expect(r.employee.communal).toBe(2500);
    expect(r.employee.total).toBe(215_181);
    expect(r.net).toBe(784_819);
    expect(r.employer.pension).toBe(31_500);
    expect(r.employer.family).toBe(27_750);
    expect(r.employer.accident).toBe(17_500); // sans plafond
    expect(r.employer.total).toBe(101_750);
  });

  it('exonère d’IRPP sous le seuil mensuel', () => {
    const r = computePayslip(base({ baseEarned: 60_000 }), scale);
    expect(r.employee).toEqual({
      cnps: 2520,
      housing: 600,
      irpp: 0,
      cac: 0,
      audiovisual: 750,
      communal: 0,
      total: 3870,
    });
    expect(r.net).toBe(56_130);
  });

  it('au seuil, l’abattement annuel annule l’impôt', () => {
    const r = computePayslip(base({ baseEarned: 62_000 }), scale);
    expect(r.employee.irpp).toBe(0);
    expect(r.irppAnnualBase).toBe(0);
  });

  it('vacataire : heures faites, heures supplémentaires et prime imposable', () => {
    const r = computePayslip(
      base({
        contractType: 'HOURLY',
        baseEarned: payForMinutes(2500, 40 * 60),
        overtimePay: payForMinutes(3000, 120),
        elements: [{ kind: 'BONUS', label: 'Prime de correction', amount: 4000, taxable: true }],
      }),
      scale,
    );
    expect(r.baseEarned).toBe(100_000);
    expect(r.overtimePay).toBe(6000);
    expect(r.grossTaxable).toBe(110_000);
    expect(r.employee.cnps).toBe(4620);
    expect(r.employee.housing).toBe(1100);
    // (77 000 × 12 − 55 440 − 500 000) × 10 % / 12 = 3 071,33
    expect(r.employee.irpp).toBe(3071);
    expect(r.employee.cac).toBe(307);
    expect(r.employee.audiovisual).toBe(1950);
    expect(r.employee.communal).toBe(500); // sur la base de 100 000
    expect(r.net).toBe(110_000 - (4620 + 1100 + 3071 + 307 + 1950 + 500));
  });

  it('indemnité non imposable : versée en net, hors cotisations', () => {
    const without = computePayslip(base({ baseEarned: 200_000 }), scale);
    const withAllowance = computePayslip(
      base({
        baseEarned: 200_000,
        elements: [{ kind: 'ALLOWANCE', label: 'Transport', amount: 15_000, taxable: false }],
      }),
      scale,
    );
    expect(withAllowance.grossTaxable).toBe(200_000);
    expect(withAllowance.gross).toBe(215_000);
    expect(withAllowance.employee).toEqual(without.employee);
    expect(withAllowance.net).toBe(without.net + 15_000);
  });

  it('absences non justifiées : retenue avant cotisations', () => {
    const r = computePayslip(base({ baseEarned: 200_000, absenceDeduction: 20_000 }), scale);
    expect(r.grossTaxable).toBe(180_000);
    expect(r.employee.cnps).toBe(7560);
    expect(r.employee.communal).toBe(1250); // base 180 000
  });

  it('rappel négatif (trop-perçu) : réduit le brut sans le rendre négatif', () => {
    const r = computePayslip(
      base({
        baseEarned: 50_000,
        elements: [{ kind: 'RECALL', label: 'Rappel octobre', amount: -80_000, taxable: true }],
      }),
      scale,
    );
    expect(r.grossTaxable).toBe(0);
    expect(r.gross).toBe(0);
    expect(r.employee.total).toBe(0);
    expect(r.net).toBe(0);
  });

  it('avance : retenue sur le net, jamais au-delà', () => {
    const r = computePayslip(base({ baseEarned: 60_000, advanceDue: 20_000 }), scale);
    expect(r.advanceDeduction).toBe(20_000);
    expect(r.net).toBe(36_130);
    const capped = computePayslip(base({ baseEarned: 60_000, advanceDue: 100_000 }), scale);
    expect(capped.advanceDeduction).toBe(56_130);
    expect(capped.net).toBe(0);
  });

  it('gros salaire : aucune perte de précision', () => {
    const r = computePayslip(base({ baseEarned: 25_000_000 }), scale);
    expect(Number.isInteger(r.employee.irpp)).toBe(true);
    expect(r.employee.cnps).toBe(31_500);
    expect(r.employee.audiovisual).toBe(13_000);
    expect(r.net + r.employee.total).toBe(r.gross);
  });
});

describe('retenues et avances', () => {
  it('retenue d’absence : prorata des heures prévues et 1/30 par jour, plafonnée', () => {
    expect(
      absenceDeduction({
        base: 180_000,
        plannedMinutes: 72 * 60,
        unjustifiedMinutes: 4 * 60,
        unjustifiedDays: 0,
      }),
    ).toBe(10_000);
    expect(
      absenceDeduction({
        base: 150_000,
        plannedMinutes: 0,
        unjustifiedMinutes: 0,
        unjustifiedDays: 2,
      }),
    ).toBe(10_000);
    expect(
      absenceDeduction({
        base: 100_000,
        plannedMinutes: 600,
        unjustifiedMinutes: 900,
        unjustifiedDays: 31,
      }),
    ).toBe(100_000);
  });

  it('mensualité d’avance : arrondie au franc supérieur, solde le dernier mois', () => {
    expect(advanceInstallment(100_000, 3, 0)).toBe(33_334);
    expect(advanceInstallment(100_000, 3, 66_668)).toBe(33_332);
    expect(advanceInstallment(100_000, 3, 100_000)).toBe(0);
    expect(() => advanceInstallment(100_000, 0, 0)).toThrow(RangeError);
  });

  it('répartit la retenue de la plus ancienne avance à la plus récente', () => {
    expect(
      allocateAdvanceDeduction(30_000, [
        { id: 'a', due: 20_000 },
        { id: 'b', due: 25_000 },
      ]),
    ).toEqual([
      { id: 'a', amount: 20_000 },
      { id: 'b', amount: 10_000 },
    ]);
    expect(allocateAdvanceDeduction(0, [{ id: 'a', due: 5 }])).toEqual([]);
  });
});

describe('mois, heures prévues et échéances', () => {
  it('connaît la longueur des mois et le mois suivant', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-11')).toBe(30);
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('2026-09')).toBe('2026-10');
    expect(formatPayrollMonth('2026-11')).toBe('novembre 2026');
  });

  it('signale une retenue d’avance supérieure au tiers du salaire', () => {
    // 900 000 FCFA en 3 mensualités sur un salaire de 250 000 : alerte.
    expect(advanceShareTooHigh(advanceInstallment(900_000, 3, 0), 250_000)).toBe(true);
    expect(advanceShareTooHigh(83_334, 250_000)).toBe(true);
    expect(advanceShareTooHigh(83_333, 250_000)).toBe(false);
    expect(advanceShareTooHigh(25_000, 158_000)).toBe(false);
    // Vacataire (pas de salaire mensuel) : pas d'alerte.
    expect(advanceShareTooHigh(50_000, null)).toBe(false);
    expect(advanceShareTooHigh(50_000, 0)).toBe(false);
    expect(advanceRejectSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(advanceRejectSchema.safeParse({}).success).toBe(false);
    expect(advanceRejectSchema.parse({ reason: ' Trop élevée ' }).reason).toBe('Trop élevée');
  });

  it('élide « de » devant avril, août et octobre', () => {
    expect(ofPayrollMonth('2026-10')).toBe('d’octobre 2026');
    expect(ofPayrollMonth('2027-04')).toBe('d’avril 2027');
    expect(ofPayrollMonth('2027-08')).toBe('d’août 2027');
    expect(ofPayrollMonth('2026-11')).toBe('de novembre 2026');
    expect(ofPayrollMonth('2027-03')).toBe('de mars 2027');
  });

  it('compte les jours de contrat dans le mois', () => {
    expect(contractDaysInMonth('2026-11', '2026-01-01', null)).toBe(30);
    expect(contractDaysInMonth('2026-11', '2026-11-16', null)).toBe(15);
    expect(contractDaysInMonth('2026-11', '2026-09-01', '2026-11-10')).toBe(10);
    expect(contractDaysInMonth('2026-11', '2026-12-01', null)).toBe(0);
    expect(contractDaysInMonth('2026-11', '2026-01-01', '2026-10-31')).toBe(0);
  });

  it('déroule l’emploi du temps hebdomadaire sur le mois', () => {
    // Novembre 2026 : le 2 est un lundi ; 5 lundis (2, 9, 16, 23, 30) et 4 mercredis.
    const slots = [
      { id: 'lun', dayOfWeek: 1, startTime: '08:00', endTime: '10:00' },
      { id: 'mer', dayOfWeek: 3, startTime: '14:00', endTime: '14:55' },
    ];
    const lessons = plannedLessons(slots, '2026-11');
    expect(lessons.filter((l) => l.slotId === 'lun')).toHaveLength(5);
    expect(lessons.filter((l) => l.slotId === 'mer')).toHaveLength(4);
    expect(lessons[0]).toEqual({ slotId: 'lun', date: '2026-11-02', minutes: 120 });
    expect(lessons.reduce((s, l) => s + l.minutes, 0)).toBe(5 * 120 + 4 * 55);
    const limited = plannedLessons(slots, '2026-11', {
      to: '2026-11-15',
      closedDays: new Set(['2026-11-02']),
    });
    expect(limited.map((l) => l.date)).toEqual(['2026-11-04', '2026-11-09', '2026-11-11']);
  });

  it('alerte avant l’échéance d’un CDD seulement', () => {
    expect(isContractEndingSoon({ type: 'CDD', endDate: '2026-11-29' }, '2026-10-30')).toBe(true);
    expect(isContractEndingSoon({ type: 'CDD', endDate: '2026-12-15' }, '2026-10-30')).toBe(false);
    expect(isContractEndingSoon({ type: 'CDD', endDate: '2026-10-01' }, '2026-10-30')).toBe(true);
    expect(isContractEndingSoon({ type: 'CDI', endDate: '2026-11-01' }, '2026-10-30')).toBe(false);
  });

  it('formate heures et taux', () => {
    expect(formatMinutes(750)).toBe('12 h 30');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(55)).toBe('0 h 55');
    expect(formatRateBp(420)).toBe('4,2 %');
    expect(formatRateBp(175)).toBe('1,75 %');
    expect(formatRateBp(1000)).toBe('10 %');
  });
});

describe('schémas', () => {
  it('le barème par défaut est valide et marqué à vérifier', () => {
    const parsed = payrollScaleSchema.parse(DEFAULT_PAYROLL_SCALE);
    expect(parsed.toVerify).toBe(true);
    expect(
      payrollScaleSchema.safeParse({
        ...DEFAULT_PAYROLL_SCALE,
        irpp: { ...DEFAULT_PAYROLL_SCALE.irpp, brackets: [{ upTo: 100, rate: 1000 }] },
      }).success,
    ).toBe(false);
    expect(
      payrollScaleSchema.safeParse({
        ...DEFAULT_PAYROLL_SCALE,
        cnps: { ...DEFAULT_PAYROLL_SCALE.cnps, employeeRate: 4.2 },
      }).success,
    ).toBe(false);
  });

  it('un CDD exige une date de fin, un vacataire un taux horaire', () => {
    expect(
      contractCreateSchema.safeParse({ type: 'CDD', startDate: '2026-09-01', baseSalary: 1 })
        .success,
    ).toBe(false);
    expect(
      contractCreateSchema.safeParse({ type: 'HOURLY', startDate: '2026-09-01' }).success,
    ).toBe(false);
    expect(
      contractCreateSchema.safeParse({ type: 'HOURLY', startDate: '2026-09-01', hourlyRate: 2500 })
        .success,
    ).toBe(true);
  });

  it('seul un rappel peut être négatif', () => {
    expect(payElementSchema.safeParse({ kind: 'BONUS', label: 'P', amount: -1 }).success).toBe(
      false,
    );
    expect(payElementSchema.safeParse({ kind: 'RECALL', label: 'R', amount: -1 }).success).toBe(
      true,
    );
    expect(payElementSchema.safeParse({ kind: 'BONUS', label: 'P', amount: 1.5 }).success).toBe(
      false,
    );
  });
});
