/**
 * Calculs des notes. Toutes les notes et moyennes sont manipulées en centièmes
 * de point (entiers) pour éviter les erreurs d'arrondi des flottants :
 * 13,42 / 20 est représenté par 1342.
 */

export const DEFAULT_MAX_SCORE = 20;

export type ParsedGrade =
  | { kind: 'score'; centi: number }
  | { kind: 'absent' }
  | { kind: 'exempt' }
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string };

/**
 * Lit une saisie d'enseignant : « 14 », « 16,5 », « 16.25 », « abs », « disp ».
 * Deux décimales au plus, note comprise entre 0 et `maxScore`.
 */
export function parseGradeInput(
  raw: string | null | undefined,
  maxScore = DEFAULT_MAX_SCORE,
): ParsedGrade {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === '') return { kind: 'empty' };
  if (s === 'abs') return { kind: 'absent' };
  if (s === 'disp') return { kind: 'exempt' };
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!match) return { kind: 'invalid', reason: 'format' };
  const whole = Number(match[1]);
  const frac = match[2] ? Number(match[2].padEnd(2, '0')) : 0;
  const centi = whole * 100 + frac;
  if (centi > maxScore * 100) return { kind: 'invalid', reason: 'out_of_range' };
  return { kind: 'score', centi };
}

/** Ramène une note sur `maxScore` à une note sur 20, en centièmes, arrondi au plus proche. */
export function normalizeTo20(centi: number, maxScore: number): number {
  assertNonNegativeInt(centi, 'centi');
  if (!Number.isInteger(maxScore) || maxScore <= 0)
    throw new RangeError('maxScore doit être un entier positif');
  return divideRoundHalfUp(centi * DEFAULT_MAX_SCORE, maxScore);
}

/**
 * Division entière arrondie au demi supérieur, pour des entiers positifs ou nuls.
 * 7,875 → 7,88 ; 12,6666… → 12,67.
 */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  assertNonNegativeInt(numerator, 'numerator');
  if (!Number.isInteger(denominator) || denominator <= 0) {
    throw new RangeError('Le dénominateur doit être un entier strictement positif');
  }
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export interface WeightedValue {
  /** Valeur en centièmes. */
  centi: number;
  /** Poids ou coefficient, entier strictement positif. */
  weight: number;
}

/** Moyenne pondérée arrondie au centième. `null` si aucune valeur. */
export function weightedAverage(values: readonly WeightedValue[]): number | null {
  let num = 0;
  let den = 0;
  for (const v of values) {
    assertNonNegativeInt(v.centi, 'centi');
    if (!Number.isInteger(v.weight) || v.weight <= 0) {
      throw new RangeError('Le poids doit être un entier strictement positif');
    }
    num += v.centi * v.weight;
    den += v.weight;
  }
  if (den === 0) return null;
  return divideRoundHalfUp(num, den);
}

export interface EvaluationGrade {
  /** Poids de l'évaluation dans la moyenne de la matière. */
  weight: number;
  /** Barème de l'évaluation (20 par défaut). */
  maxScore?: number;
  grade: ParsedGrade;
}

export interface SubjectAverageResult {
  /** Moyenne sur 20 en centièmes, `null` si non calculable. */
  averageCenti: number | null;
  /** Vrai si au moins une note est manquante ou invalide. */
  incomplete: boolean;
  /** Détail lisible du calcul, ex. « (14,00 + 15,00 + 16,50 × 2) ÷ 4 ». */
  formula: string | null;
}

/**
 * Moyenne d'une matière sur une période : moyenne pondérée des évaluations.
 * Les absences et dispenses sont exclues du calcul. Une note manquante ou invalide
 * rend la moyenne incomplète : elle n'est alors pas calculée.
 */
export function subjectAverage(evaluations: readonly EvaluationGrade[]): SubjectAverageResult {
  const values: WeightedValue[] = [];
  const parts: string[] = [];
  let incomplete = false;
  for (const e of evaluations) {
    const g = e.grade;
    if (g.kind === 'empty' || g.kind === 'invalid') {
      incomplete = true;
      continue;
    }
    if (g.kind !== 'score') continue;
    const on20 = normalizeTo20(g.centi, e.maxScore ?? DEFAULT_MAX_SCORE);
    values.push({ centi: on20, weight: e.weight });
    parts.push(e.weight > 1 ? `${formatGrade(on20)} × ${e.weight}` : formatGrade(on20));
  }
  if (incomplete) return { averageCenti: null, incomplete: true, formula: null };
  const averageCenti = weightedAverage(values);
  if (averageCenti === null) return { averageCenti: null, incomplete: false, formula: null };
  const den = values.reduce((s, v) => s + v.weight, 0);
  return { averageCenti, incomplete: false, formula: `(${parts.join(' + ')}) ÷ ${den}` };
}

/**
 * Moyenne d'une matière sur un trimestre (ou l'année) : moyenne simple des moyennes
 * de séquences (ou de trimestres) disponibles.
 */
export function periodAverage(averages: readonly (number | null)[]): number | null {
  const present = averages.filter((a): a is number => a !== null);
  return weightedAverage(present.map((centi) => ({ centi, weight: 1 })));
}

export interface SubjectLine {
  coefficient: number;
  /** Moyenne de la matière en centièmes, `null` si dispensé ou non noté. */
  averageCenti: number | null;
}

export interface GeneralAverageResult {
  averageCenti: number | null;
  /** Somme des coefficients pris en compte. */
  totalCoefficient: number;
  /** Somme des (moyenne × coefficient), en centièmes. */
  totalPointsCenti: number;
}

/**
 * Moyenne générale : Σ(moyenne × coefficient) ÷ Σ coefficients, sur les matières notées.
 * Les moyennes de matières sont déjà arrondies au centième, comme sur le bulletin.
 */
export function generalAverage(subjects: readonly SubjectLine[]): GeneralAverageResult {
  let totalPointsCenti = 0;
  let totalCoefficient = 0;
  for (const s of subjects) {
    if (s.averageCenti === null) continue;
    assertNonNegativeInt(s.averageCenti, 'averageCenti');
    if (!Number.isInteger(s.coefficient) || s.coefficient <= 0) {
      throw new RangeError('Le coefficient doit être un entier strictement positif');
    }
    totalPointsCenti += s.averageCenti * s.coefficient;
    totalCoefficient += s.coefficient;
  }
  return {
    averageCenti:
      totalCoefficient === 0 ? null : divideRoundHalfUp(totalPointsCenti, totalCoefficient),
    totalCoefficient,
    totalPointsCenti,
  };
}

export interface RankEntry<Id> {
  id: Id;
  valueCenti: number | null;
}

export interface RankResult {
  /** Rang « olympique » : 1, 2, 2, 4. */
  rank: number;
  /** Vrai si au moins un autre élève a exactement la même moyenne. */
  tied: boolean;
  /** Nombre d'élèves classés. */
  ranked: number;
}

/**
 * Classement avec ex aequo (rang de compétition) : deux élèves à 15,50 sont tous
 * deux 3e, le suivant est 5e. Les élèves sans moyenne ne sont pas classés.
 */
export function rankWithTies<Id>(entries: readonly RankEntry<Id>[]): Map<Id, RankResult> {
  const ranked = entries.filter(
    (e): e is RankEntry<Id> & { valueCenti: number } => e.valueCenti !== null,
  );
  const counts = new Map<number, number>();
  for (const e of ranked) counts.set(e.valueCenti, (counts.get(e.valueCenti) ?? 0) + 1);
  const distinct = [...counts.keys()].sort((a, b) => b - a);
  const rankOf = new Map<number, number>();
  let position = 1;
  for (const value of distinct) {
    rankOf.set(value, position);
    position += counts.get(value) ?? 0;
  }
  const result = new Map<Id, RankResult>();
  for (const e of ranked) {
    result.set(e.id, {
      rank: rankOf.get(e.valueCenti) ?? 0,
      tied: (counts.get(e.valueCenti) ?? 0) > 1,
      ranked: ranked.length,
    });
  }
  return result;
}

export interface AppreciationBand {
  minCenti: number;
  label: string;
}

/** Barème par défaut, configurable par école. Trié du plus haut au plus bas. */
export const DEFAULT_APPRECIATIONS: readonly AppreciationBand[] = [
  { minCenti: 1600, label: 'Très bien' },
  { minCenti: 1400, label: 'Bien' },
  { minCenti: 1200, label: 'Assez bien' },
  { minCenti: 1000, label: 'Passable' },
  { minCenti: 0, label: 'Insuffisant' },
];

export function appreciation(
  centi: number,
  bands: readonly AppreciationBand[] = DEFAULT_APPRECIATIONS,
): string {
  const sorted = [...bands].sort((a, b) => b.minCenti - a.minCenti);
  for (const band of sorted) {
    if (centi >= band.minCenti) return band.label;
  }
  return sorted[sorted.length - 1]?.label ?? '';
}

/** 1342 → « 13,42 ». */
export function formatGrade(centi: number | null): string {
  if (centi === null) return '—';
  assertNonNegativeInt(centi, 'centi');
  const whole = Math.floor(centi / 100);
  const frac = String(centi % 100).padStart(2, '0');
  return `${whole},${frac}`;
}

/** Rang lisible : « 1er », « 3e ex ». */
export function formatRank(r: RankResult | undefined | null): string {
  if (!r) return '—';
  const base = r.rank === 1 ? '1er' : `${r.rank}e`;
  return r.tied ? `${base} ex` : base;
}

/** Statistiques de classe pour un ensemble de moyennes. */
export function classStatistics(averages: readonly (number | null)[]): {
  count: number;
  averageCenti: number | null;
  minCenti: number | null;
  maxCenti: number | null;
  passCount: number;
} {
  const present = averages.filter((a): a is number => a !== null);
  if (present.length === 0) {
    return { count: 0, averageCenti: null, minCenti: null, maxCenti: null, passCount: 0 };
  }
  return {
    count: present.length,
    averageCenti: divideRoundHalfUp(
      present.reduce((s, a) => s + a, 0),
      present.length,
    ),
    minCenti: Math.min(...present),
    maxCenti: Math.max(...present),
    passCount: present.filter((a) => a >= 1000).length,
  };
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} doit être un entier positif ou nul`);
  }
}
