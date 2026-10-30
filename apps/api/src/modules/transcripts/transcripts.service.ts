import { Injectable, NotFoundException } from '@nestjs/common';
import { annualAverage, generalAverage } from '@ecole/shared';
import { SubjectGroup } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId } from '../../common/context';
import { fromDbDate } from '../../common/dates';
import { Db, InjectDb } from '../../common/prisma';
import { compactGrade } from '../grades/grades.compute';
import { computeCells, GROUP_LABELS } from '../report-cards/report-cards.service';

export type TranscriptScope = 'sequence' | 'term' | 'year';

export interface TranscriptSubject {
  name: string;
  group: SubjectGroup;
  coefficient: number;
  /** Séquence : détail des évaluations de la matière. */
  evaluations: { name: string; weight: number; maxScore: number; value: string }[];
  /** Trimestre : moyenne de chaque séquence ; année : moyenne de chaque trimestre. */
  columns: (number | null)[];
  averageCenti: number | null;
}

export interface TranscriptData {
  school: { name: string; city: string };
  year: string;
  scope: TranscriptScope;
  /** « Séquence 1 », « 1er trimestre », « Année scolaire 2026-2027 ». */
  period: string;
  student: {
    id: string;
    matricule: string;
    firstName: string;
    lastName: string;
    birthDate: string;
    birthPlace: string | null;
  };
  className: string;
  columns: string[];
  groups: { label: string; subjects: TranscriptSubject[] }[];
  /** Moyenne générale de chaque colonne (séquences ou trimestres). */
  columnGeneralAverages: (number | null)[];
  generalAverageCenti: number | null;
  totalCoefficient: number;
  generatedAt: string;
  /**
   * Écart avec un bulletin publié de la période (notes rouvertes depuis la publication) : le
   * relevé reflète les notes actuelles, le bulletin publié reste le document de référence.
   */
  publicationNotice: string | null;
}

const GROUP_ORDER: SubjectGroup[] = ['LITERARY', 'SCIENTIFIC', 'OTHER'];

/**
 * Relevés de notes par élève, distincts du bulletin : notes et moyennes d'une séquence, d'un
 * trimestre ou de l'année, sans rang ni décision du conseil. Seules les évaluations soumises ou
 * validées sont prises en compte, comme sur les bulletins.
 */
@Injectable()
export class TranscriptsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Période d'un relevé : séquences couvertes et année scolaire. */
  private async period(scope: TranscriptScope, periodId?: string) {
    if (scope === 'sequence') {
      const seq = await this.db.sequence.findUnique({
        where: { id: periodId ?? '' },
        include: { term: true },
      });
      if (!seq) throw new NotFoundException('Séquence introuvable');
      return {
        yearId: seq.term.academicYearId,
        label: seq.name,
        terms: [{ id: seq.termId, name: seq.term.name, sequences: [seq] }],
      };
    }
    if (scope === 'term') {
      const term = await this.db.term.findUnique({
        where: { id: periodId ?? '' },
        include: { sequences: { orderBy: { order: 'asc' } } },
      });
      if (!term) throw new NotFoundException('Trimestre introuvable');
      return { yearId: term.academicYearId, label: term.name, terms: [term] };
    }
    const year = periodId
      ? await this.db.academicYear.findUnique({ where: { id: periodId } })
      : await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) throw new NotFoundException('Année scolaire introuvable');
    const terms = await this.db.term.findMany({
      where: { academicYearId: year.id },
      include: { sequences: { orderBy: { order: 'asc' } } },
      orderBy: { order: 'asc' },
    });
    if (terms.length === 0) throw new NotFoundException('Aucun trimestre pour cette année');
    return { yearId: year.id, label: `Année scolaire ${year.name}`, terms };
  }

  async compute(studentId: string, scope: TranscriptScope, periodId?: string) {
    const student = await this.db.student.findFirst({ where: { id: studentId, deletedAt: null } });
    if (!student) throw new NotFoundException('Élève introuvable');
    const period = await this.period(scope, periodId);
    const enrollment = await this.db.enrollment.findFirst({
      where: { studentId, academicYearId: period.yearId },
      orderBy: { createdAt: 'desc' },
      include: { class: { include: { academicYear: true } } },
    });
    if (!enrollment) throw new NotFoundException('Élève non inscrit pour cette période');
    const [school, classSubjects] = await Promise.all([
      this.db.school.findUniqueOrThrow({
        where: { id: currentSchoolId() },
        select: { name: true, city: true },
      }),
      this.db.classSubject.findMany({
        where: { classId: enrollment.classId },
        include: { subject: true },
      }),
    ]);
    const sequences = period.terms.flatMap((t) => t.sequences);
    const evaluations = await this.db.evaluation.findMany({
      where: {
        classSubjectId: { in: classSubjects.map((c) => c.id) },
        sequenceId: { in: sequences.map((s) => s.id) },
        status: { in: ['SUBMITTED', 'LOCKED'] },
      },
      include: { grades: { where: { studentId } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    const students = [{ id: studentId }];
    const key = (csId: string) => `${studentId}:${csId}`;

    // Colonnes et moyennes par matière selon la portée.
    let columns: string[];
    let perSubject: (csId: string) => { columns: (number | null)[]; average: number | null };
    let columnGenerals: (number | null)[];
    let generalAverageCenti: number | null;
    const general = (avg: (csId: string) => number | null) =>
      generalAverage(
        classSubjects.map((cs) => ({ coefficient: cs.coefficient, averageCenti: avg(cs.id) })),
      );
    if (scope === 'year') {
      const perTerm = period.terms.map((t) =>
        computeCells(students, classSubjects, t.sequences, evaluations),
      );
      columns = period.terms.map((t) => t.name);
      perSubject = (csId) => {
        const terms = perTerm.map((cells) => cells.get(key(csId))?.term ?? null);
        return { columns: terms, average: annualAverage(terms).averageCenti };
      };
      columnGenerals = perTerm.map(
        (cells) => general((csId) => cells.get(key(csId))?.term ?? null).averageCenti,
      );
      // Même règle que le bulletin annuel : moyenne des moyennes générales trimestrielles.
      generalAverageCenti = annualAverage(columnGenerals).averageCenti;
    } else {
      const cells = computeCells(students, classSubjects, sequences, evaluations);
      columns = scope === 'term' ? sequences.map((s) => s.name) : [];
      perSubject = (csId) => {
        const c = cells.get(key(csId));
        return {
          columns: scope === 'term' ? (c?.seq ?? []) : [],
          average: c?.term ?? null,
        };
      };
      columnGenerals =
        scope === 'term'
          ? sequences.map(
              (_, i) => general((csId) => cells.get(key(csId))?.seq[i] ?? null).averageCenti,
            )
          : [];
      generalAverageCenti = general((csId) => cells.get(key(csId))?.term ?? null).averageCenti;
    }
    const totals = general((csId) => perSubject(csId).average);

    // Bulletins publiés de la période : moyenne trimestrielle recalculée comparée à l'instantané.
    const published = await this.db.reportCard.findMany({
      where: {
        studentId,
        termId: { in: period.terms.map((t) => t.id) },
        status: 'PUBLISHED',
      },
      select: { termId: true, generalAverageCenti: true, needsRepublish: true },
    });
    const termAverage = (termId: string): number | null | undefined => {
      if (scope === 'term') return generalAverageCenti;
      if (scope === 'year') return columnGenerals[period.terms.findIndex((t) => t.id === termId)];
      return undefined;
    };
    const diverging = period.terms.filter((t) => {
      const card = published.find((c) => c.termId === t.id);
      if (!card) return false;
      const computed = termAverage(t.id);
      return (
        card.needsRepublish || (computed !== undefined && computed !== card.generalAverageCenti)
      );
    });
    const publicationNotice =
      diverging.length > 0
        ? `Notes modifiées depuis la publication du bulletin (${diverging
            .map((t) => t.name)
            .join(
              ', ',
            )}) : ce relevé reflète les notes actuelles et diffère du bulletin publié, qui fait foi jusqu’à sa republication.`
        : null;

    const subjects = classSubjects.map((cs): TranscriptSubject => {
      const r = perSubject(cs.id);
      return {
        name: cs.subject.name,
        group: cs.subject.group,
        coefficient: cs.coefficient,
        evaluations:
          scope === 'sequence'
            ? evaluations
                .filter((e) => e.classSubjectId === cs.id)
                .map((e) => ({
                  name: e.name,
                  weight: e.weight,
                  maxScore: e.maxScore,
                  value: transcriptValue(e.grades[0]),
                }))
            : [],
        columns: r.columns,
        averageCenti: r.average,
      };
    });
    const data: TranscriptData = {
      school,
      year: enrollment.class.academicYear.name,
      scope,
      period: period.label,
      student: {
        id: student.id,
        matricule: student.matricule,
        firstName: student.firstName,
        lastName: student.lastName,
        birthDate: fromDbDate(student.birthDate),
        birthPlace: student.birthPlace,
      },
      className: enrollment.class.name,
      columns,
      groups: GROUP_ORDER.map((group) => ({
        label: GROUP_LABELS[group],
        subjects: subjects
          .filter((x) => x.group === group)
          .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
      })).filter((g) => g.subjects.length > 0),
      columnGeneralAverages: columnGenerals,
      generalAverageCenti,
      totalCoefficient: totals.totalCoefficient,
      generatedAt: new Date().toISOString(),
      publicationNotice,
    };
    return data;
  }

  /** Journalise l'édition d'un relevé (document officiel). */
  async logIssued(data: TranscriptData, channel: 'staff' | 'portal') {
    await this.audit.log({
      action: 'transcripts.issued',
      entity: 'Student',
      entityId: data.student.id,
      after: { scope: data.scope, period: data.period, channel },
    });
  }
}

function transcriptValue(grade: Parameters<typeof compactGrade>[0]): string {
  if (!grade) return '—';
  if (grade.status === 'ABSENT') return 'Absent';
  if (grade.status === 'EXEMPT') return 'Dispensé';
  return compactGrade(grade) || '—';
}
