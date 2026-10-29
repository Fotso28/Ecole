import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  appreciation,
  classStatistics,
  formatRank,
  generalAverage,
  periodAverage,
  rankWithTies,
  subjectAverage,
  toMinutes,
} from '@ecole/shared';
import { CouncilDecisionType, Prisma, SubjectGroup } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { verificationCode } from '../../common/crypto';
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
  generatedAt: string;
}

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

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
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { name: true, city: true },
    });

    const [students, enrollments, classSubjects] = await Promise.all([
      this.scope.classStudents(classId),
      this.db.enrollment.findMany({
        where: { classId },
        select: { studentId: true, status: true },
      }),
      this.db.classSubject.findMany({ where: { classId }, include: { subject: true } }),
    ]);
    if (students.length === 0) throw new ConflictException('Aucun élève inscrit dans cette classe');
    const evaluations = await this.db.evaluation.findMany({
      where: {
        classSubjectId: { in: classSubjects.map((c) => c.id) },
        sequenceId: { in: term.sequences.map((s) => s.id) },
        status: { in: ['SUBMITTED', 'LOCKED'] },
      },
      include: { grades: true },
    });
    if (evaluations.length === 0)
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
    type Cell = { seq: (number | null)[]; term: number | null };
    const cell = new Map<string, Cell>();
    for (const s of students) {
      for (const cs of classSubjects) {
        const seq = term.sequences.map((sq) => {
          const evs = evaluations.filter(
            (e) => e.classSubjectId === cs.id && e.sequenceId === sq.id,
          );
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
          generatedAt,
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
          },
        });
        results.push({ studentId: s.id, version, generalAverageCenti: g?.averageCenti ?? null });
      }
      await this.audit.log(
        {
          action: 'reportcards.generated',
          entity: 'Class',
          entityId: classId,
          after: { termId, count: students.length },
        },
        tx,
      );
    });
    return { generated: results.length, results };
  }

  /** Publie les brouillons : ils deviennent définitifs, la version précédente est remplacée. */
  async publish(classId: string, termId: string) {
    const drafts = await this.db.reportCard.findMany({
      where: { classId, termId, status: 'DRAFT' },
    });
    if (drafts.length === 0) throw new ConflictException('Aucun bulletin en brouillon à publier');
    const actorId = staffContext().userId;
    const term = await this.db.term.findUniqueOrThrow({ where: { id: termId } });
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
              template: 'reportCardPublished',
              body: templates.reportCardPublished({
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
          action: 'reportcards.published',
          entity: 'Class',
          entityId: classId,
          after: { termId, count: drafts.length },
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
  ) {
    await this.db.student.findUniqueOrThrow({ where: { id: studentId } });
    await this.db.term.findUniqueOrThrow({ where: { id: termId } });
    const decidedById = staffContext().userId;
    const result = await this.db.councilDecision.upsert({
      where: { studentId_termId: { studentId, termId } },
      create: { schoolId: currentSchoolId(), studentId, termId, decision, comment, decidedById },
      update: { decision, comment, decidedById },
    });
    await this.audit.log({
      action: 'reportcards.decision',
      entity: 'CouncilDecision',
      entityId: result.id,
      after: { decision, comment },
    });
    return result;
  }
}
