import { describe, expect, it } from 'vitest';
import {
  appreciation,
  classStatistics,
  divideRoundHalfUp,
  formatGrade,
  formatRank,
  generalAverage,
  normalizeTo20,
  parseGradeInput,
  periodAverage,
  rankWithTies,
  subjectAverage,
  weightedAverage,
  type EvaluationGrade,
} from './grades';

const score = (raw: string) => parseGradeInput(raw);

describe('parseGradeInput', () => {
  it.each([
    ['14', 1400],
    ['16,5', 1650],
    ['16.25', 1625],
    ['0', 0],
    ['20', 2000],
    ['9,05', 905],
    [' 12 ', 1200],
  ])('lit « %s » comme %i centièmes', (raw, centi) => {
    expect(parseGradeInput(raw)).toEqual({ kind: 'score', centi });
  });

  it('reconnaît les absences et dispenses, quelle que soit la casse', () => {
    expect(parseGradeInput('abs')).toEqual({ kind: 'absent' });
    expect(parseGradeInput('ABS')).toEqual({ kind: 'absent' });
    expect(parseGradeInput('Disp')).toEqual({ kind: 'exempt' });
  });

  it('distingue la saisie vide', () => {
    expect(parseGradeInput('')).toEqual({ kind: 'empty' });
    expect(parseGradeInput('   ')).toEqual({ kind: 'empty' });
    expect(parseGradeInput(null)).toEqual({ kind: 'empty' });
  });

  it.each(['21', '20,01', '-1', '12,345', 'a', '1 2', '12,', ',5', '1e1'])(
    'refuse « %s »',
    (raw) => {
      expect(parseGradeInput(raw).kind).toBe('invalid');
    },
  );

  it('respecte un barème différent de 20', () => {
    expect(parseGradeInput('35', 40)).toEqual({ kind: 'score', centi: 3500 });
    expect(parseGradeInput('41', 40).kind).toBe('invalid');
  });
});

describe('divideRoundHalfUp', () => {
  it('arrondit au demi supérieur', () => {
    expect(divideRoundHalfUp(3150, 4)).toBe(788); // 7,875 → 7,88
    expect(divideRoundHalfUp(3800, 3)).toBe(1267); // 12,666… → 12,67
    expect(divideRoundHalfUp(3700, 3)).toBe(1233); // 12,333… → 12,33
    expect(divideRoundHalfUp(5, 2)).toBe(3);
    expect(divideRoundHalfUp(0, 7)).toBe(0);
  });

  it('refuse un dénominateur nul ou des valeurs non entières', () => {
    expect(() => divideRoundHalfUp(10, 0)).toThrow(RangeError);
    expect(() => divideRoundHalfUp(1.5, 2)).toThrow(RangeError);
    expect(() => divideRoundHalfUp(-1, 2)).toThrow(RangeError);
  });
});

describe('normalizeTo20', () => {
  it('ramène une note sur 40 à une note sur 20', () => {
    expect(normalizeTo20(3500, 40)).toBe(1750);
    expect(normalizeTo20(1000, 30)).toBe(667); // 6,666… → 6,67
  });
});

describe('weightedAverage', () => {
  it('calcule une moyenne pondérée exacte', () => {
    expect(
      weightedAverage([
        { centi: 1400, weight: 1 },
        { centi: 1500, weight: 1 },
        { centi: 1650, weight: 2 },
      ]),
    ).toBe(1550);
  });

  it('renvoie null sans valeur', () => {
    expect(weightedAverage([])).toBeNull();
  });

  it('refuse un poids nul ou négatif', () => {
    expect(() => weightedAverage([{ centi: 1000, weight: 0 }])).toThrow(RangeError);
  });
});

describe('subjectAverage', () => {
  const evals = (interro: string, devoir: string, compo: string): EvaluationGrade[] => [
    { weight: 1, grade: score(interro) },
    { weight: 1, grade: score(devoir) },
    { weight: 2, grade: score(compo) },
  ];

  it('reproduit la grille de 4e A en mathématiques', () => {
    expect(subjectAverage(evals('14', '15', '16,5'))).toEqual({
      averageCenti: 1550,
      incomplete: false,
      formula: '(14,00 + 15,00 + 16,50 × 2) ÷ 4',
    });
    expect(subjectAverage(evals('8', '9,5', '7')).averageCenti).toBe(788);
    expect(subjectAverage(evals('13', '12,5', '15')).averageCenti).toBe(1388);
  });

  it('exclut une absence du calcul', () => {
    expect(subjectAverage(evals('abs', '12', '13')).averageCenti).toBe(1267);
  });

  it('exclut une dispense du calcul', () => {
    expect(subjectAverage(evals('disp', '10', '10')).averageCenti).toBe(1000);
  });

  it("ne calcule pas de moyenne s'il manque une note", () => {
    expect(subjectAverage(evals('10', '11', ''))).toEqual({
      averageCenti: null,
      incomplete: true,
      formula: null,
    });
  });

  it('ne calcule pas de moyenne si une note est invalide', () => {
    expect(subjectAverage(evals('10', '25', '12')).incomplete).toBe(true);
  });

  it('renvoie null si toutes les évaluations sont des absences', () => {
    expect(subjectAverage(evals('abs', 'abs', 'abs'))).toEqual({
      averageCenti: null,
      incomplete: false,
      formula: null,
    });
  });

  it('normalise les barèmes avant de pondérer', () => {
    const result = subjectAverage([
      { weight: 1, maxScore: 40, grade: parseGradeInput('30', 40) },
      { weight: 1, grade: score('10') },
    ]);
    expect(result.averageCenti).toBe(1250);
  });
});

describe('periodAverage', () => {
  it('fait la moyenne simple des séquences disponibles', () => {
    expect(periodAverage([1250, 1300])).toBe(1275);
    expect(periodAverage([1450, 1550])).toBe(1500);
    expect(periodAverage([1200, null])).toBe(1200);
    expect(periodAverage([null, null])).toBeNull();
  });
});

describe('generalAverage — bulletin du 1er trimestre de Ngono Marie-Claire', () => {
  // [S1, S2, coefficient]
  const subjects: [number, number, number][] = [
    [1250, 1300, 4], // Français
    [1000, 1150, 3], // Anglais
    [1400, 1300, 2], // Histoire-Géographie
    [1500, 1600, 2], // ECM
    [1100, 1250, 2], // Espagnol
    [1450, 1550, 4], // Mathématiques
    [1200, 1350, 2], // PCT
    [1300, 1400, 2], // SVT
    [1600, 1500, 2], // Informatique
    [1500, 1400, 2], // EPS
    [1300, 1400, 1], // Travail manuel
    [1200, 1300, 2], // LCN
  ];

  it('calcule la moyenne de séquence 1 (13,11)', () => {
    const r = generalAverage(
      subjects.map(([s1, , coefficient]) => ({ averageCenti: s1, coefficient })),
    );
    expect(r.totalCoefficient).toBe(28);
    expect(r.totalPointsCenti).toBe(36700);
    expect(r.averageCenti).toBe(1311);
  });

  it('calcule la moyenne de séquence 2 (13,73)', () => {
    const r = generalAverage(
      subjects.map(([, s2, coefficient]) => ({ averageCenti: s2, coefficient })),
    );
    expect(r.averageCenti).toBe(1373);
  });

  it('calcule la moyenne trimestrielle (13,42) à partir des moyennes de matières', () => {
    const lines = subjects.map(([s1, s2, coefficient]) => ({
      averageCenti: periodAverage([s1, s2]),
      coefficient,
    }));
    const r = generalAverage(lines);
    expect(r.totalPointsCenti).toBe(37575);
    expect(r.averageCenti).toBe(1342);
  });

  it('ignore les matières sans moyenne (dispense)', () => {
    const r = generalAverage([
      { averageCenti: 1200, coefficient: 2 },
      { averageCenti: null, coefficient: 4 },
    ]);
    expect(r).toEqual({ averageCenti: 1200, totalCoefficient: 2, totalPointsCenti: 2400 });
  });

  it('renvoie null sans aucune matière notée', () => {
    expect(generalAverage([{ averageCenti: null, coefficient: 3 }]).averageCenti).toBeNull();
  });
});

describe('rankWithTies', () => {
  const entries = [
    { id: 'abena', valueCenti: 1325 },
    { id: 'atangana', valueCenti: 788 },
    { id: 'bilong', valueCenti: 1725 },
    { id: 'djoumessi', valueCenti: 1125 },
    { id: 'ekotto', valueCenti: 1550 },
    { id: 'fouda', valueCenti: 1000 },
    { id: 'mballa', valueCenti: 1388 },
    { id: 'ngono', valueCenti: 1550 },
    { id: 'nji', valueCenti: 1267 },
    { id: 'owona', valueCenti: 725 },
    { id: 'tchana', valueCenti: null },
    { id: 'zambo', valueCenti: 1575 },
  ];
  const ranks = rankWithTies(entries);

  it('classe les ex aequo au même rang et saute le rang suivant', () => {
    expect(ranks.get('bilong')).toEqual({ rank: 1, tied: false, ranked: 11 });
    expect(ranks.get('zambo')?.rank).toBe(2);
    expect(ranks.get('ekotto')).toEqual({ rank: 3, tied: true, ranked: 11 });
    expect(ranks.get('ngono')).toEqual({ rank: 3, tied: true, ranked: 11 });
    expect(ranks.get('mballa')?.rank).toBe(5);
    expect(ranks.get('owona')?.rank).toBe(11);
  });

  it('ne classe pas un élève sans moyenne', () => {
    expect(ranks.has('tchana')).toBe(false);
  });

  it('gère une égalité générale', () => {
    const all = rankWithTies([
      { id: 1, valueCenti: 1000 },
      { id: 2, valueCenti: 1000 },
    ]);
    expect([...all.values()].map((r) => r.rank)).toEqual([1, 1]);
  });

  it('gère une liste vide', () => {
    expect(rankWithTies([]).size).toBe(0);
  });
});

describe('appreciation', () => {
  it.each([
    [2000, 'Très bien'],
    [1600, 'Très bien'],
    [1599, 'Bien'],
    [1400, 'Bien'],
    [1200, 'Assez bien'],
    [1000, 'Passable'],
    [999, 'Insuffisant'],
    [0, 'Insuffisant'],
  ])('%i → %s', (centi, label) => {
    expect(appreciation(centi)).toBe(label);
  });

  it('accepte un barème propre à l’école', () => {
    expect(
      appreciation(1100, [
        { minCenti: 1000, label: 'Admis' },
        { minCenti: 0, label: 'Non admis' },
      ]),
    ).toBe('Admis');
  });
});

describe('formatage', () => {
  it('formate les notes avec une virgule', () => {
    expect(formatGrade(1342)).toBe('13,42');
    expect(formatGrade(905)).toBe('9,05');
    expect(formatGrade(0)).toBe('0,00');
    expect(formatGrade(null)).toBe('—');
  });

  it('formate les rangs', () => {
    expect(formatRank({ rank: 1, tied: false, ranked: 3 })).toBe('1er');
    expect(formatRank({ rank: 3, tied: true, ranked: 3 })).toBe('3e ex');
    expect(formatRank(undefined)).toBe('—');
  });
});

describe('classStatistics', () => {
  it('calcule moyenne, extrêmes et réussite', () => {
    expect(classStatistics([1725, 1575, 900, null])).toEqual({
      count: 3,
      averageCenti: 1400,
      minCenti: 900,
      maxCenti: 1725,
      passCount: 2,
    });
  });

  it('gère une classe sans note', () => {
    expect(classStatistics([null]).averageCenti).toBeNull();
  });
});
