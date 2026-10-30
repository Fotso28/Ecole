import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  annualAverage,
  annualClassResults,
  appreciation,
  classStatistics,
  formatRank,
  generalAverage,
  passRate,
  periodAverage,
  rankWithTies,
  subjectAverage,
  toMinutes,
  YEAR_END_DECISION_LABELS,
} from '@ecole/shared';
import {
  CouncilDecisionType,
  Prisma,
  SubjectGroup,
  type Evaluation,
  type Grade,
  type YearEndDecisionType,
} from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { sha256, verificationCode } from '../../common/crypto';
import { fromDbDate } from '../../common/dates';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { toParsed } from '../grades/grades.compute';
import { NotificationsService } from '../notifications/notifications.service';
import { templates } from '../notifications/templates';

export const GROUP_LABELS: Record<SubjectGroup, string> = {
  LITERARY: 'Enseignements littéraires',
  SCIENTIFIC: 'Enseignements scientifiques',
  OTHER: 'Autres enseignements',
};

export const DECISION_LABELS: Record<CouncilDecisionType, string> = {
  HONOR_ROLL: "Tableau d'honneur",
  ENCOURAGEMENT: 'Encouragements',
  WARNING: 'Avertissement',
  BLAME: 'Blâme',
  NONE: 'Aucune mention',
};

export interface ReportCardSubject {
  subjectId: string;
  name: string;
  teacher: string | null;
  coefficient: number;
  sequenceAverages: (number | null)[];
  averageCenti: number | null;
  totalCenti: number | null;
  rank: string;
  appreciation: string | null;
  /** Bulletin de fin d'année : moyenne de chaque trimestre, moyenne et rang annuels. */
  termAverages?: (number | null)[];
  annualAverageCenti?: number | null;
  annualRank?: string;
}

/** Bilan annuel, présent sur le bulletin du dernier trimestre de l'année. */
export interface ReportCardAnnual {
  terms: { id: string; name: string; order: number }[];
  termGeneralAverages: (number | null)[];
  generalAverageCenti: number | null;
  rank: number | null;
  rankLabel: string;
  tied: boolean;
  ranked: number;
  appreciation: string | null;
  /** Trimestres sans moyenne : la moyenne annuelle porte sur les autres. */
  missingTerms: string[];
  classStats: { averageCenti: number | null; minCenti: number | null; maxCenti: number | null };
  /** Taux de réussite annuel de la classe, en dixièmes de pour cent. */
  classPassRatePermille: number | null;
}

export interface ReportCardData {
  school: { name: string; city: string };
  year: string;
  term: { id: string; name: string; order: number };
  student: {
    id: string;
    matricule: string;
    firstName: string;
    lastName: string;
    gender: string;
    birthDate: string;
    birthPlace: string | null;
    repeating: boolean;
  };
  class: { id: string; name: string; size: number; mainTeacher: string | null };
  sequences: { id: string; name: string }[];
  groups: {
    group: SubjectGroup;
    label: string;
    subjects: ReportCardSubject[];
    totalCoefficient: number;
    totalPointsCenti: number;
    averageCenti: number | null;
  }[];
  totals: {
    totalCoefficient: number;
    totalPointsCenti: number;
    generalAverageCenti: number | null;
    rank: number | null;
    rankLabel: string;
    tied: boolean;
    ranked: number;
    appreciation: string | null;
  };
  sequenceGeneralAverages: (number | null)[];
  classStats: { averageCenti: number | null; minCenti: number | null; maxCenti: number | null };
  attendance: {
    justifiedHours: number;
    unjustifiedHours: number;
    lates: number;
    incidents: number;
  };
  decision: { type: CouncilDecisionType; label: string; comment: string | null } | null;
  annual?: ReportCardAnnual;
  yearEndDecision?: { type: YearEndDecisionType; label: string } | null;
  generatedAt: string;
  /** Empreinte des notes et des élèves utilisés : la publication refuse un brouillon périmé. */
  inputsDigest?: string;
  /** Saisies manquantes au moment de la préparation. */
  issues?: string[];
}

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

type Cell = { seq: (number | null)[]; term: number | null };
type GradedEvaluation = Evaluation & { grades: Grade[] };

/** Moyennes par élève et matière sur les séquences d'un trimestre (clé « élève:matière de classe »). */
export function computeCells(
  students: readonly { id: string }[],
  classSubjects: readonly { id: string }[],
  sequences: readonly { id: string }[],
  evaluations: readonly GradedEvaluation[],
): Map<string, Cell> {
  const cell = new Map<string, Cell>();
  for (const s of students) {
    for (const cs of classSubjects) {
      const seq = sequences.map((sq) => {
        const evs = evaluations.filter((e) => e.classSubjectId === cs.id && e.sequenceId === sq.id);
        if (evs.length === 0) return null;
        const r = subjectAverage(
          evs.map((e) => ({
            weight: e.weight,
            maxScore: e.maxScore,
            grade: toParsed(e.grades.find((g) => g.studentId === s.id)),
          })),
        );
        return r.averageCenti;
      });
      cell.set(`${s.id}:${cs.id}`, { seq, term: periodAverage(seq) });
    }
  }
  return cell;
}

/** Le bulletin du dernier trimestre d'une année d'au moins deux trimestres est un bulletin annuel. */
export function isFinalTerm(
  term: { id: string },
  yearTerms: readonly { id: string; order: number }[],
): boolean {
  if (yearTerms.length < 2) return false;
  const last = [...yearTerms].sort((a, b) => b.order - a.order)[0];
  return last?.id === term.id;
}

@Injectable()
export class ReportCardsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Calcule et enregistre les bulletins (brouillons) d'une classe pour un trimestre. */
  async generate(classId: string, termId: string) {
    const { cls, term, yearTerms, final } = await this.classTerm(classId, termId);
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { name: true, city: true },
    });

    const { students, enrollments, classSubjects, evaluations, issues, digest } = await this.inputs(
      classId,
      final ? yearTerms.flatMap((t) => t.sequences) : term.sequences,
      termId,
    );
    if (students.length === 0) throw new ConflictException('Aucun élève inscrit dans cette classe');
    if (!evaluations.some((e) => term.sequences.some((sq) => sq.id === e.sequenceId)))
      throw new ConflictException('Aucune note soumise pour ce trimestre');
    const teacherIds = [
      ...new Set(
        [cls.mainTeacherId, ...classSubjects.map((c) => c.teacherId)].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
    const teachers = await this.db.user.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const teacherName = (id: string | null) => {
      const t = teachers.find((u) => u.id === id);
      return t ? `${t.lastName} ${t.firstName.charAt(0)}.` : null;
    };

    // Moyennes par élève, matière et séquence.
    const cell = computeCells(students, classSubjects, term.sequences, evaluations);
    const general = new Map(
      students.map((s) => [
        s.id,
        generalAverage(
          classSubjects.map((cs) => ({
            coefficient: cs.coefficient,
            averageCenti: cell.get(`${s.id}:${cs.id}`)?.term ?? null,
          })),
        ),
      ]),
    );
    const generalRanks = rankWithTies(
      students.map((s) => ({ id: s.id, valueCenti: general.get(s.id)?.averageCenti ?? null })),
    );
    const subjectRanks = new Map(
      classSubjects.map((cs) => [
        cs.id,
        rankWithTies(
          students.map((s) => ({
            id: s.id,
            valueCenti: cell.get(`${s.id}:${cs.id}`)?.term ?? null,
          })),
        ),
      ]),
    );
    const stats = classStatistics(students.map((s) => general.get(s.id)?.averageCenti ?? null));
    const annual = final
      ? this.annualResults(students, classSubjects, yearTerms, term.id, cell, evaluations)
      : null;

    // Assiduité sur la période du trimestre.
    const records = await this.db.attendanceRecord.findMany({
      where: {
        studentId: { in: students.map((s) => s.id) },
        session: { classId, date: { gte: term.startDate, lte: term.endDate } },
      },
      include: {
        session: { select: { startTime: true, endTime: true } },
        justification: { select: { status: true } },
      },
    });
    const incidents = await this.db.incident.groupBy({
      by: ['studentId'],
      where: {
        studentId: { in: students.map((s) => s.id) },
        date: { gte: term.startDate, lte: term.endDate },
      },
      _count: { _all: true },
    });
    const decisions = await this.db.councilDecision.findMany({
      where: { termId, studentId: { in: students.map((s) => s.id) } },
    });
    const existing = await this.db.reportCard.findMany({
      where: { termId, studentId: { in: students.map((s) => s.id) } },
    });

    const groupOrder: SubjectGroup[] = ['LITERARY', 'SCIENTIFIC', 'OTHER'];
    const generatedAt = new Date().toISOString();
    const results: { studentId: string; version: number; generalAverageCenti: number | null }[] =
      [];

    await this.db.$transaction(async (tx) => {
      // Brouillons des élèves sortis de la classe depuis la dernière préparation : ils garderaient
      // une empreinte périmée et bloqueraient la publication.
      await tx.reportCard.deleteMany({
        where: {
          classId,
          termId,
          status: 'DRAFT',
          studentId: { notIn: students.map((s) => s.id) },
        },
      });
      for (const s of students) {
        const g = general.get(s.id);
        const rank = generalRanks.get(s.id);
        const studentRecords = records.filter((r) => r.studentId === s.id);
        let justified = 0;
        let unjustified = 0;
        let lates = 0;
        for (const r of studentRecords) {
          if (r.status === 'LATE') lates++;
          if (r.status !== 'ABSENT') continue;
          const minutes = toMinutes(r.session.endTime) - toMinutes(r.session.startTime);
          if (r.justification?.status === 'ACCEPTED') justified += minutes;
          else unjustified += minutes;
        }
        const decision = decisions.find((d) => d.studentId === s.id);
        const data: ReportCardData = {
          school,
          year: cls.academicYear.name,
          term: { id: term.id, name: term.name, order: term.order },
          student: {
            id: s.id,
            matricule: s.matricule,
            firstName: s.firstName,
            lastName: s.lastName,
            gender: s.gender,
            birthDate: fromDbDate(s.birthDate),
            birthPlace: s.birthPlace,
            repeating: enrollments.find((e) => e.studentId === s.id)?.status === 'REPEATING',
          },
          class: {
            id: cls.id,
            name: cls.name,
            size: students.length,
            mainTeacher: teacherName(cls.mainTeacherId),
          },
          sequences: term.sequences.map((sq) => ({ id: sq.id, name: sq.name })),
          groups: groupOrder
            .map((group) => {
              const subjects = classSubjects
                .filter((cs) => cs.subject.group === group)
                .sort((a, b) => a.subject.name.localeCompare(b.subject.name, 'fr'))
                .map((cs): ReportCardSubject => {
                  const c = cell.get(`${s.id}:${cs.id}`);
                  const avg = c?.term ?? null;
                  return {
                    subjectId: cs.subjectId,
                    name: cs.subject.name,
                    teacher: teacherName(cs.teacherId),
                    coefficient: cs.coefficient,
                    sequenceAverages: c?.seq ?? [],
                    averageCenti: avg,
                    totalCenti: avg === null ? null : avg * cs.coefficient,
                    rank: formatRank(subjectRanks.get(cs.id)?.get(s.id)),
                    appreciation: avg === null ? null : appreciation(avg),
                    ...(annual ? annual.forSubject(s.id, cs.id) : {}),
                  };
                });
              const sub = generalAverage(
                subjects.map((x) => ({ coefficient: x.coefficient, averageCenti: x.averageCenti })),
              );
              return {
                group,
                label: GROUP_LABELS[group],
                subjects,
                totalCoefficient: sub.totalCoefficient,
                totalPointsCenti: sub.totalPointsCenti,
                averageCenti: sub.averageCenti,
              };
            })
            .filter((grp) => grp.subjects.length > 0),
          totals: {
            totalCoefficient: g?.totalCoefficient ?? 0,
            totalPointsCenti: g?.totalPointsCenti ?? 0,
            generalAverageCenti: g?.averageCenti ?? null,
            rank: rank?.rank ?? null,
            rankLabel: formatRank(rank),
            tied: rank?.tied ?? false,
            ranked: rank?.ranked ?? 0,
            appreciation: g?.averageCenti == null ? null : appreciation(g.averageCenti),
          },
          sequenceGeneralAverages: term.sequences.map(
            (_, i) =>
              generalAverage(
                classSubjects.map((cs) => ({
                  coefficient: cs.coefficient,
                  averageCenti: cell.get(`${s.id}:${cs.id}`)?.seq[i] ?? null,
                })),
              ).averageCenti,
          ),
          classStats: {
            averageCenti: stats.averageCenti,
            minCenti: stats.minCenti,
            maxCenti: stats.maxCenti,
          },
          attendance: {
            justifiedHours: hours(justified),
            unjustifiedHours: hours(unjustified),
            lates,
            incidents: incidents.find((i) => i.studentId === s.id)?._count._all ?? 0,
          },
          decision: decision
            ? {
                type: decision.decision,
                label: DECISION_LABELS[decision.decision],
                comment: decision.comment,
              }
            : null,
          ...(annual
            ? {
                annual: annual.forStudent(s.id),
                yearEndDecision: decision?.yearEndDecision
                  ? {
                      type: decision.yearEndDecision,
                      label: YEAR_END_DECISION_LABELS[decision.yearEndDecision],
                    }
                  : null,
              }
            : {}),
          generatedAt,
          inputsDigest: digest,
          issues,
        };
        const mine = existing.filter((r) => r.studentId === s.id);
        await tx.reportCard.deleteMany({ where: { termId, studentId: s.id, status: 'DRAFT' } });
        const version =
          Math.max(0, ...mine.filter((r) => r.status !== 'DRAFT').map((r) => r.version)) + 1;
        await tx.reportCard.create({
          data: {
            schoolId: currentSchoolId(),
            studentId: s.id,
            classId,
            termId,
            version,
            status: 'DRAFT',
            data: data as unknown as Prisma.InputJsonValue,
            generalAverageCenti: g?.averageCenti ?? null,
            rank: rank?.rank ?? null,
            rankTied: rank?.tied ?? false,
            classSize: students.length,
            verificationCode: verificationCode(12),
            annualAverageCenti: data.annual?.generalAverageCenti ?? null,
            annualRank: data.annual?.rank ?? null,
          },
        });
        results.push({ studentId: s.id, version, generalAverageCenti: g?.averageCenti ?? null });
      }
      await this.audit.log(
        {
          action: 'reportcards.generated',
          entity: 'Class',
          entityId: classId,
          after: { termId, count: students.length, issues, annual: final },
        },
        tx,
      );
    });
    return { generated: results.length, results, issues, annual: final };
  }

  /**
   * Bilan annuel d'une classe : moyennes trimestrielles de chaque matière (calculées à partir des
   * notes soumises de toute l'année), moyennes et rangs annuels par matière et généraux.
   */
  private annualResults(
    students: readonly { id: string }[],
    classSubjects: readonly { id: string; coefficient: number }[],
    yearTerms: readonly { id: string; name: string; order: number; sequences: { id: string }[] }[],
    currentTermId: string,
    currentCells: Map<string, Cell>,
    evaluations: readonly GradedEvaluation[],
  ) {
    const perTerm = yearTerms.map((t) =>
      t.id === currentTermId
        ? currentCells
        : computeCells(students, classSubjects, t.sequences, evaluations),
    );
    const key = (studentId: string, csId: string) => `${studentId}:${csId}`;
    const termGenerals = new Map(
      students.map((s) => [
        s.id,
        perTerm.map(
          (cells) =>
            generalAverage(
              classSubjects.map((cs) => ({
                coefficient: cs.coefficient,
                averageCenti: cells.get(key(s.id, cs.id))?.term ?? null,
              })),
            ).averageCenti,
        ),
      ]),
    );
    const general = annualClassResults(
      students.map((s) => ({ id: s.id, termGeneralAverages: termGenerals.get(s.id) ?? [] })),
    );
    const subjectTerms = (studentId: string, csId: string) =>
      perTerm.map((cells) => cells.get(key(studentId, csId))?.term ?? null);
    const subjectAnnual = new Map<string, number | null>();
    for (const s of students)
      for (const cs of classSubjects)
        subjectAnnual.set(key(s.id, cs.id), annualAverage(subjectTerms(s.id, cs.id)).averageCenti);
    const subjectRanks = new Map(
      classSubjects.map((cs) => [
        cs.id,
        rankWithTies(
          students.map((s) => ({
            id: s.id,
            valueCenti: subjectAnnual.get(key(s.id, cs.id)) ?? null,
          })),
        ),
      ]),
    );
    const averages = students.map((s) => general.get(s.id)?.averageCenti ?? null);
    const stats = classStatistics(averages);
    const classPassRatePermille = passRate(averages).ratePermille;
    const terms = yearTerms.map((t) => ({ id: t.id, name: t.name, order: t.order }));
    return {
      forSubject: (studentId: string, csId: string) => ({
        termAverages: subjectTerms(studentId, csId),
        annualAverageCenti: subjectAnnual.get(key(studentId, csId)) ?? null,
        annualRank: formatRank(subjectRanks.get(csId)?.get(studentId)),
      }),
      forStudent: (studentId: string): ReportCardAnnual => {
        const g = general.get(studentId);
        const avg = g?.averageCenti ?? null;
        return {
          terms,
          termGeneralAverages: termGenerals.get(studentId) ?? [],
          generalAverageCenti: avg,
          rank: g?.rank?.rank ?? null,
          rankLabel: formatRank(g?.rank),
          tied: g?.rank?.tied ?? false,
          ranked: g?.rank?.ranked ?? 0,
          appreciation: avg === null ? null : appreciation(avg),
          missingTerms: (g?.missingTerms ?? []).map((i) => terms[i]?.name ?? ''),
          classStats: {
            averageCenti: stats.averageCenti,
            minCenti: stats.minCenti,
            maxCenti: stats.maxCenti,
          },
          classPassRatePermille,
        };
      },
    };
  }

  /** Saisies manquantes d'une classe pour un trimestre (affichées avant la publication). */
  async completeness(classId: string, termId: string) {
    const { term, yearTerms, final } = await this.classTerm(classId, termId);
    const { issues } = await this.inputs(
      classId,
      final ? yearTerms.flatMap((t) => t.sequences) : term.sequences,
      termId,
    );
    return { issues, annual: final };
  }

  private async classTerm(classId: string, termId: string) {
    const cls = await this.db.class.findUnique({
      where: { id: classId },
      include: { academicYear: true },
    });
    if (!cls) throw new NotFoundException('Classe introuvable');
    const term = await this.db.term.findUnique({
      where: { id: termId },
      include: { sequences: { orderBy: { order: 'asc' } } },
    });
    if (!term || term.academicYearId !== cls.academicYearId)
      throw new NotFoundException('Trimestre introuvable pour cette classe');
    const yearTerms = await this.db.term.findMany({
      where: { academicYearId: cls.academicYearId },
      include: { sequences: { orderBy: { order: 'asc' } } },
      orderBy: { order: 'asc' },
    });
    return { cls, term, yearTerms, final: isFinalTerm(term, yearTerms) };
  }

  /**
   * Données d'entrée des bulletins : élèves, matières, évaluations soumises, saisies manquantes
   * (feuille non soumise, note absente) et empreinte permettant de détecter un brouillon périmé.
   */
  private async inputs(
    classId: string,
    sequences: readonly { id: string; name: string }[],
    termId: string,
  ) {
    const [students, enrollments, classSubjects, decisions] = await Promise.all([
      this.scope.classStudents(classId),
      this.db.enrollment.findMany({
        where: { classId },
        select: { studentId: true, status: true },
      }),
      this.db.classSubject.findMany({
        where: { classId },
        include: { subject: true },
        orderBy: { subject: { name: 'asc' } },
      }),
      this.db.councilDecision.findMany({ where: { termId }, orderBy: { studentId: 'asc' } }),
    ]);
    const all = await this.db.evaluation.findMany({
      where: {
        classSubjectId: { in: classSubjects.map((c) => c.id) },
        sequenceId: { in: sequences.map((s) => s.id) },
      },
      include: { grades: true },
      orderBy: { id: 'asc' },
    });
    const evaluations = all.filter((e) => e.status === 'SUBMITTED' || e.status === 'LOCKED');
    const issues: string[] = [];
    for (const cs of classSubjects) {
      for (const sq of sequences) {
        const label = `${cs.subject.name} · ${sq.name}`;
        const evs = all.filter((e) => e.classSubjectId === cs.id && e.sequenceId === sq.id);
        if (evs.some((e) => e.status === 'DRAFT')) {
          issues.push(`${label} : saisie non soumise`);
          continue;
        }
        if (evs.length === 0) {
          issues.push(`${label} : aucune note`);
          continue;
        }
        const missing = students.filter((st) =>
          evs.some((e) => !e.grades.some((g) => g.studentId === st.id)),
        ).length;
        if (missing > 0)
          issues.push(`${label} : ${missing} élève${missing > 1 ? 's' : ''} sans note`);
      }
    }
    const digest = sha256(
      JSON.stringify({
        students: students.map((st) => st.id),
        evaluations: evaluations.map((e) => [
          e.id,
          e.status,
          e.weight,
          e.maxScore,
          e.grades.map((g) => `${g.studentId}:${g.status}:${g.valueCenti ?? ''}`).sort(),
        ]),
        // Coefficients et décisions du conseil figurent aussi sur le bulletin : les modifier après
        // la préparation impose de préparer à nouveau.
        coefficients: classSubjects.map((cs) => [cs.id, cs.coefficient]),
        decisions: decisions.map((d) => [
          d.studentId,
          d.decision,
          d.yearEndDecision ?? '',
          d.comment ?? '',
        ]),
      }),
    );
    return { students, enrollments, classSubjects, evaluations, issues, digest };
  }

  /**
   * Publie les brouillons : ils deviennent définitifs, la version précédente est remplacée.
   * Refusé si les notes ont changé depuis la préparation, ou s'il manque des saisies sans motif
   * de publication (journalisé).
   */
  async publish(classId: string, termId: string, overrideReason?: string) {
    const drafts = await this.db.reportCard.findMany({
      where: { classId, termId, status: 'DRAFT' },
    });
    if (drafts.length === 0) throw new ConflictException('Aucun bulletin en brouillon à publier');
    const { term, yearTerms, final } = await this.classTerm(classId, termId);
    const { issues, digest } = await this.inputs(
      classId,
      final ? yearTerms.flatMap((t) => t.sequences) : term.sequences,
      termId,
    );
    if (drafts.some((d) => (d.data as unknown as ReportCardData).inputsDigest !== digest))
      throw new ConflictException(
        'Les notes ou les élèves ont changé depuis la préparation : préparez à nouveau les bulletins',
      );
    if (issues.length > 0 && !overrideReason)
      throw new ConflictException({
        statusCode: 409,
        message: `${issues.length} saisie(s) manquante(s) : indiquez un motif pour publier malgré tout`,
        issues,
      });
    const actorId = staffContext().userId;
    await this.db.$transaction(async (tx) => {
      for (const d of drafts) {
        await tx.reportCard.updateMany({
          where: { studentId: d.studentId, termId, status: 'PUBLISHED' },
          data: { status: 'SUPERSEDED' },
        });
        await tx.reportCard.update({
          where: { id: d.id },
          data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: actorId },
        });
        const links = await tx.studentGuardian.findMany({
          where: { studentId: d.studentId },
          include: { guardian: true },
          orderBy: { isPrimary: 'desc' },
        });
        const phone = links[0]?.guardian.phone;
        const data = d.data as unknown as ReportCardData;
        if (phone) {
          await this.notifications.enqueue(
            {
              schoolId: d.schoolId,
              recipient: phone,
              template: data.annual ? 'annualReportCardPublished' : 'reportCardPublished',
              body: data.annual
                ? templates.annualReportCardPublished({
                    student: `${data.student.firstName} ${data.student.lastName}`,
                    average: data.annual.generalAverageCenti,
                    decision: data.yearEndDecision?.label ?? null,
                  })
                : templates.reportCardPublished({
                    student: `${data.student.firstName} ${data.student.lastName}`,
                    term: term.name.toLowerCase(),
                    average: d.generalAverageCenti,
                  }),
              payload: { reportCardId: d.id },
            },
            tx,
          );
        }
      }
      await this.audit.log(
        {
          action: issues.length > 0 ? 'reportcards.published_incomplete' : 'reportcards.published',
          entity: 'Class',
          entityId: classId,
          after: {
            termId,
            count: drafts.length,
            ...(issues.length ? { issues, overrideReason } : {}),
          },
        },
        tx,
      );
    });
    return { published: drafts.length };
  }

  /** Dernière version de chaque bulletin de la classe. */
  async list(classId: string, termId: string) {
    const cards = await this.db.reportCard.findMany({
      where: { classId, termId },
      orderBy: [{ studentId: 'asc' }, { version: 'desc' }],
      select: {
        id: true,
        studentId: true,
        version: true,
        status: true,
        generalAverageCenti: true,
        rank: true,
        rankTied: true,
        classSize: true,
        publishedAt: true,
        annualAverageCenti: true,
        data: true,
      },
    });
    const latest = new Map<string, (typeof cards)[number]>();
    for (const c of cards) if (!latest.has(c.studentId)) latest.set(c.studentId, c);
    return [...latest.values()]
      .map((c) => {
        const data = c.data as unknown as ReportCardData;
        return {
          id: c.id,
          studentId: c.studentId,
          student: `${data.student.lastName} ${data.student.firstName}`,
          matricule: data.student.matricule,
          version: c.version,
          status: c.status,
          generalAverageCenti: c.generalAverageCenti,
          rank: c.rank,
          rankLabel: data.totals.rankLabel,
          classSize: c.classSize,
          publishedAt: c.publishedAt,
          decision: data.decision?.label ?? null,
          annualAverageCenti: c.annualAverageCenti,
          annualRankLabel: data.annual?.rankLabel ?? null,
          yearEndDecision: data.yearEndDecision?.label ?? null,
        };
      })
      .sort(
        (a, b) => (a.rank ?? 9999) - (b.rank ?? 9999) || a.student.localeCompare(b.student, 'fr'),
      );
  }

  async get(id: string) {
    const card = await this.db.reportCard.findUnique({ where: { id } });
    if (!card) throw new NotFoundException('Bulletin introuvable');
    return card;
  }

  async setDecision(
    studentId: string,
    termId: string,
    decision: CouncilDecisionType,
    comment?: string,
    yearEndDecision?: YearEndDecisionType | null,
  ) {
    await this.db.student.findUniqueOrThrow({ where: { id: studentId } });
    const term = await this.db.term.findUniqueOrThrow({ where: { id: termId } });
    if (yearEndDecision) {
      const yearTerms = await this.db.term.findMany({
        where: { academicYearId: term.academicYearId },
        select: { id: true, order: true },
      });
      if (!isFinalTerm(term, yearTerms))
        throw new ConflictException(
          'La décision de fin d’année se prend au conseil du dernier trimestre',
        );
    }
    const decidedById = staffContext().userId;
    const before = await this.db.councilDecision.findUnique({
      where: { studentId_termId: { studentId, termId } },
    });
    const result = await this.db.councilDecision.upsert({
      where: { studentId_termId: { studentId, termId } },
      create: {
        schoolId: currentSchoolId(),
        studentId,
        termId,
        decision,
        comment,
        decidedById,
        yearEndDecision: yearEndDecision ?? null,
      },
      update: {
        decision,
        comment,
        decidedById,
        ...(yearEndDecision !== undefined ? { yearEndDecision } : {}),
      },
    });
    await this.audit.log({
      action: 'reportcards.decision',
      entity: 'CouncilDecision',
      entityId: result.id,
      before: before
        ? {
            decision: before.decision,
            comment: before.comment,
            yearEndDecision: before.yearEndDecision,
          }
        : undefined,
      after: { decision, comment, yearEndDecision: result.yearEndDecision },
    });
    return result;
  }
}
