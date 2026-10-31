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

/** Distinctions et sanctions trimestrielles du conseil de classe. */
export const COUNCIL_DECISIONS = [
  'CONGRATULATIONS',
  'ENCOURAGEMENT',
  'HONOR_ROLL',
  'WARNING',
  'BLAME',
  'NONE',
] as const;
export type CouncilDecision = (typeof COUNCIL_DECISIONS)[number];

export const COUNCIL_DECISION_LABELS: Record<CouncilDecision, string> = {
  CONGRATULATIONS: 'Félicitations',
  ENCOURAGEMENT: 'Encouragements',
  HONOR_ROLL: 'Tableau d’honneur',
  WARNING: 'Avertissement',
  BLAME: 'Blâme',
  NONE: 'Aucune mention',
};

/**
 * Règles du conseil de classe, propres à chaque école (paramètres). Moyennes en centièmes.
 * Les valeurs par défaut suivent l'usage du secondaire camerounais ; chaque proposition reste
 * modifiable par le conseil.
 */
export interface CouncilRules {
  /** Moyenne annuelle de passage en classe supérieure. */
  passThresholdCenti: number;
  /** Seuils des distinctions trimestrielles (tableau d'honneur ≤ encouragements ≤ félicitations). */
  honorRollCenti: number;
  encouragementCenti: number;
  congratulationsCenti: number;
  /** Proposer l'exclusion d'un redoublant qui n'atteint pas la moyenne de passage. */
  excludeFailingRepeaters: boolean;
  /** Moyenne annuelle sous laquelle l'exclusion est proposée ; `null` : jamais sur ce seul critère. */
  exclusionThresholdCenti: number | null;
}

export const DEFAULT_COUNCIL_RULES: CouncilRules = {
  passThresholdCenti: PASS_THRESHOLD_CENTI,
  honorRollCenti: 1200,
  encouragementCenti: 1400,
  congratulationsCenti: 1600,
  excludeFailingRepeaters: true,
  exclusionThresholdCenti: null,
};

/** Règles de l'école complétées par les valeurs par défaut. */
export function resolveCouncilRules(partial?: Partial<CouncilRules> | null): CouncilRules {
  const rules = { ...DEFAULT_COUNCIL_RULES };
  for (const key of Object.keys(DEFAULT_COUNCIL_RULES) as (keyof CouncilRules)[]) {
    const value = partial?.[key];
    if (value !== undefined) (rules as Record<string, unknown>)[key] = value;
  }
  return rules;
}

const fmt = (centi: number) => `${Math.floor(centi / 100)},${String(centi % 100).padStart(2, '0')}`;

export interface YearEndProposal {
  decision: YearEndDecision;
  /** Motif lisible de la proposition, affiché au conseil. */
  reason: string;
}

/**
 * Proposition de décision de fin d'année : admis au-dessus de la moyenne de passage ; en dessous,
 * redoublement, ou exclusion pour un redoublant (un second redoublement de la même classe n'est
 * pas admis) ou sous le seuil d'exclusion de l'école. Le rachat reste l'affaire du seul conseil.
 */
export function proposeYearEndDecision(
  annualAverageCenti: number | null,
  {
    repeating = false,
    rules = DEFAULT_COUNCIL_RULES,
  }: { repeating?: boolean; rules?: CouncilRules } = {},
): YearEndProposal | null {
  if (annualAverageCenti === null) return null;
  if (!Number.isInteger(annualAverageCenti) || annualAverageCenti < 0)
    throw new RangeError('Moyenne invalide');
  const pass = rules.passThresholdCenti;
  if (annualAverageCenti >= pass)
    return { decision: 'PROMOTED', reason: `moyenne annuelle d’au moins ${fmt(pass)}` };
  if (rules.exclusionThresholdCenti !== null && annualAverageCenti < rules.exclusionThresholdCenti)
    return {
      decision: 'EXCLUDED_WORK',
      reason: `moyenne annuelle inférieure à ${fmt(rules.exclusionThresholdCenti)}`,
    };
  if (repeating && rules.excludeFailingRepeaters)
    return {
      decision: 'EXCLUDED_WORK',
      reason: `redoublant sous ${fmt(pass)} : un second redoublement de la classe n’est pas admis`,
    };
  return { decision: 'REPEAT', reason: `moyenne annuelle inférieure à ${fmt(pass)}` };
}

/**
 * Distinction proposée d'après la moyenne générale du trimestre : félicitations, encouragements,
 * tableau d'honneur ou aucune. Les sanctions (avertissement, blâme) relèvent du seul conseil, qui
 * tient aussi compte de la conduite. `null` si l'élève n'a pas de moyenne.
 */
export function proposeDistinction(
  termAverageCenti: number | null,
  rules: CouncilRules = DEFAULT_COUNCIL_RULES,
): Extract<CouncilDecision, 'CONGRATULATIONS' | 'ENCOURAGEMENT' | 'HONOR_ROLL' | 'NONE'> | null {
  if (termAverageCenti === null) return null;
  if (!Number.isInteger(termAverageCenti) || termAverageCenti < 0)
    throw new RangeError('Moyenne invalide');
  if (termAverageCenti >= rules.congratulationsCenti) return 'CONGRATULATIONS';
  if (termAverageCenti >= rules.encouragementCenti) return 'ENCOURAGEMENT';
  if (termAverageCenti >= rules.honorRollCenti) return 'HONOR_ROLL';
  return 'NONE';
}

/**
 * Examen officiel qui sanctionne la fin d'un niveau (« 3e » → BEPC, « 1re » → Probatoire,
 * « Tle » → Baccalauréat, et leurs équivalents anglophones), `null` sinon. Dans ces classes, le
 * passage dépend aussi du résultat à l'examen.
 */
export function officialExamForLevel(levelName: string): string | null {
  const n = levelName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (/^(3e?(me)?|troisieme)(\s|$)/.test(n)) return 'BEPC';
  if (/^(1re|1ere|premiere)(\s|$)/.test(n)) return 'Probatoire';
  if (/^(tle|terminale)(\s|$)/.test(n)) return 'Baccalauréat';
  if (/^form\s*5(\s|$)/.test(n)) return 'GCE O Level';
  if (/^upper\s*sixth(\s|$)/.test(n)) return 'GCE A Level';
  return null;
}
