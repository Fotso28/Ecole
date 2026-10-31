import { describe, expect, it } from 'vitest';
import { generalAverage, periodAverage } from './grades';
import {
  annualAverage,
  annualClassResults,
  formatRate,
  passRate,
  PASS_THRESHOLD_CENTI,
  suggestYearEndDecision,
  YEAR_END_DECISION_LABELS,
  YEAR_END_DECISIONS,
  COUNCIL_DECISION_LABELS,
  COUNCIL_DECISIONS,
  DEFAULT_COUNCIL_RULES,
  officialExamForLevel,
  proposeDistinction,
  proposeYearEndDecision,
  resolveCouncilRules,
} from './results';
import { transcriptQuerySchema, councilDecisionSchema, councilRulesSchema } from './schemas';

describe('annualAverage', () => {
  it('fait la moyenne arithmétique des trois trimestres', () => {
    expect(annualAverage([1200, 1350, 1500])).toEqual({
      averageCenti: 1350,
      missingTerms: [],
      termsCounted: 3,
    });
  });

  it('arrondit au centième, demi supérieur', () => {
    // (10,00 + 10,50 + 10,01) ÷ 3 = 10,17
    expect(annualAverage([1000, 1050, 1001]).averageCenti).toBe(1017);
    // (12,00 + 12,00 + 12,01) ÷ 3 = 12,0033… → 12,00
    expect(annualAverage([1200, 1200, 1201]).averageCenti).toBe(1200);
    // (12,00 + 12,01 + 12,01) ÷ 3 = 12,0066… → 12,01
    expect(annualAverage([1200, 1201, 1201]).averageCenti).toBe(1201);
    // (9,99 + 10,00) ÷ 2 = 9,995 → 10,00 : le demi monte
    expect(annualAverage([999, 1000, null]).averageCenti).toBe(1000);
  });

  it('accepte les bornes 0 et 20', () => {
    expect(annualAverage([0, 0, 0]).averageCenti).toBe(0);
    expect(annualAverage([2000, 2000, 2000]).averageCenti).toBe(2000);
    expect(annualAverage([0, 2000, 1000]).averageCenti).toBe(1000);
  });

  it('signale explicitement un trimestre manquant et moyenne les autres', () => {
    expect(annualAverage([null, 1100, 1300])).toEqual({
      averageCenti: 1200,
      missingTerms: [0],
      termsCounted: 2,
    });
    expect(annualAverage([1400, null, null])).toEqual({
      averageCenti: 1400,
      missingTerms: [1, 2],
      termsCounted: 1,
    });
  });

  it('ne calcule rien sans aucune moyenne trimestrielle', () => {
    expect(annualAverage([null, null, null])).toEqual({
      averageCenti: null,
      missingTerms: [0, 1, 2],
      termsCounted: 0,
    });
  });

  it('en mode strict, refuse la moyenne dès qu’un trimestre manque', () => {
    expect(annualAverage([1200, null, 1500], { policy: 'strict' })).toEqual({
      averageCenti: null,
      missingTerms: [1],
      termsCounted: 2,
    });
    expect(annualAverage([1200, 1300, 1500], { policy: 'strict' }).averageCenti).toBe(1333);
  });

  it('exige un nombre minimal de trimestres si demandé', () => {
    expect(annualAverage([1200, null, null], { minTerms: 2 }).averageCenti).toBeNull();
    expect(annualAverage([1200, 1400, null], { minTerms: 2 }).averageCenti).toBe(1300);
  });

  it('rejette les entrées invalides', () => {
    expect(() => annualAverage([])).toThrow(RangeError);
    expect(() => annualAverage([12.5, 1000, 1000])).toThrow(RangeError);
    expect(() => annualAverage([-1, 1000, 1000])).toThrow(RangeError);
    expect(() => annualAverage([2001, 1000, 1000])).toThrow(RangeError);
    expect(() => annualAverage([1000], { minTerms: 2 })).toThrow(RangeError);
    expect(() => annualAverage([1000], { minTerms: 0 })).toThrow(RangeError);
  });

  it('coïncide avec periodAverage quand tous les trimestres sont présents', () => {
    const terms = [1234, 987, 1555];
    expect(annualAverage(terms).averageCenti).toBe(periodAverage(terms));
  });

  it('peut différer de la moyenne pondérée des moyennes annuelles par matière', () => {
    // Deux matières, coefficients 3 et 1 ; la seconde n'est pas notée au 1er trimestre.
    const t1 = generalAverage([
      { coefficient: 3, averageCenti: 1000 },
      { coefficient: 1, averageCenti: null },
    ]).averageCenti;
    const t2 = generalAverage([
      { coefficient: 3, averageCenti: 1000 },
      { coefficient: 1, averageCenti: 2000 },
    ]).averageCenti;
    expect([t1, t2]).toEqual([1000, 1250]);
    // Règle retenue : moyenne des moyennes générales trimestrielles.
    expect(annualAverage([t1, t2]).averageCenti).toBe(1125);
  });
});

describe('annualClassResults', () => {
  it('classe sur la moyenne annuelle avec ex aequo et laisse hors classement les élèves sans moyenne', () => {
    const results = annualClassResults([
      { id: 'a', termGeneralAverages: [1200, 1300, 1400] }, // 13,00
      { id: 'b', termGeneralAverages: [1400, 1300, 1200] }, // 13,00
      { id: 'c', termGeneralAverages: [1500, 1600, null] }, // 15,50
      { id: 'd', termGeneralAverages: [800, 900, 1000] }, // 9,00
      { id: 'e', termGeneralAverages: [null, null, null] },
    ]);
    expect(results.get('c')).toMatchObject({
      averageCenti: 1550,
      missingTerms: [2],
      rank: { rank: 1, tied: false, ranked: 4 },
    });
    expect(results.get('a')?.rank).toEqual({ rank: 2, tied: true, ranked: 4 });
    expect(results.get('b')?.rank).toEqual({ rank: 2, tied: true, ranked: 4 });
    expect(results.get('d')?.rank).toEqual({ rank: 4, tied: false, ranked: 4 });
    expect(results.get('e')).toEqual({
      averageCenti: null,
      missingTerms: [0, 1, 2],
      termsCounted: 0,
      rank: null,
    });
  });

  it('applique la politique stricte au classement', () => {
    const results = annualClassResults(
      [
        { id: 'a', termGeneralAverages: [1200, 1300, 1400] },
        { id: 'b', termGeneralAverages: [1900, null, 1900] },
      ],
      { policy: 'strict' },
    );
    expect(results.get('a')?.rank).toEqual({ rank: 1, tied: false, ranked: 1 });
    expect(results.get('b')?.rank).toBeNull();
  });

  it('distingue des moyennes qui ne diffèrent que d’un centième', () => {
    const results = annualClassResults([
      { id: 'a', termGeneralAverages: [1000, 1000, 1000] },
      { id: 'b', termGeneralAverages: [1000, 1000, 1003] }, // 10,01
    ]);
    expect(results.get('b')?.rank?.rank).toBe(1);
    expect(results.get('a')?.rank?.rank).toBe(2);
  });
});

describe('passRate', () => {
  it('compte les moyennes d’au moins 10 / 20, le seuil inclus', () => {
    expect(passRate([1000, 999, 1500, 0])).toEqual({
      counted: 4,
      passed: 2,
      failed: 2,
      ratePermille: 500,
    });
    expect(PASS_THRESHOLD_CENTI).toBe(1000);
  });

  it('exclut les élèves sans moyenne', () => {
    expect(passRate([1200, null, 800])).toEqual({
      counted: 2,
      passed: 1,
      failed: 1,
      ratePermille: 500,
    });
  });

  it('arrondit au dixième de pour cent', () => {
    expect(passRate([1000, 1000, 0]).ratePermille).toBe(667);
    expect(passRate([1000, 0, 0]).ratePermille).toBe(333);
    expect(passRate([1000, 0, 0, 0, 0, 0, 0]).ratePermille).toBe(143);
  });

  it('n’affiche jamais 100 % avec un échec ni 0 % avec une réussite', () => {
    const many = [...Array<number>(1999).fill(1500), 500];
    expect(passRate(many).ratePermille).toBe(999);
    const few = [1500, ...Array<number>(2999).fill(500)];
    expect(passRate(few).ratePermille).toBe(1);
  });

  it('renvoie null sans aucune moyenne', () => {
    expect(passRate([])).toEqual({ counted: 0, passed: 0, failed: 0, ratePermille: null });
    expect(passRate([null, null]).ratePermille).toBeNull();
  });

  it('accepte un seuil personnalisé et rejette les valeurs invalides', () => {
    expect(passRate([1100, 1200], 1200).passed).toBe(1);
    expect(() => passRate([10.5])).toThrow(RangeError);
    expect(() => passRate([-5])).toThrow(RangeError);
    expect(() => passRate([1000], -1)).toThrow(RangeError);
  });
});

describe('formatRate', () => {
  it.each([
    [667, '66,7 %'],
    [1000, '100,0 %'],
    [0, '0,0 %'],
    [5, '0,5 %'],
    [null, '—'],
  ])('%s → %s', (value, expected) => {
    expect(formatRate(value)).toBe(expected);
  });

  it('rejette un taux hors bornes', () => {
    expect(() => formatRate(1001)).toThrow(RangeError);
    expect(() => formatRate(66.7)).toThrow(RangeError);
  });
});

describe('décisions de fin d’année', () => {
  it('propose admis à partir de 10 / 20 et redouble en dessous', () => {
    expect(suggestYearEndDecision(1000)).toBe('PROMOTED');
    expect(suggestYearEndDecision(999)).toBe('REPEAT');
    expect(suggestYearEndDecision(null)).toBeNull();
    expect(suggestYearEndDecision(1150, 1200)).toBe('REPEAT');
    expect(() => suggestYearEndDecision(10.5)).toThrow(RangeError);
  });

  it('a un libellé pour chaque décision', () => {
    for (const d of YEAR_END_DECISIONS) expect(YEAR_END_DECISION_LABELS[d]).toBeTruthy();
    expect(YEAR_END_DECISION_LABELS.PROMOTED).toBe('Admis en classe supérieure');
  });

  it('valide la décision du conseil avec ou sans décision de fin d’année', () => {
    expect(councilDecisionSchema.parse({ decision: 'NONE' })).toEqual({ decision: 'NONE' });
    expect(
      councilDecisionSchema.parse({ decision: 'HONOR_ROLL', yearEndDecision: 'PROMOTED' }),
    ).toMatchObject({ yearEndDecision: 'PROMOTED' });
    expect(councilDecisionSchema.parse({ decision: 'NONE', yearEndDecision: null })).toMatchObject({
      yearEndDecision: null,
    });
    expect(() => councilDecisionSchema.parse({ decision: 'NONE', yearEndDecision: 'X' })).toThrow();
  });
});

describe('transcriptQuerySchema', () => {
  it('exige la période correspondant à la portée', () => {
    expect(transcriptQuerySchema.safeParse({ scope: 'sequence', periodId: 's1' }).success).toBe(
      true,
    );
    expect(transcriptQuerySchema.safeParse({ scope: 'year' }).success).toBe(true);
    expect(transcriptQuerySchema.safeParse({ scope: 'term' }).success).toBe(false);
    expect(transcriptQuerySchema.safeParse({ scope: 'month', periodId: 'x' }).success).toBe(false);
  });
});

describe('proposeYearEndDecision', () => {
  it('admet à partir de la moyenne de passage, au centième près', () => {
    expect(proposeYearEndDecision(1000)?.decision).toBe('PROMOTED');
    expect(proposeYearEndDecision(999)?.decision).toBe('REPEAT');
    expect(proposeYearEndDecision(999)?.reason).toBe('moyenne annuelle inférieure à 10,00');
    expect(proposeYearEndDecision(1806)?.reason).toBe('moyenne annuelle d’au moins 10,00');
    expect(proposeYearEndDecision(null)).toBeNull();
  });

  it('propose l’exclusion d’un redoublant sous la moyenne, sauf si l’école l’a désactivée', () => {
    expect(proposeYearEndDecision(713, { repeating: true })).toEqual({
      decision: 'EXCLUDED_WORK',
      reason: 'redoublant sous 10,00 : un second redoublement de la classe n’est pas admis',
    });
    expect(proposeYearEndDecision(1000, { repeating: true })?.decision).toBe('PROMOTED');
    const lenient = resolveCouncilRules({ excludeFailingRepeaters: false });
    expect(proposeYearEndDecision(713, { repeating: true, rules: lenient })?.decision).toBe(
      'REPEAT',
    );
  });

  it('applique le seuil d’exclusion et la moyenne de passage propres à l’école', () => {
    const rules = resolveCouncilRules({ passThresholdCenti: 1050, exclusionThresholdCenti: 700 });
    expect(proposeYearEndDecision(1049, { rules })?.decision).toBe('REPEAT');
    expect(proposeYearEndDecision(1050, { rules })?.decision).toBe('PROMOTED');
    expect(proposeYearEndDecision(700, { rules })?.decision).toBe('REPEAT');
    expect(proposeYearEndDecision(699, { rules })).toEqual({
      decision: 'EXCLUDED_WORK',
      reason: 'moyenne annuelle inférieure à 7,00',
    });
    expect(() => proposeYearEndDecision(10.5)).toThrow(RangeError);
  });
});

describe('proposeDistinction', () => {
  it('suit les seuils 12, 14 et 16 par défaut, bornes comprises', () => {
    expect(proposeDistinction(1199)).toBe('NONE');
    expect(proposeDistinction(1200)).toBe('HONOR_ROLL');
    expect(proposeDistinction(1399)).toBe('HONOR_ROLL');
    expect(proposeDistinction(1400)).toBe('ENCOURAGEMENT');
    expect(proposeDistinction(1600)).toBe('CONGRATULATIONS');
    expect(proposeDistinction(null)).toBeNull();
    expect(() => proposeDistinction(-1)).toThrow(RangeError);
  });

  it('respecte les seuils de l’école', () => {
    const rules = resolveCouncilRules({ congratulationsCenti: 1500 });
    expect(proposeDistinction(1500, rules)).toBe('CONGRATULATIONS');
  });
});

describe('règles du conseil', () => {
  it('complète les règles partielles par les valeurs par défaut', () => {
    expect(resolveCouncilRules(null)).toEqual(DEFAULT_COUNCIL_RULES);
    expect(resolveCouncilRules({ honorRollCenti: 1100 })).toEqual({
      ...DEFAULT_COUNCIL_RULES,
      honorRollCenti: 1100,
    });
  });

  it('refuse des seuils incohérents', () => {
    expect(councilRulesSchema.safeParse(DEFAULT_COUNCIL_RULES).success).toBe(true);
    expect(
      councilRulesSchema.safeParse({ ...DEFAULT_COUNCIL_RULES, encouragementCenti: 1100 }).success,
    ).toBe(false);
    expect(
      councilRulesSchema.safeParse({ ...DEFAULT_COUNCIL_RULES, exclusionThresholdCenti: 1000 })
        .success,
    ).toBe(false);
    expect(
      councilRulesSchema.safeParse({ ...DEFAULT_COUNCIL_RULES, passThresholdCenti: 1000.5 })
        .success,
    ).toBe(false);
  });

  it('libelle chaque distinction et accepte les félicitations', () => {
    for (const d of COUNCIL_DECISIONS) expect(COUNCIL_DECISION_LABELS[d]).toBeTruthy();
    expect(councilDecisionSchema.parse({ decision: 'CONGRATULATIONS' })).toEqual({
      decision: 'CONGRATULATIONS',
    });
  });
});

describe('officialExamForLevel', () => {
  it('repère les classes d’examen', () => {
    expect(officialExamForLevel('3e')).toBe('BEPC');
    expect(officialExamForLevel('3ème')).toBe('BEPC');
    expect(officialExamForLevel('1re')).toBe('Probatoire');
    expect(officialExamForLevel('Première')).toBe('Probatoire');
    expect(officialExamForLevel('Tle')).toBe('Baccalauréat');
    expect(officialExamForLevel('Terminale D')).toBe('Baccalauréat');
    expect(officialExamForLevel('Form 5')).toBe('GCE O Level');
    expect(officialExamForLevel('Upper Sixth')).toBe('GCE A Level');
    for (const n of ['6e', '4e', '2nde', '30e', 'Lower Sixth', 'Form 4'])
      expect(officialExamForLevel(n)).toBeNull();
  });
});
