import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  assignSeats,
  assignSupervisors,
  examPaperCreateSchema,
  examPublishSchema,
  examResults,
  examRoomAddSchema,
  examScoresSchema,
  examSessionCreateSchema,
  examSupervisionSchema,
  EXAM_KIND_LABELS,
  findExamConflicts,
  formatGrade,
  generateAnonymityCodes,
  isValidAnonymityCode,
  normalizeAnonymityCode,
  SeatingCapacityError,
  slotEndTime,
  supervisionLoad,
  type ExamConflict,
  type ExamPaperSlot,
  type ExamSupervisionSlot,
  type ParsedGrade,
} from '@ecole/shared';
import type { ExamPaper, ExamSession } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { addDays, fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { compactGrade, toParsed, toStored } from '../grades/grades.compute';
import { NotificationsService } from '../notifications/notifications.service';

type SessionInput = z.infer<typeof examSessionCreateSchema>;
type PaperInput = z.infer<typeof examPaperCreateSchema>;

const fullName = (u: { lastName: string; firstName: string }) => `${u.lastName} ${u.firstName}`;

/** Message envoyé aux parents à la publication des résultats. */
const resultsMessage = (p: {
  school: string;
  session: string;
  student: string;
  average: number | null;
}) =>
  `${p.school} : les résultats de « ${p.session} » de ${p.student} sont disponibles${p.average === null ? '' : ` (moyenne ${formatGrade(p.average)}/20)`}. Détails dans l'application.`;

@Injectable()
export class ExamsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async listSessions() {
    const year = await this.scope.currentYear();
    let sessions = await this.db.examSession.findMany({
      where: { academicYearId: year.id },
      include: { _count: { select: { papers: true, candidates: true, rooms: true } } },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    });
    if (this.scope.isClassScoped('exams.read')) {
      const visible = await this.teacherSessionIds();
      sessions = sessions.filter((s) => visible.has(s.id));
    }
    const classes = await this.classNames(sessions.flatMap((s) => s.classIds));
    return sessions.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      kindLabel: EXAM_KIND_LABELS[s.kind],
      startDate: fromDbDate(s.startDate),
      endDate: fromDbDate(s.endDate),
      classes: s.classIds.map((id) => ({ id, name: classes.get(id) ?? '' })),
      papers: s._count.papers,
      candidates: s._count.candidates,
      rooms: s._count.rooms,
      published: !!s.resultsPublishedAt,
    }));
  }

  async createSession(input: SessionInput) {
    const year = await this.scope.currentYear();
    const classes = await this.db.class.findMany({
      where: { id: { in: input.classIds }, academicYearId: year.id },
    });
    if (classes.length !== new Set(input.classIds).size)
      throw new BadRequestException('Classe inconnue pour l’année en cours');
    if (input.sequenceId) {
      const sequence = await this.db.sequence.findUnique({
        where: { id: input.sequenceId },
        include: { term: true },
      });
      if (!sequence || sequence.term.academicYearId !== year.id)
        throw new BadRequestException('Séquence hors de l’année en cours');
    }
    const session = await this.db.examSession.create({
      data: {
        schoolId: currentSchoolId(),
        academicYearId: year.id,
        name: input.name,
        kind: input.kind,
        sequenceId: input.sequenceId ?? null,
        startDate: toDbDate(input.startDate),
        endDate: toDbDate(input.endDate),
        classIds: [...new Set(input.classIds)],
        mixClasses: input.mixClasses,
        supervisorsPerRoom: input.supervisorsPerRoom,
        createdById: staffContext().userId,
      },
    });
    await this.audit.log({
      action: 'exams.session_created',
      entity: 'ExamSession',
      entityId: session.id,
      after: input,
    });
    return session;
  }

  async deleteSession(id: string) {
    const session = await this.session(id);
    this.assertNotPublished(session);
    const scores = await this.db.examScore.count({ where: { paper: { sessionId: id } } });
    if (scores > 0)
      throw new ConflictException(
        'Des notes ont déjà été saisies : la session ne peut plus être supprimée',
      );
    await this.db.examSession.delete({ where: { id } });
    await this.audit.log({
      action: 'exams.session_deleted',
      entity: 'ExamSession',
      entityId: id,
      before: { name: session.name },
    });
    return { ok: true };
  }

  /** Détail d'une session : calendrier, salles, surveillants et conflits. */
  async detail(id: string) {
    const session = await this.session(id);
    if (this.scope.isClassScoped('exams.read')) {
      const visible = await this.teacherSessionIds();
      if (!visible.has(id)) throw new NotFoundException('Session introuvable');
    }
    const [papers, rooms, candidates, sequence] = await Promise.all([
      this.db.examPaper.findMany({
        where: { sessionId: id },
        include: { supervisions: true, _count: { select: { scores: true } } },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
      this.db.examRoom.findMany({ where: { sessionId: id }, orderBy: { order: 'asc' } }),
      this.db.examCandidate.findMany({
        where: { sessionId: id },
        select: { id: true, classId: true, roomId: true, seat: true },
      }),
      session.sequenceId
        ? this.db.sequence.findUnique({
            where: { id: session.sequenceId },
            include: { term: true },
          })
        : Promise.resolve(null),
    ]);
    const [subjects, roomNames, classNames, users, transfers] = await Promise.all([
      this.db.subject.findMany({ where: { id: { in: papers.map((p) => p.subjectId) } } }),
      this.db.room.findMany({ where: { id: { in: rooms.map((r) => r.roomId) } } }),
      this.classNames(session.classIds),
      this.userNames(papers.flatMap((p) => p.supervisions.map((s) => s.userId))),
      this.db.examTransfer.count({ where: { paper: { sessionId: id } } }),
    ]);
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const roomName = new Map(roomNames.map((r) => [r.id, r.name]));
    const conflicts = await this.conflictsFor({ sessionIds: [id] });
    const describe = await this.describeConflicts(conflicts);
    return {
      id: session.id,
      name: session.name,
      kind: session.kind,
      kindLabel: EXAM_KIND_LABELS[session.kind],
      startDate: fromDbDate(session.startDate),
      endDate: fromDbDate(session.endDate),
      mixClasses: session.mixClasses,
      supervisorsPerRoom: session.supervisorsPerRoom,
      sequence: sequence
        ? { id: sequence.id, name: `${sequence.name} · ${sequence.term.name}` }
        : null,
      published: !!session.resultsPublishedAt,
      publishedAt: session.resultsPublishedAt,
      transferred: transfers,
      classes: session.classIds.map((cid) => ({
        id: cid,
        name: classNames.get(cid) ?? '',
        candidates: candidates.filter((c) => c.classId === cid).length,
      })),
      candidates: candidates.length,
      seated: candidates.filter((c) => c.roomId).length,
      rooms: rooms.map((r) => ({
        id: r.roomId,
        name: roomName.get(r.roomId) ?? '',
        capacity: r.capacity,
        seated: candidates.filter((c) => c.roomId === r.roomId).length,
      })),
      papers: papers.map((p) => ({
        id: p.id,
        subjectId: p.subjectId,
        subjectName: subjectName.get(p.subjectId) ?? '',
        date: fromDbDate(p.date),
        startTime: p.startTime,
        endTime: slotEndTime(p),
        durationMinutes: p.durationMinutes,
        maxScore: p.maxScore,
        classes: p.classIds.map((cid) => ({ id: cid, name: classNames.get(cid) ?? '' })),
        scores: p._count.scores,
        expected: candidates.filter((c) => p.classIds.includes(c.classId)).length,
        rooms: rooms
          .filter((r) =>
            candidates.some((c) => c.roomId === r.roomId && p.classIds.includes(c.classId)),
          )
          .map((r) => ({
            id: r.roomId,
            name: roomName.get(r.roomId) ?? '',
            supervisors: p.supervisions
              .filter((s) => s.roomId === r.roomId)
              .map((s) => ({ id: s.id, userId: s.userId, name: users.get(s.userId) ?? '' })),
          })),
      })),
      conflicts: describe,
    };
  }

  // -------------------------------------------------------------------------
  // Calendrier des épreuves
  // -------------------------------------------------------------------------

  async addPaper(sessionId: string, input: PaperInput) {
    const session = await this.session(sessionId);
    this.assertNotPublished(session);
    const date = toDbDate(input.date);
    if (date < session.startDate || date > session.endDate)
      throw new BadRequestException('La date de l’épreuve sort des dates de la session');
    const subject = await this.db.subject.findUnique({ where: { id: input.subjectId } });
    if (!subject) throw new BadRequestException('Matière inconnue');
    const teaching = await this.db.classSubject.findMany({
      where: { subjectId: input.subjectId, classId: { in: session.classIds } },
      select: { classId: true },
    });
    const taught = new Set(teaching.map((t) => t.classId));
    const classIds = input.classIds ?? session.classIds.filter((c) => taught.has(c));
    if (classIds.length === 0)
      throw new BadRequestException('Aucune classe de la session n’étudie cette matière');
    if (classIds.some((c) => !session.classIds.includes(c)))
      throw new BadRequestException('Classe hors de la session');
    return this.db.$transaction(async (tx) => {
      const paper = await tx.examPaper.create({
        data: {
          schoolId: currentSchoolId(),
          sessionId,
          subjectId: input.subjectId,
          date,
          startTime: input.startTime,
          durationMinutes: input.durationMinutes,
          maxScore: input.maxScore,
          classIds,
        },
      });
      await this.assertNoNewConflicts(
        tx,
        { sessionIds: [sessionId] },
        (c) => c.kind !== 'supervisor' && c.ids.includes(paper.id),
      );
      await this.audit.log(
        { action: 'exams.paper_added', entity: 'ExamPaper', entityId: paper.id, after: input },
        tx,
      );
      return paper;
    });
  }

  async deletePaper(id: string) {
    const paper = await this.paper(id);
    const session = await this.session(paper.sessionId);
    this.assertNotPublished(session);
    const scores = await this.db.examScore.count({ where: { paperId: id } });
    if (scores > 0) throw new ConflictException('Des notes ont été saisies pour cette épreuve');
    await this.db.examPaper.delete({ where: { id } });
    await this.audit.log({
      action: 'exams.paper_deleted',
      entity: 'ExamPaper',
      entityId: id,
      before: { subjectId: paper.subjectId, date: fromDbDate(paper.date), start: paper.startTime },
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Salles et places
  // -------------------------------------------------------------------------

  /** Salles de l'établissement (partagées avec l'emploi du temps). */
  rooms() {
    return this.db.room.findMany({ orderBy: { name: 'asc' } });
  }

  async createRoom(input: { name: string; capacity?: number }) {
    const exists = await this.db.room.findFirst({ where: { name: input.name } });
    if (exists) throw new ConflictException('Une salle porte déjà ce nom');
    const room = await this.db.room.create({ data: { schoolId: currentSchoolId(), ...input } });
    await this.audit.log({
      action: 'exams.room_created',
      entity: 'Room',
      entityId: room.id,
      after: input,
    });
    return room;
  }

  async addRoom(sessionId: string, input: z.infer<typeof examRoomAddSchema>) {
    const session = await this.session(sessionId);
    this.assertNotPublished(session);
    const room = await this.db.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw new BadRequestException('Salle inconnue');
    const capacity = input.capacity ?? room.capacity;
    if (!capacity) throw new BadRequestException('Indiquez la capacité de la salle pour l’examen');
    const count = await this.db.examRoom.count({ where: { sessionId } });
    return this.db.$transaction(async (tx) => {
      const added = await tx.examRoom.upsert({
        where: { sessionId_roomId: { sessionId, roomId: room.id } },
        create: { schoolId: currentSchoolId(), sessionId, roomId: room.id, capacity, order: count },
        update: { capacity },
      });
      await this.assertNoNewConflicts(
        tx,
        { sessionIds: [sessionId] },
        (c) => c.kind === 'room' && c.targetId === room.id,
      );
      await this.audit.log(
        { action: 'exams.room_added', entity: 'ExamSession', entityId: sessionId, after: input },
        tx,
      );
      return added;
    });
  }

  async removeRoom(sessionId: string, roomId: string) {
    const session = await this.session(sessionId);
    this.assertNotPublished(session);
    await this.db.$transaction(async (tx) => {
      await tx.examCandidate.updateMany({
        where: { sessionId, roomId },
        data: { roomId: null, seat: null },
      });
      await tx.examSupervision.deleteMany({ where: { roomId, paper: { sessionId } } });
      await tx.examRoom.deleteMany({ where: { sessionId, roomId } });
      await this.audit.log(
        {
          action: 'exams.room_removed',
          entity: 'ExamSession',
          entityId: sessionId,
          after: { roomId },
        },
        tx,
      );
    });
    return { ok: true };
  }

  /**
   * Inscrit les élèves des classes de la session comme candidats (numéro d'anonymat aléatoire,
   * conservé d'une répartition à l'autre), puis les répartit dans les salles.
   */
  async seat(sessionId: string, mixClasses?: boolean) {
    const session = await this.session(sessionId);
    this.assertNotPublished(session);
    const rooms = await this.db.examRoom.findMany({
      where: { sessionId },
      orderBy: { order: 'asc' },
    });
    if (rooms.length === 0) throw new ConflictException('Ajoutez d’abord les salles de la session');
    const mix = mixClasses ?? session.mixClasses;
    return this.db.$transaction(
      async (tx) => {
        const existing = await tx.examCandidate.findMany({ where: { sessionId } });
        const byStudent = new Map(existing.map((c) => [c.studentId, c]));
        const students: { id: string; classId: string; lastName: string; firstName: string }[] = [];
        for (const classId of session.classIds) {
          for (const s of await this.scope.classStudents(classId, tx)) {
            students.push({ id: s.id, classId, lastName: s.lastName, firstName: s.firstName });
          }
        }
        const missing = students.filter((s) => !byStudent.has(s.id));
        const codes = generateAnonymityCodes(
          missing.length,
          (max) => randomInt(0, max),
          existing.map((c) => c.anonymityCode),
        );
        // Libère les places avant de les réattribuer (contrainte d'unicité salle × place).
        await tx.examCandidate.updateMany({
          where: { sessionId },
          data: { roomId: null, seat: null },
        });
        const created = await tx.examCandidate.createManyAndReturn({
          data: missing.map((s, i) => ({
            schoolId: currentSchoolId(),
            sessionId,
            studentId: s.id,
            classId: s.classId,
            anonymityCode: codes[i]!,
          })),
        });
        // Élève parti ou changé de classe : retiré s'il n'a aucune note, sinon conservé.
        const current = new Map(students.map((s) => [s.id, s.classId]));
        for (const c of existing) {
          const classId = current.get(c.studentId);
          if (classId === c.classId) continue;
          const scored = await tx.examScore.count({ where: { candidateId: c.id } });
          if (scored === 0 && !classId) await tx.examCandidate.delete({ where: { id: c.id } });
          else if (scored === 0 && classId)
            await tx.examCandidate.update({ where: { id: c.id }, data: { classId } });
        }
        const all = [...existing.filter((c) => current.has(c.studentId)), ...created];
        const studentInfo = new Map(students.map((s) => [s.id, s]));
        let seats;
        try {
          seats = assignSeats(
            all.map((c) => ({
              id: c.id,
              classId: current.get(c.studentId) ?? c.classId,
              lastName: studentInfo.get(c.studentId)?.lastName ?? '',
              firstName: studentInfo.get(c.studentId)?.firstName ?? '',
            })),
            rooms.map((r) => ({ id: r.roomId, capacity: r.capacity })),
            { mixClasses: mix },
          );
        } catch (e) {
          if (e instanceof SeatingCapacityError)
            throw new ConflictException(
              `Capacité insuffisante : ${e.capacity} places pour ${e.candidates} candidats. Ajoutez une salle.`,
            );
          throw e;
        }
        for (const s of seats) {
          await tx.examCandidate.update({
            where: { id: s.candidateId },
            data: { roomId: s.roomId, seat: s.seat },
          });
        }
        if (mix !== session.mixClasses)
          await tx.examSession.update({ where: { id: sessionId }, data: { mixClasses: mix } });
        await this.audit.log(
          {
            action: 'exams.seating_generated',
            entity: 'ExamSession',
            entityId: sessionId,
            after: { candidates: seats.length, added: created.length, mixClasses: mix },
          },
          tx,
        );
        return { candidates: seats.length, added: created.length };
      },
      { timeout: 60_000 },
    );
  }

  /** Plan de salle : candidats par salle et par place (sans numéro d'anonymat). */
  async seating(sessionId: string) {
    const session = await this.session(sessionId);
    await this.assertCanSeeCandidates(sessionId);
    const [rooms, candidates] = await Promise.all([
      this.db.examRoom.findMany({ where: { sessionId }, orderBy: { order: 'asc' } }),
      this.db.examCandidate.findMany({ where: { sessionId } }),
    ]);
    const [roomNames, students, classNames] = await Promise.all([
      this.db.room.findMany({ where: { id: { in: rooms.map((r) => r.roomId) } } }),
      this.db.student.findMany({
        where: { id: { in: candidates.map((c) => c.studentId) } },
        select: { id: true, firstName: true, lastName: true, matricule: true },
      }),
      this.classNames(session.classIds),
    ]);
    const roomName = new Map(roomNames.map((r) => [r.id, r.name]));
    const student = new Map(students.map((s) => [s.id, s]));
    const present = (c: (typeof candidates)[number]) => {
      const s = student.get(c.studentId);
      return {
        id: c.id,
        seat: c.seat,
        studentId: c.studentId,
        name: s ? fullName(s) : '',
        matricule: s?.matricule ?? '',
        classId: c.classId,
        className: classNames.get(c.classId) ?? '',
      };
    };
    return {
      rooms: rooms.map((r) => ({
        id: r.roomId,
        name: roomName.get(r.roomId) ?? '',
        capacity: r.capacity,
        candidates: candidates
          .filter((c) => c.roomId === r.roomId)
          .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
          .map(present),
      })),
      unseated: candidates.filter((c) => !c.roomId).map(present),
    };
  }

  /** Ajustement manuel : déplace un candidat ; si la place est prise, les deux candidats échangent. */
  async moveCandidate(candidateId: string, roomId: string, seat: number) {
    const candidate = await this.db.examCandidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new NotFoundException('Candidat introuvable');
    const session = await this.session(candidate.sessionId);
    this.assertNotPublished(session);
    const room = await this.db.examRoom.findUnique({
      where: { sessionId_roomId: { sessionId: session.id, roomId } },
    });
    if (!room) throw new BadRequestException('Salle hors de la session');
    if (seat > room.capacity)
      throw new BadRequestException(`La salle compte ${room.capacity} places`);
    return this.db.$transaction(async (tx) => {
      const occupant = await tx.examCandidate.findFirst({
        where: { sessionId: session.id, roomId, seat, id: { not: candidateId } },
      });
      if (occupant) {
        await tx.examCandidate.update({
          where: { id: occupant.id },
          data: { roomId: null, seat: null },
        });
      }
      await tx.examCandidate.update({ where: { id: candidateId }, data: { roomId, seat } });
      if (occupant) {
        await tx.examCandidate.update({
          where: { id: occupant.id },
          data: { roomId: candidate.roomId, seat: candidate.seat },
        });
      }
      await this.audit.log(
        {
          action: 'exams.candidate_moved',
          entity: 'ExamCandidate',
          entityId: candidateId,
          before: { roomId: candidate.roomId, seat: candidate.seat },
          after: { roomId, seat, swappedWith: occupant?.id ?? null },
        },
        tx,
      );
      return { swapped: !!occupant };
    });
  }

  // -------------------------------------------------------------------------
  // Surveillants
  // -------------------------------------------------------------------------

  /** Enseignants actifs et leur charge de surveillance sur l'année (minutes). */
  async staff() {
    const year = await this.scope.currentYear();
    const memberships = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId(), active: true, roles: { has: 'TEACHER' } },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    const supervisions = await this.db.examSupervision.findMany({
      where: { paper: { session: { academicYearId: year.id } } },
      include: { paper: { select: { durationMinutes: true } } },
    });
    const load = supervisionLoad(
      supervisions.map((s) => ({ userId: s.userId, durationMinutes: s.paper.durationMinutes })),
    );
    return memberships
      .map((m) => ({
        id: m.user.id,
        name: fullName(m.user),
        loadMinutes: load.get(m.user.id) ?? 0,
        supervisions: supervisions.filter((s) => s.userId === m.user.id).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  async addSupervision(input: z.infer<typeof examSupervisionSchema>) {
    const paper = await this.paper(input.paperId);
    const session = await this.session(paper.sessionId);
    this.assertNotPublished(session);
    const room = await this.db.examRoom.findUnique({
      where: { sessionId_roomId: { sessionId: session.id, roomId: input.roomId } },
    });
    if (!room) throw new BadRequestException('Salle hors de la session');
    const member = await this.db.membership.findUnique({
      where: { userId_schoolId: { userId: input.userId, schoolId: currentSchoolId() } },
    });
    if (!member?.active) throw new BadRequestException('Membre du personnel inconnu');
    return this.db.$transaction(async (tx) => {
      const existing = await tx.examSupervision.findUnique({
        where: { paperId_roomId_userId: input },
      });
      if (existing) return existing;
      const created = await tx.examSupervision.create({
        data: { schoolId: currentSchoolId(), ...input },
      });
      await this.assertNoNewConflicts(
        tx,
        { userIds: [input.userId], sessionIds: [session.id] },
        (c) => c.kind === 'supervisor' && c.ids.includes(created.id),
      );
      await this.audit.log(
        {
          action: 'exams.supervisor_assigned',
          entity: 'ExamSupervision',
          entityId: created.id,
          after: input,
        },
        tx,
      );
      return created;
    });
  }

  async removeSupervision(id: string) {
    const sup = await this.db.examSupervision.findUnique({
      where: { id },
      include: { paper: true },
    });
    if (!sup) throw new NotFoundException('Surveillance introuvable');
    this.assertNotPublished(await this.session(sup.paper.sessionId));
    await this.db.examSupervision.delete({ where: { id } });
    await this.audit.log({
      action: 'exams.supervisor_removed',
      entity: 'ExamSupervision',
      entityId: id,
      before: { paperId: sup.paperId, roomId: sup.roomId, userId: sup.userId },
    });
    return { ok: true };
  }

  /**
   * Affectation automatique : pour chaque épreuve et chaque salle occupée par ses candidats,
   * complète le nombre de surveillants voulu en équilibrant la charge des enseignants.
   */
  async autoAssignSupervisors(sessionId: string) {
    const session = await this.session(sessionId);
    this.assertNotPublished(session);
    const [papers, candidates] = await Promise.all([
      this.db.examPaper.findMany({ where: { sessionId }, include: { supervisions: true } }),
      this.db.examCandidate.findMany({
        where: { sessionId, roomId: { not: null } },
        select: { classId: true, roomId: true },
      }),
    ]);
    if (candidates.length === 0)
      throw new ConflictException('Répartissez d’abord les candidats dans les salles');
    const pool = (await this.staff()).map((s) => s.id);
    const teachers = await this.db.classSubject.findMany({
      where: { classId: { in: session.classIds }, teacherId: { not: null } },
      select: { classId: true, subjectId: true, teacherId: true },
    });
    const needs = papers.flatMap((p) => {
      const rooms = [
        ...new Set(candidates.filter((c) => p.classIds.includes(c.classId)).map((c) => c.roomId!)),
      ];
      return rooms.map((roomId) => ({
        key: `${p.id}|${roomId}`,
        paperId: p.id,
        roomId,
        sessionId,
        date: fromDbDate(p.date),
        startTime: p.startTime,
        durationMinutes: p.durationMinutes,
        needed: session.supervisorsPerRoom,
        assigned: p.supervisions.filter((s) => s.roomId === roomId).map((s) => s.userId),
        avoid: teachers
          .filter((t) => t.subjectId === p.subjectId && p.classIds.includes(t.classId))
          .map((t) => t.teacherId!),
      }));
    });
    const needKeys = new Set(needs.map((n) => n.key));
    const others = await this.db.examSupervision.findMany({
      where: { paper: { session: { academicYearId: session.academicYearId } } },
      include: { paper: true },
    });
    const existing = others
      .filter((s) => !needKeys.has(`${s.paperId}|${s.roomId}`))
      .map((s) => ({
        userId: s.userId,
        roomId: s.roomId,
        sessionId: s.paper.sessionId,
        date: fromDbDate(s.paper.date),
        startTime: s.paper.startTime,
        durationMinutes: s.paper.durationMinutes,
      }));
    const { assignments, unfilled } = assignSupervisors(needs, pool, existing);
    await this.db.$transaction(async (tx) => {
      await tx.examSupervision.createMany({
        data: assignments.map((a) => {
          const [paperId, roomId] = a.key.split('|') as [string, string];
          return { schoolId: currentSchoolId(), paperId, roomId, userId: a.userId };
        }),
        skipDuplicates: true,
      });
      await this.audit.log(
        {
          action: 'exams.supervisors_auto_assigned',
          entity: 'ExamSession',
          entityId: sessionId,
          after: { assigned: assignments.length, unfilled: unfilled.length },
        },
        tx,
      );
    });
    return {
      assigned: assignments.length,
      unfilled: unfilled.reduce((n, u) => n + u.missing, 0),
    };
  }

  /** Surveillances de l'utilisateur connecté, à partir d'aujourd'hui. */
  async mySupervisions() {
    const userId = staffContext().userId;
    const today = todayInCameroon();
    const rows = await this.db.examSupervision.findMany({
      where: { userId, paper: { date: { gte: toDbDate(today) } } },
      include: { paper: { include: { session: true } } },
      orderBy: [{ paper: { date: 'asc' } }, { paper: { startTime: 'asc' } }],
      take: 30,
    });
    const [subjects, rooms] = await Promise.all([
      this.db.subject.findMany({ where: { id: { in: rows.map((r) => r.paper.subjectId) } } }),
      this.db.room.findMany({ where: { id: { in: rows.map((r) => r.roomId) } } }),
    ]);
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const roomName = new Map(rooms.map((r) => [r.id, r.name]));
    return {
      today,
      supervisions: rows.map((r) => ({
        id: r.id,
        sessionId: r.paper.sessionId,
        sessionName: r.paper.session.name,
        paperId: r.paperId,
        subjectName: subjectName.get(r.paper.subjectId) ?? '',
        date: fromDbDate(r.paper.date),
        startTime: r.paper.startTime,
        endTime: slotEndTime(r.paper),
        roomId: r.roomId,
        roomName: roomName.get(r.roomId) ?? '',
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Anonymat
  // -------------------------------------------------------------------------

  /** Levée de l'anonymat : réservée à la direction et au censeur, toujours journalisée. */
  async revealAnonymity(sessionId: string, reason: string) {
    const session = await this.session(sessionId);
    const candidates = await this.db.examCandidate.findMany({ where: { sessionId } });
    const [students, classNames] = await Promise.all([
      this.db.student.findMany({
        where: { id: { in: candidates.map((c) => c.studentId) } },
        select: { id: true, firstName: true, lastName: true, matricule: true },
      }),
      this.classNames(session.classIds),
    ]);
    const student = new Map(students.map((s) => [s.id, s]));
    await this.audit.log({
      action: 'exams.anonymity_revealed',
      entity: 'ExamSession',
      entityId: sessionId,
      reason,
      after: { candidates: candidates.length },
    });
    return candidates
      .map((c) => {
        const s = student.get(c.studentId);
        return {
          code: c.anonymityCode,
          name: s ? fullName(s) : '',
          matricule: s?.matricule ?? '',
          className: classNames.get(c.classId) ?? '',
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  // -------------------------------------------------------------------------
  // Saisie des notes par numéro d'anonymat
  // -------------------------------------------------------------------------

  /** Épreuves que l'utilisateur peut noter (toutes pour le censeur, ses matières pour un enseignant). */
  async gradingPapers() {
    const year = await this.scope.currentYear();
    const papers = await this.db.examPaper.findMany({
      where: { session: { academicYearId: year.id } },
      include: { session: true, _count: { select: { scores: true } } },
      orderBy: [{ date: 'desc' }, { startTime: 'asc' }],
    });
    const allowed = await this.gradableFilter();
    const visible = papers.filter((p) => allowed(p));
    const [subjects, candidates] = await Promise.all([
      this.db.subject.findMany({ where: { id: { in: visible.map((p) => p.subjectId) } } }),
      this.db.examCandidate.groupBy({
        by: ['sessionId', 'classId'],
        where: { sessionId: { in: visible.map((p) => p.sessionId) } },
        _count: { _all: true },
      }),
    ]);
    const classNames = await this.classNames(visible.flatMap((p) => p.classIds));
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    return visible.map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      sessionName: p.session.name,
      subjectName: subjectName.get(p.subjectId) ?? '',
      date: fromDbDate(p.date),
      startTime: p.startTime,
      maxScore: p.maxScore,
      classes: p.classIds.map((c) => classNames.get(c) ?? '').join(', '),
      scores: p._count.scores,
      expected: candidates
        .filter((c) => c.sessionId === p.sessionId && p.classIds.includes(c.classId))
        .reduce((n, c) => n + c._count._all, 0),
      published: !!p.session.resultsPublishedAt,
    }));
  }

  /** Grille anonyme d'une épreuve : numéros et notes, sans nom ni classe ni place. */
  async paperScores(paperId: string) {
    const paper = await this.gradablePaper(paperId);
    const [candidates, scores, subject] = await Promise.all([
      this.db.examCandidate.findMany({
        where: { sessionId: paper.sessionId, classId: { in: paper.classIds } },
        select: { id: true, anonymityCode: true },
      }),
      this.db.examScore.findMany({ where: { paperId } }),
      this.db.subject.findUnique({ where: { id: paper.subjectId } }),
    ]);
    const byCandidate = new Map(scores.map((s) => [s.candidateId, s]));
    return {
      paper: {
        id: paper.id,
        sessionName: paper.session.name,
        subjectName: subject?.name ?? '',
        date: fromDbDate(paper.date),
        startTime: paper.startTime,
        maxScore: paper.maxScore,
        published: !!paper.session.resultsPublishedAt,
      },
      rows: candidates
        .map((c) => ({ code: c.anonymityCode, value: compactGrade(byCandidate.get(c.id)) }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    };
  }

  async saveScores(paperId: string, rows: z.infer<typeof examScoresSchema>['scores']) {
    const paper = await this.gradablePaper(paperId);
    if (paper.session.resultsPublishedAt)
      throw new ConflictException('Résultats publiés : les notes ne peuvent plus être modifiées');
    const candidates = await this.db.examCandidate.findMany({
      where: { sessionId: paper.sessionId, classId: { in: paper.classIds } },
      select: { id: true, anonymityCode: true },
    });
    const byCode = new Map(candidates.map((c) => [c.anonymityCode, c.id]));
    const errors: { code: string; message: string }[] = [];
    const parsed = rows.map((r) => {
      const code = normalizeAnonymityCode(r.code);
      const candidateId = byCode.get(code);
      if (!isValidAnonymityCode(code))
        errors.push({ code: r.code, message: 'Numéro d’anonymat invalide : vérifiez la saisie' });
      else if (!candidateId)
        errors.push({ code: r.code, message: 'Numéro inconnu pour cette épreuve' });
      const stored = toStored(r.value, paper.maxScore);
      if (stored === 'invalid')
        errors.push({
          code: r.code,
          message: `Note invalide : entre 0 et ${paper.maxScore}, deux décimales au plus`,
        });
      return { code, candidateId, stored };
    });
    if (errors.length > 0) throw new BadRequestException({ message: 'Notes invalides', errors });
    const ctx = staffContext();
    const before = await this.db.examScore.findMany({ where: { paperId } });
    const beforeBy = new Map(before.map((s) => [s.candidateId, s]));
    const changes: { code: string; before: string; after: string }[] = [];
    await this.db.$transaction(async (tx) => {
      for (const p of parsed) {
        if (!p.candidateId || p.stored === 'invalid') continue;
        const prev = beforeBy.get(p.candidateId);
        if (p.stored === null) {
          if (prev) {
            await tx.examScore.delete({ where: { id: prev.id } });
            changes.push({ code: p.code, before: compactGrade(prev), after: '' });
          }
          continue;
        }
        if (prev && prev.status === p.stored.status && prev.valueCenti === p.stored.valueCenti)
          continue;
        await tx.examScore.upsert({
          where: { paperId_candidateId: { paperId, candidateId: p.candidateId } },
          create: {
            schoolId: currentSchoolId(),
            paperId,
            candidateId: p.candidateId,
            ...p.stored,
            updatedById: ctx.userId,
          },
          update: { ...p.stored, updatedById: ctx.userId },
        });
        changes.push({ code: p.code, before: compactGrade(prev), after: compactGrade(p.stored) });
      }
      if (changes.length > 0)
        await this.audit.log(
          {
            action: 'exams.scores_updated',
            entity: 'ExamPaper',
            entityId: paperId,
            after: { changes },
          },
          tx,
        );
    });
    return { saved: changes.length };
  }

  // -------------------------------------------------------------------------
  // Résultats et publication
  // -------------------------------------------------------------------------

  private async compute(session: ExamSession) {
    const [papers, candidates, coefficients] = await Promise.all([
      this.db.examPaper.findMany({
        where: { sessionId: session.id },
        include: { scores: true },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
      this.db.examCandidate.findMany({ where: { sessionId: session.id } }),
      this.db.classSubject.findMany({
        where: { classId: { in: session.classIds } },
        select: { classId: true, subjectId: true, coefficient: true },
      }),
    ]);
    const grades = new Map<string, ParsedGrade>();
    for (const p of papers)
      for (const s of p.scores) grades.set(`${p.id}:${s.candidateId}`, toParsed(s));
    const coef = new Map(coefficients.map((c) => [`${c.classId}:${c.subjectId}`, c.coefficient]));
    const results = examResults(
      candidates.map((c) => ({ id: c.id, classId: c.classId })),
      papers,
      grades,
      (classId, subjectId) => coef.get(`${classId}:${subjectId}`),
    );
    return { papers, candidates, results };
  }

  /**
   * Résultats d'une session. Avant publication, les candidats ne sont désignés que par leur numéro
   * d'anonymat ; les noms apparaissent une fois les résultats publiés.
   */
  async results(sessionId: string) {
    const session = await this.session(sessionId);
    const published = !!session.resultsPublishedAt;
    const { papers, candidates, results } = await this.compute(session);
    const scoped = this.scope.isClassScoped('exams.read');
    const teacherClasses = scoped ? new Set(await this.scope.teacherClassIds()) : null;
    if (scoped && !published) throw new ForbiddenException('Résultats non publiés');
    const [subjects, students, classNames] = await Promise.all([
      this.db.subject.findMany({ where: { id: { in: papers.map((p) => p.subjectId) } } }),
      published
        ? this.db.student.findMany({
            where: { id: { in: candidates.map((c) => c.studentId) } },
            select: { id: true, firstName: true, lastName: true, matricule: true },
          })
        : Promise.resolve([]),
      this.classNames(session.classIds),
    ]);
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const student = new Map(students.map((s) => [s.id, s]));
    const candidateById = new Map(candidates.map((c) => [c.id, c]));
    const rows = results
      .map((r) => {
        const c = candidateById.get(r.candidateId)!;
        const s = student.get(c.studentId);
        return {
          // Avant publication, l'identifiant du candidat (repris par la liste des salles avec le
          // nom) permettrait de rattacher chaque numéro à un élève sans lever l'anonymat.
          candidateId: published ? c.id : null,
          code: published ? null : c.anonymityCode,
          name: s ? fullName(s) : null,
          matricule: s?.matricule ?? null,
          classId: c.classId,
          className: classNames.get(c.classId) ?? '',
          averageCenti: r.averageCenti,
          incomplete: r.incomplete,
          rank: r.rank?.label ?? null,
          appreciation: r.appreciation,
          scores: r.papers.map((p) => ({
            paperId: p.paperId,
            value: compactGrade(
              p.grade.kind === 'score'
                ? { status: 'SCORE', valueCenti: p.grade.centi }
                : p.grade.kind === 'absent'
                  ? { status: 'ABSENT', valueCenti: null }
                  : p.grade.kind === 'exempt'
                    ? { status: 'EXEMPT', valueCenti: null }
                    : undefined,
            ),
          })),
        };
      })
      .filter((r) => !teacherClasses || teacherClasses.has(r.classId))
      .sort(
        (a, b) =>
          a.className.localeCompare(b.className, 'fr') ||
          (b.averageCenti ?? -1) - (a.averageCenti ?? -1) ||
          (a.name ?? a.code ?? '').localeCompare(b.name ?? b.code ?? '', 'fr'),
      );
    return {
      published,
      papers: papers.map((p) => ({
        id: p.id,
        subjectName: subjectName.get(p.subjectId) ?? '',
        maxScore: p.maxScore,
        classIds: p.classIds,
      })),
      missing: results.filter((r) => r.incomplete).length,
      rows,
    };
  }

  /** Publication : toutes les notes doivent être saisies ; les parents sont prévenus par SMS. */
  async publish(sessionId: string, input: z.infer<typeof examPublishSchema>) {
    const session = await this.session(sessionId);
    this.assertNotPublished(session);
    const { papers, candidates, results } = await this.compute(session);
    if (papers.length === 0) throw new ConflictException('Aucune épreuve dans cette session');
    if (candidates.length === 0) throw new ConflictException('Aucun candidat dans cette session');
    const missing = results.filter((r) => r.incomplete).length;
    if (missing > 0)
      throw new ConflictException(
        `Notes manquantes pour ${missing} candidat(s) : saisissez « abs » pour un absent`,
      );
    if (input.transferToSequence && !session.sequenceId)
      throw new BadRequestException('Cette session n’est rattachée à aucune séquence');
    const school = await this.db.school.findUniqueOrThrow({ where: { id: currentSchoolId() } });
    const average = new Map(results.map((r) => [r.candidateId, r.averageCenti]));
    await this.db.$transaction(
      async (tx) => {
        const updated = await tx.examSession.updateMany({
          where: { id: sessionId, resultsPublishedAt: null },
          data: { resultsPublishedAt: new Date(), publishedById: staffContext().userId },
        });
        if (updated.count === 0) throw new ConflictException('Résultats déjà publiés');
        const students = await tx.student.findMany({
          where: { id: { in: candidates.map((c) => c.studentId) } },
          include: {
            guardians: { include: { guardian: true }, orderBy: { isPrimary: 'desc' } },
          },
        });
        const candidateOf = new Map(candidates.map((c) => [c.studentId, c.id]));
        for (const s of students) {
          const phone = s.guardians[0]?.guardian.phone;
          if (!phone) continue;
          await this.notifications.enqueue(
            {
              schoolId: school.id,
              recipient: phone,
              template: 'examResultsPublished',
              body: resultsMessage({
                school: school.name,
                session: session.name,
                student: s.firstName,
                average: average.get(candidateOf.get(s.id) ?? '') ?? null,
              }),
              payload: { sessionId, studentId: s.id },
            },
            tx,
          );
        }
        await this.audit.log(
          {
            action: 'exams.results_published',
            entity: 'ExamSession',
            entityId: sessionId,
            after: { candidates: candidates.length, transferToSequence: input.transferToSequence },
          },
          tx,
        );
      },
      { timeout: 60_000 },
    );
    const transfer = input.transferToSequence ? await this.transfer(sessionId, input.weight) : null;
    return { published: true, transfer };
  }

  /**
   * Report des notes dans la grille de la séquence : une évaluation « Examen » par épreuve et par
   * classe, créée en brouillon pour suivre le circuit habituel (soumission puis validation).
   * Une grille déjà soumise ou validée n'est pas modifiée.
   */
  async transfer(sessionId: string, weight: number) {
    const session = await this.session(sessionId);
    if (!session.resultsPublishedAt) throw new ConflictException('Publiez d’abord les résultats');
    if (!session.sequenceId)
      throw new BadRequestException('Cette session n’est rattachée à aucune séquence');
    const sequenceId = session.sequenceId;
    const [papers, candidates, subjects, classNames] = await Promise.all([
      this.db.examPaper.findMany({
        where: { sessionId },
        include: { scores: true, transfers: true },
      }),
      this.db.examCandidate.findMany({ where: { sessionId } }),
      this.db.subject.findMany(),
      this.classNames(session.classIds),
    ]);
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const created: { className: string; subjectName: string }[] = [];
    const skipped: { className: string; subjectName: string; reason: string }[] = [];
    const userId = staffContext().userId;
    for (const paper of papers) {
      for (const classId of paper.classIds) {
        const label = {
          className: classNames.get(classId) ?? '',
          subjectName: subjectName.get(paper.subjectId) ?? '',
        };
        if (paper.transfers.some((t) => t.classId === classId)) {
          skipped.push({ ...label, reason: 'Déjà reporté' });
          continue;
        }
        const cs = await this.db.classSubject.findUnique({
          where: { classId_subjectId: { classId, subjectId: paper.subjectId } },
        });
        if (!cs) {
          skipped.push({ ...label, reason: 'Matière non enseignée dans la classe' });
          continue;
        }
        const locked = await this.db.evaluation.count({
          where: { classSubjectId: cs.id, sequenceId, status: { not: 'DRAFT' } },
        });
        if (locked > 0) {
          skipped.push({ ...label, reason: 'Grille de la séquence déjà soumise' });
          continue;
        }
        const enrolled = new Set((await this.scope.classStudents(classId)).map((s) => s.id));
        await this.db.$transaction(async (tx) => {
          const evaluation = await tx.evaluation.create({
            data: {
              schoolId: currentSchoolId(),
              classSubjectId: cs.id,
              sequenceId,
              name: session.name.slice(0, 60),
              type: 'EXAM',
              weight,
              maxScore: paper.maxScore,
              date: paper.date,
              createdById: userId,
            },
          });
          const grades = candidates
            .filter((c) => c.classId === classId && enrolled.has(c.studentId))
            .flatMap((c) => {
              const s = paper.scores.find((x) => x.candidateId === c.id);
              return s
                ? [
                    {
                      schoolId: currentSchoolId(),
                      evaluationId: evaluation.id,
                      studentId: c.studentId,
                      status: s.status,
                      valueCenti: s.valueCenti,
                      updatedById: userId,
                    },
                  ]
                : [];
            });
          await tx.grade.createMany({ data: grades });
          await tx.examTransfer.create({
            data: {
              schoolId: currentSchoolId(),
              paperId: paper.id,
              classId,
              evaluationId: evaluation.id,
            },
          });
          await this.audit.log(
            {
              action: 'exams.transferred_to_sequence',
              entity: 'Evaluation',
              entityId: evaluation.id,
              after: { sessionId, paperId: paper.id, classId, grades: grades.length, weight },
            },
            tx,
          );
        });
        created.push(label);
      }
    }
    return { created, skipped };
  }

  // -------------------------------------------------------------------------
  // Portail parent
  // -------------------------------------------------------------------------

  /** Résultats publiés d'un élève (appelé avec les droits système limités à son école). */
  async studentResults(studentId: string) {
    const entries = await this.db.examCandidate.findMany({
      where: { studentId, session: { resultsPublishedAt: { not: null } } },
      include: { session: true },
      orderBy: { session: { startDate: 'desc' } },
    });
    const out = [];
    for (const entry of entries) {
      const { papers, results } = await this.compute(entry.session);
      const mine = results.find((r) => r.candidateId === entry.id);
      if (!mine) continue;
      const subjects = await this.db.subject.findMany({
        where: { id: { in: papers.map((p) => p.subjectId) } },
      });
      const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
      const paperById = new Map(papers.map((p) => [p.id, p]));
      out.push({
        sessionId: entry.sessionId,
        name: entry.session.name,
        kindLabel: EXAM_KIND_LABELS[entry.session.kind],
        publishedAt: entry.session.resultsPublishedAt,
        averageCenti: mine.averageCenti,
        rank: mine.rank ? `${mine.rank.label}/${mine.rank.ranked}` : null,
        appreciation: mine.appreciation,
        papers: mine.papers.map((p) => {
          const paper = paperById.get(p.paperId)!;
          return {
            paperId: p.paperId,
            subjectName: subjectName.get(paper.subjectId) ?? '',
            maxScore: paper.maxScore,
            value:
              p.grade.kind === 'score'
                ? formatGrade(p.grade.centi)
                : p.grade.kind === 'absent'
                  ? 'Absent'
                  : p.grade.kind === 'exempt'
                    ? 'Dispensé'
                    : '—',
          };
        }),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Données pour les PDF
  // -------------------------------------------------------------------------

  /** Convocations : un élève, une classe ou toute la session. */
  async convocations(sessionId: string, filter: { classId?: string; studentId?: string }) {
    const session = await this.session(sessionId);
    if (this.scope.isClassScoped('exams.read'))
      throw new ForbiddenException('Convocations réservées à l’administration');
    const [school, papers, candidates, rooms, classNames] = await Promise.all([
      this.db.school.findUniqueOrThrow({ where: { id: currentSchoolId() } }),
      this.db.examPaper.findMany({
        where: { sessionId },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
      this.db.examCandidate.findMany({
        where: { sessionId, classId: filter.classId, studentId: filter.studentId },
      }),
      this.db.examRoom.findMany({ where: { sessionId } }),
      this.classNames(session.classIds),
    ]);
    if (candidates.length === 0)
      throw new NotFoundException('Aucun candidat : répartissez d’abord les candidats');
    const [subjects, roomNames, students, year] = await Promise.all([
      this.db.subject.findMany({ where: { id: { in: papers.map((p) => p.subjectId) } } }),
      this.db.room.findMany({ where: { id: { in: rooms.map((r) => r.roomId) } } }),
      this.db.student.findMany({
        where: { id: { in: candidates.map((c) => c.studentId) } },
        select: { id: true, firstName: true, lastName: true, matricule: true, birthDate: true },
      }),
      this.db.academicYear.findUniqueOrThrow({ where: { id: session.academicYearId } }),
    ]);
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const roomName = new Map(roomNames.map((r) => [r.id, r.name]));
    const student = new Map(students.map((s) => [s.id, s]));
    const items = candidates
      .map((c) => {
        const s = student.get(c.studentId)!;
        return {
          name: fullName(s),
          matricule: s.matricule,
          birthDate: fromDbDate(s.birthDate),
          className: classNames.get(c.classId) ?? '',
          room: c.roomId ? (roomName.get(c.roomId) ?? '') : '',
          seat: c.seat,
          papers: papers
            .filter((p) => p.classIds.includes(c.classId))
            .map((p) => ({
              date: fromDbDate(p.date),
              startTime: p.startTime,
              endTime: slotEndTime(p),
              durationMinutes: p.durationMinutes,
              subject: subjectName.get(p.subjectId) ?? '',
            })),
        };
      })
      .sort(
        (a, b) =>
          a.className.localeCompare(b.className, 'fr') || a.name.localeCompare(b.name, 'fr'),
      );
    await this.audit.log({
      action: 'exams.convocations_printed',
      entity: 'ExamSession',
      entityId: sessionId,
      after: { count: items.length, ...filter },
    });
    return {
      school: { name: school.name, city: school.city },
      year: year.name,
      session: { name: session.name, kindLabel: EXAM_KIND_LABELS[session.kind] },
      items,
    };
  }

  /** Listes d'émargement d'une épreuve : une par salle (ou la salle demandée). */
  async attendanceSheets(sessionId: string, paperId: string, roomId?: string) {
    const session = await this.session(sessionId);
    const paper = await this.paper(paperId);
    if (paper.sessionId !== sessionId) throw new NotFoundException('Épreuve introuvable');
    if (this.scope.isClassScoped('exams.read')) {
      const own = await this.db.examSupervision.count({
        where: { paperId, userId: staffContext().userId, ...(roomId ? { roomId } : {}) },
      });
      if (own === 0 || !roomId)
        throw new ForbiddenException('Réservé aux surveillants de cette salle');
    }
    const [school, rooms, candidates, subject, supervisions, classNames] = await Promise.all([
      this.db.school.findUniqueOrThrow({ where: { id: currentSchoolId() } }),
      this.db.examRoom.findMany({
        where: { sessionId, ...(roomId ? { roomId } : {}) },
        orderBy: { order: 'asc' },
      }),
      this.db.examCandidate.findMany({
        where: { sessionId, classId: { in: paper.classIds }, roomId: roomId ?? { not: null } },
        orderBy: { seat: 'asc' },
      }),
      this.db.subject.findUnique({ where: { id: paper.subjectId } }),
      this.db.examSupervision.findMany({ where: { paperId } }),
      this.classNames(session.classIds),
    ]);
    const [roomNames, students, users] = await Promise.all([
      this.db.room.findMany({ where: { id: { in: rooms.map((r) => r.roomId) } } }),
      this.db.student.findMany({
        where: { id: { in: candidates.map((c) => c.studentId) } },
        select: { id: true, firstName: true, lastName: true, matricule: true },
      }),
      this.userNames(supervisions.map((s) => s.userId)),
    ]);
    const roomName = new Map(roomNames.map((r) => [r.id, r.name]));
    const student = new Map(students.map((s) => [s.id, s]));
    return {
      school: { name: school.name, city: school.city },
      session: session.name,
      paper: {
        subject: subject?.name ?? '',
        date: fromDbDate(paper.date),
        startTime: paper.startTime,
        endTime: slotEndTime(paper),
      },
      rooms: rooms
        .map((r) => ({
          name: roomName.get(r.roomId) ?? '',
          supervisors: supervisions
            .filter((s) => s.roomId === r.roomId)
            .map((s) => users.get(s.userId) ?? ''),
          candidates: candidates
            .filter((c) => c.roomId === r.roomId)
            .map((c) => {
              const s = student.get(c.studentId);
              return {
                seat: c.seat,
                name: s ? fullName(s) : '',
                matricule: s?.matricule ?? '',
                className: classNames.get(c.classId) ?? '',
              };
            }),
        }))
        .filter((r) => r.candidates.length > 0),
    };
  }

  // -------------------------------------------------------------------------
  // Outils internes
  // -------------------------------------------------------------------------

  private async session(id: string) {
    const session = await this.db.examSession.findUnique({ where: { id } });
    if (!session) throw new NotFoundException('Session introuvable');
    return session;
  }

  private async paper(id: string) {
    const paper = await this.db.examPaper.findUnique({ where: { id } });
    if (!paper) throw new NotFoundException('Épreuve introuvable');
    return paper;
  }

  private assertNotPublished(session: ExamSession) {
    if (session.resultsPublishedAt)
      throw new ConflictException('Résultats publiés : la session est figée');
  }

  private async classNames(ids: readonly string[]) {
    const classes = await this.db.class.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(classes.map((c) => [c.id, c.name]));
  }

  private async userNames(ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map<string, string>();
    // Seuls les membres de l'établissement courant sont nommés.
    const members = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId(), userId: { in: unique } },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    return new Map(members.map((m) => [m.user.id, fullName(m.user)]));
  }

  /** Sessions visibles d'un enseignant : il y surveille ou y enseigne une matière évaluée. */
  private async teacherSessionIds(): Promise<Set<string>> {
    const userId = staffContext().userId;
    const year = await this.scope.currentYear();
    const [supervised, papers] = await Promise.all([
      this.db.examSupervision.findMany({
        where: { userId },
        select: { paper: { select: { sessionId: true } } },
      }),
      this.db.examPaper.findMany({ where: { session: { academicYearId: year.id } } }),
    ]);
    const allowed = await this.gradableFilter();
    return new Set([
      ...supervised.map((s) => s.paper.sessionId),
      ...papers.filter((p) => allowed(p)).map((p) => p.sessionId),
    ]);
  }

  /** Filtre des épreuves qu'un enseignant peut noter : sa matière dans l'une des classes. */
  private async gradableFilter() {
    if (!this.scope.isClassScoped('exams.grade')) return () => true;
    const mine = await this.db.classSubject.findMany({
      where: { teacherId: staffContext().userId },
      select: { classId: true, subjectId: true },
    });
    const keys = new Set(mine.map((m) => `${m.classId}:${m.subjectId}`));
    return (p: ExamPaper) => p.classIds.some((c) => keys.has(`${c}:${p.subjectId}`));
  }

  private async gradablePaper(paperId: string) {
    const paper = await this.db.examPaper.findUnique({
      where: { id: paperId },
      include: { session: true },
    });
    if (!paper) throw new NotFoundException('Épreuve introuvable');
    const allowed = await this.gradableFilter();
    if (!allowed(paper))
      throw new ForbiddenException('Vous n’enseignez pas cette matière dans ces classes');
    return paper;
  }

  /** Un enseignant ne voit les listes nominatives que des sessions qu'il surveille. */
  private async assertCanSeeCandidates(sessionId: string) {
    if (!this.scope.isClassScoped('exams.read')) return;
    const own = await this.db.examSupervision.count({
      where: { userId: staffContext().userId, paper: { sessionId } },
    });
    if (own === 0) throw new ForbiddenException('Réservé aux surveillants de cette session');
  }

  /** Épreuves (avec salles occupées) et surveillances autour des dates concernées. */
  private async loadSlots(tx: Tx | Db, scope: { sessionIds?: string[]; userIds?: string[] }) {
    const seed = await tx.examPaper.findMany({
      where: {
        OR: [
          ...(scope.sessionIds ? [{ sessionId: { in: scope.sessionIds } }] : []),
          ...(scope.userIds ? [{ supervisions: { some: { userId: { in: scope.userIds } } } }] : []),
        ],
      },
      select: { date: true },
    });
    const dates = [...new Set(seed.map((p) => fromDbDate(p.date)))];
    if (dates.length === 0)
      return { papers: [] as ExamPaperSlot[], supervisions: [] as ExamSupervisionSlot[] };
    const range = dates.flatMap((d) => [addDays(d, -1), d, addDays(d, 1)]).map(toDbDate);
    const papers = await tx.examPaper.findMany({
      where: { date: { in: range } },
      include: { supervisions: true, session: { include: { rooms: true } } },
    });
    return {
      papers: papers.map((p) => ({
        id: p.id,
        sessionId: p.sessionId,
        date: fromDbDate(p.date),
        startTime: p.startTime,
        durationMinutes: p.durationMinutes,
        classIds: p.classIds,
        roomIds: p.session.rooms.map((r) => r.roomId),
      })),
      supervisions: papers.flatMap((p) =>
        p.supervisions.map((s) => ({
          id: s.id,
          paperId: s.paperId,
          roomId: s.roomId,
          userId: s.userId,
        })),
      ),
    };
  }

  private async conflictsFor(scope: { sessionIds?: string[]; userIds?: string[] }, tx?: Tx) {
    const { papers, supervisions } = await this.loadSlots(tx ?? this.db, scope);
    const sessionPapers = new Set(
      papers.filter((p) => scope.sessionIds?.includes(p.sessionId)).map((p) => p.id),
    );
    const sessionSups = new Set(
      supervisions.filter((s) => sessionPapers.has(s.paperId)).map((s) => s.id),
    );
    return findExamConflicts(papers, supervisions).filter((c) =>
      c.kind === 'supervisor'
        ? c.ids.some((x) => sessionSups.has(x))
        : c.ids.some((x) => sessionPapers.has(x)),
    );
  }

  private async assertNoNewConflicts(
    tx: Tx,
    scope: { sessionIds?: string[]; userIds?: string[] },
    isNew: (c: ExamConflict) => boolean,
  ) {
    const conflicts = (await this.conflictsFor(scope, tx)).filter(isNew);
    if (conflicts.length === 0) return;
    const described = await this.describeConflicts(conflicts, tx);
    throw new ConflictException({
      statusCode: 409,
      message: `Conflit : ${described.map((d) => d.message).join(' ; ')}`,
      conflicts: described,
    });
  }

  /** Conflits en clair : « La classe 4e A compose déjà Français le 16/11 à 08:00 ». */
  private async describeConflicts(conflicts: readonly ExamConflict[], tx?: Tx) {
    if (conflicts.length === 0) return [];
    const db = tx ?? this.db;
    const paperIds = new Set<string>();
    const supIds = new Set<string>();
    for (const c of conflicts)
      for (const x of c.ids) (c.kind === 'supervisor' ? supIds : paperIds).add(x);
    const sups = await db.examSupervision.findMany({ where: { id: { in: [...supIds] } } });
    for (const s of sups) paperIds.add(s.paperId);
    const papers = await db.examPaper.findMany({
      where: { id: { in: [...paperIds] } },
      include: { session: true },
    });
    const [subjects, classes, rooms, users] = await Promise.all([
      db.subject.findMany({ where: { id: { in: papers.map((p) => p.subjectId) } } }),
      db.class.findMany({
        where: { id: { in: conflicts.filter((c) => c.kind === 'class').map((c) => c.targetId) } },
      }),
      db.room.findMany({
        where: {
          id: {
            in: [
              ...conflicts.filter((c) => c.kind !== 'class').map((c) => c.targetId),
              ...sups.map((s) => s.roomId),
            ],
          },
        },
      }),
      this.userNames(sups.map((s) => s.userId)),
    ]);
    const paper = new Map(papers.map((p) => [p.id, p]));
    const subject = new Map(subjects.map((s) => [s.id, s.name]));
    const label = (id: string) => {
      const p = paper.get(id);
      if (!p) return '';
      const d = fromDbDate(p.date).split('-').reverse().slice(0, 2).join('/');
      return `${subject.get(p.subjectId) ?? ''} (${p.session.name}, ${d} à ${p.startTime})`;
    };
    return conflicts.map((c) => {
      if (c.kind === 'class') {
        const name = classes.find((x) => x.id === c.targetId)?.name ?? '';
        return {
          kind: c.kind,
          message: `la classe ${name} compose ${label(c.ids[0])} et ${label(c.ids[1])} en même temps`,
        };
      }
      if (c.kind === 'room') {
        const name = rooms.find((x) => x.id === c.targetId)?.name ?? '';
        return {
          kind: c.kind,
          message: `la salle ${name} est occupée par ${label(c.ids[0])} et ${label(c.ids[1])}`,
        };
      }
      const [a, b] = c.ids.map((id) => sups.find((s) => s.id === id));
      const roomOf = (id?: string) => rooms.find((x) => x.id === id)?.name ?? '';
      return {
        kind: c.kind,
        message: `${users.get(c.targetId) ?? 'un surveillant'} surveille en même temps ${roomOf(a?.roomId)} (${label(a?.paperId ?? '')}) et ${roomOf(b?.roomId)} (${label(b?.paperId ?? '')})`,
      };
    });
  }
}
