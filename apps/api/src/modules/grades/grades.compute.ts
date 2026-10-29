import {
  appreciation,
  classStatistics,
  formatRank,
  parseGradeInput,
  rankWithTies,
  subjectAverage,
  type ParsedGrade,
} from '@ecole/shared';
import type { Grade, GradeStatus } from '@prisma/client';

export interface SheetEvaluation {
  id: string;
  weight: number;
  maxScore: number;
}

export interface SheetStudent {
  id: string;
  firstName: string;
  lastName: string;
  matricule: string;
}

export function toParsed(grade: Pick<Grade, 'status' | 'valueCenti'> | undefined): ParsedGrade {
  if (!grade) return { kind: 'empty' };
  if (grade.status === 'ABSENT') return { kind: 'absent' };
  if (grade.status === 'EXEMPT') return { kind: 'exempt' };
  return grade.valueCenti === null ? { kind: 'empty' } : { kind: 'score', centi: grade.valueCenti };
}

/** Saisie compacte affichée dans la grille : 1650 → « 16,5 », 1400 → « 14 ». */
export function compactGrade(grade: Pick<Grade, 'status' | 'valueCenti'> | undefined): string {
  if (!grade) return '';
  if (grade.status === 'ABSENT') return 'abs';
  if (grade.status === 'EXEMPT') return 'disp';
  if (grade.valueCenti === null) return '';
  const whole = Math.floor(grade.valueCenti / 100);
  const frac = grade.valueCenti % 100;
  if (frac === 0) return String(whole);
  return `${whole},${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** Convertit une saisie en valeur à stocker ; `null` = supprimer la note. */
export function toStored(raw: string, maxScore: number): { status: GradeStatus; valueCenti: number | null } | null | 'invalid' {
  const parsed = parseGradeInput(raw, maxScore);
  switch (parsed.kind) {
    case 'empty':
      return null;
    case 'invalid':
      return 'invalid';
    case 'absent':
      return { status: 'ABSENT', valueCenti: null };
    case 'exempt':
      return { status: 'EXEMPT', valueCenti: null };
    case 'score':
      return { status: 'SCORE', valueCenti: parsed.centi };
  }
}

/**
 * Calcule la grille d'une matière sur une séquence : moyenne de chaque élève,
 * rang avec ex aequo, appréciation et statistiques de classe.
 */
export function computeSheet(
  students: readonly SheetStudent[],
  evaluations: readonly SheetEvaluation[],
  grades: readonly Pick<Grade, 'evaluationId' | 'studentId' | 'status' | 'valueCenti'>[],
) {
  const byKey = new Map(grades.map((g) => [`${g.evaluationId}:${g.studentId}`, g]));
  const rows = students.map((s) => {
    const cells = evaluations.map((e) => {
      const g = byKey.get(`${e.id}:${s.id}`);
      return { evaluationId: e.id, value: compactGrade(g), grade: toParsed(g) };
    });
    const result = subjectAverage(
      evaluations.map((e, i) => ({ weight: e.weight, maxScore: e.maxScore, grade: cells[i]?.grade ?? { kind: 'empty' } })),
    );
    return { student: s, cells, ...result };
  });
  const ranks = rankWithTies(rows.map((r) => ({ id: r.student.id, valueCenti: r.averageCenti })));
  const stats = classStatistics(rows.map((r) => r.averageCenti));
  const columnAverages = evaluations.map((e, i) => {
    const scores = rows
      .map((r) => r.cells[i]?.grade)
      .filter((g): g is { kind: 'score'; centi: number } => g?.kind === 'score')
      .map((g) => Math.round((g.centi * 20) / e.maxScore));
    return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  });
  return {
    rows: rows.map((r) => {
      const rank = ranks.get(r.student.id);
      return {
        student: r.student,
        cells: r.cells.map((c) => ({ evaluationId: c.evaluationId, value: c.value })),
        averageCenti: r.averageCenti,
        incomplete: r.incomplete,
        formula: r.formula,
        rank: rank ? { ...rank, label: formatRank(rank) } : null,
        appreciation: r.averageCenti === null ? null : appreciation(r.averageCenti),
      };
    }),
    stats,
    columnAverages,
    missing: rows.reduce((n, r) => n + r.cells.filter((c) => c.grade.kind === 'empty').length, 0),
  };
}
