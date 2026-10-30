/**
 * Résultats de fin d'année : moyennes annuelles, rang annuel, taux de réussite et décisions
 * de fin d'année. Toutes les moyennes sont en centièmes de point (1342 = 13,42 / 20).
 *
 * Règle du secondaire camerounais : la moyenne annuelle (d'une matière ou générale) est la
 * moyenne arithmétique des moyennes trimestrielles. Un trimestre sans moyenne (élève arrivé en
 * cours d'année, matière non évaluée, dispense) est traité explicitement selon `policy`.
 */

import { divideRoundHalfUp, rankWithTies, type RankResult } from './grades';

/** Seuil de réussite : 10 / 20. */
export const PASS_THRESHOLD_CENTI = 1000;

/**
 * Traitement d'un trimestre sans moyenne :
 * - `available` : moyenne des trimestres disponibles, le trimestre manquant est signalé ;
 * - `strict` : pas de moyenne annuelle tant qu'un trimestre manque.
 */
export type MissingTermPolicy = 'available' | 'strict';

export interface AnnualAverageOptions {
  policy?: MissingTermPolicy;
  /** Nombre minimal de trimestres notés pour calculer une moyenne (politique `available`). */
  minTerms?: number;
}

export interface AnnualAverageResult {
  /** Moyenne annuelle en centièmes, `null` si non calculable. */
  averageCenti: number | null;
  /** Positions (0 = 1er trimestre) des trimestres sans moyenne. */
  missingTerms: number[];
  /** Nombre de trimestres pris en compte dans la moyenne. */
  termsCounted: number;
}

/**
 * Moyenne annuelle : moyenne arithmétique des moyennes trimestrielles, arrondie au centième
 * (demi supérieur). `termAverages` contient une entrée par trimestre de l'année, `null` si le
 * trimestre n'a pas de moyenne.
 */
export function annualAverage(
  termAverages: readonly (number | null)[],
  { policy = 'available', minTerms = 1 }: AnnualAverageOptions = {},
): AnnualAverageResult {
  if (termAverages.length === 0) throw new RangeError('Aucun trimestre dans l’année');
  if (!Number.isInteger(minTerms) || minTerms < 1 || minTerms > termAverages.length)
    throw new RangeError('minTerms doit être compris entre 1 et le nombre de trimestres');
  const missingTerms: number[] = [];
  let sum = 0;
  let count = 0;
  termAverages.forEach((value, i) => {
    if (value === null) {
      missingTerms.push(i);
      return;
    }
    if (!Number.isInteger(value) || value < 0 || value > 2000)
      throw new RangeError('Une moyenne trimestrielle doit être un entier entre 0 et 2000');
    sum += value;
    count++;
  });
  const computable = policy === 'strict' ? missingTerms.length === 0 : count >= minTerms;
  return {
    averageCenti: computable && count > 0 ? divideRoundHalfUp(sum, count) : null,
    missingTerms,
    termsCounted: count,
  };
}

export interface AnnualStudentInput<Id> {
  id: Id;
  /** Moyenne générale de chaque trimestre de l'année, `null` si absente. */
  termGeneralAverages: readonly (number | null)[];
}

export interface AnnualStudentResult extends AnnualAverageResult {
  /** Rang annuel avec ex aequo, `null` si l'élève n'est pas classé. */
  rank: RankResult | null;
}

/**
 * Moyennes générales annuelles et rang annuel d'une classe. Les élèves sans moyenne annuelle
 * ne sont pas classés ; deux moyennes identiques au centième sont ex aequo.
 */
export function annualClassResults<Id>(
  students: readonly AnnualStudentInput<Id>[],
  options: AnnualAverageOptions = {},
): Map<Id, AnnualStudentResult> {
  const averages = new Map(
    students.map((s) => [s.id, annualAverage(s.termGeneralAverages, options)] as const),
  );
  const ranks = rankWithTies(
    students.map((s) => ({ id: s.id, valueCenti: averages.get(s.id)?.averageCenti ?? null })),
  );
  const result = new Map<Id, AnnualStudentResult>();
  for (const s of students) {
    const a = averages.get(s.id);
    if (!a) continue;
    result.set(s.id, { ...a, rank: ranks.get(s.id) ?? null });
  }
  return result;
}

export interface PassRateResult {
  /** Élèves ayant une moyenne. */
  counted: number;
  /** Élèves ayant au moins le seuil. */
  passed: number;
  failed: number;
  /** Taux en dixièmes de pour cent (667 = 66,7 %), `null` si personne n'a de moyenne. */
  ratePermille: number | null;
}

/**
 * Taux de réussite : part des élèves dont la moyenne atteint le seuil (10 / 20 par défaut).
 * Les élèves sans moyenne sont exclus. L'arrondi ne donne jamais 100 % s'il y a un échec,
 * ni 0 % s'il y a une réussite.
 */
export function passRate(
  averages: readonly (number | null)[],
  thresholdCenti = PASS_THRESHOLD_CENTI,
): PassRateResult {
  if (!Number.isInteger(thresholdCenti) || thresholdCenti < 0)
    throw new RangeError('Le seuil doit être un entier positif ou nul');
  let counted = 0;
  let passed = 0;
  for (const a of averages) {
    if (a === null) continue;
    if (!Number.isInteger(a) || a < 0) throw new RangeError('Moyenne invalide');
    counted++;
    if (a >= thresholdCenti) passed++;
  }
  if (counted === 0) return { counted, passed, failed: 0, ratePermille: null };
  let rate = divideRoundHalfUp(passed * 1000, counted);
  if (passed < counted) rate = Math.min(rate, 999);
  if (passed > 0) rate = Math.max(rate, 1);
  return { counted, passed, failed: counted - passed, ratePermille: rate };
}

/** 667 → « 66,7 % » ; `null` → « — ». */
export function formatRate(permille: number | null): string {
  if (permille === null) return '—';
  if (!Number.isInteger(permille) || permille < 0 || permille > 1000)
    throw new RangeError('Taux invalide');
  return `${Math.floor(permille / 10)},${permille % 10} %`;
}

/** Décisions de fin d'année du conseil de classe. */
export const YEAR_END_DECISIONS = [
  'PROMOTED',
  'PROMOTED_BY_COUNCIL',
  'REPEAT',
  'EXCLUDED_WORK',
  'EXCLUDED_CONDUCT',
] as const;
export type YearEndDecision = (typeof YEAR_END_DECISIONS)[number];

export const YEAR_END_DECISION_LABELS: Record<YearEndDecision, string> = {
  PROMOTED: 'Admis en classe supérieure',
  PROMOTED_BY_COUNCIL: 'Admis par décision du conseil',
  REPEAT: 'Redouble',
  EXCLUDED_WORK: 'Exclu pour insuffisance de travail',
  EXCLUDED_CONDUCT: 'Exclu pour indiscipline',
};

/**
 * Proposition de décision à partir de la moyenne annuelle : admis au-dessus du seuil, redouble
 * en dessous. L'exclusion et le rachat relèvent du seul conseil de classe.
 */
export function suggestYearEndDecision(
  annualAverageCenti: number | null,
  thresholdCenti = PASS_THRESHOLD_CENTI,
): YearEndDecision | null {
  if (annualAverageCenti === null) return null;
  if (!Number.isInteger(annualAverageCenti) || annualAverageCenti < 0)
    throw new RangeError('Moyenne invalide');
  return annualAverageCenti >= thresholdCenti ? 'PROMOTED' : 'REPEAT';
}
