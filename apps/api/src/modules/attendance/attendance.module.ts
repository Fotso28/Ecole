import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  attendanceSubmitSchema,
  isoDate,
  justificationCreateSchema,
  justificationReviewSchema,
  timeOfDay,
  toMinutes,
} from '@ecole/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId } from '../../common/context';
import { addDays, fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { NotificationsService } from '../notifications/notifications.service';
import { templates } from '../notifications/templates';

interface AttendanceSettings {
  absenceAlertThreshold?: number;
  absenceAlertWindowDays?: number;
  absenceNotificationDelayMinutes?: number;
}

const rosterSchema = z.object({ classId: z.string().min(1), date: isoDate, startTime: timeOfDay });
const incidentSchema = z.object({
  studentId: z.string().min(1),
  date: isoDate,
  description: z.string().trim().min(3).max(1000),
  sanction: z.string().trim().max(300).optional(),
});
const statsSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

@Injectable()
export class AttendanceService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Liste d'appel : élèves de la classe et statut déjà saisi pour ce créneau. */
  async roster(classId: string, date: string, startTime: string) {
    const cls = await this.scope.classForTeacher(classId);
    const students = await this.scope.classStudents(classId);
    const session = await this.db.attendanceSession.findFirst({
      where: { classId, date: toDbDate(date), startTime },
      include: { records: true },
    });
    return {
      class: { id: cls.id, name: cls.name },
      session: session
        ? {
            id: session.id,
            startTime: session.startTime,
            endTime: session.endTime,
            updatedAt: session.updatedAt,
          }
        : null,
      students: students.map((s) => ({
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        matricule: s.matricule,
        status: session?.records.find((r) => r.studentId === s.id)?.status ?? null,
      })),
    };
  }

  /** Enregistre (ou corrige) un appel, puis programme les SMS aux parents des absents. */
  async submit(input: z.infer<typeof attendanceSubmitSchema>) {
    if (toMinutes(input.endTime) <= toMinutes(input.startTime))
      throw new BadRequestException('L’heure de fin doit suivre l’heure de début');
    if (input.date > todayInCameroon())
      throw new BadRequestException('Impossible de faire l’appel d’une date future');
    const cls = await this.scope.classForTeacher(input.classId);
    if (input.classSubjectId) {
      const cs = await this.db.classSubject.findUnique({ where: { id: input.classSubjectId } });
      if (!cs || cs.classId !== input.classId)
        throw new BadRequestException('Matière inconnue pour cette classe');
    }
    const enrolled = new Set((await this.scope.classStudents(input.classId)).map((s) => s.id));
    const unknown = input.records.filter((r) => !enrolled.has(r.studentId));
    if (unknown.length > 0)
      throw new BadRequestException('Certains élèves ne sont pas inscrits dans cette classe');
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { name: true, settings: true },
    });
    const settings = (school.settings ?? {}) as AttendanceSettings;
    const takenById = currentActorId() ?? '';

    const result = await this.db.$transaction(async (tx) => {
      const session = await tx.attendanceSession.upsert({
        where: {
          classId_date_startTime: {
            classId: input.classId,
            date: toDbDate(input.date),
            startTime: input.startTime,
          },
        },
        create: {
          schoolId: currentSchoolId(),
          classId: input.classId,
          classSubjectId: input.classSubjectId,
          date: toDbDate(input.date),
          startTime: input.startTime,
          endTime: input.endTime,
          takenById,
        },
        update: { endTime: input.endTime, classSubjectId: input.classSubjectId, takenById },
      });
      const previous = await tx.attendanceRecord.findMany({ where: { sessionId: session.id } });
      const notifyAfter = new Date(
        Math.max(Date.now(), new Date(`${input.date}T${input.endTime}:00+01:00`).getTime()) +
          (settings.absenceNotificationDelayMinutes ?? 60) * 60_000,
      );
      let notified = 0;
      for (const r of input.records) {
        const prev = previous.find((p) => p.studentId === r.studentId);
        const record = await tx.attendanceRecord.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: r.studentId } },
          create: {
            schoolId: currentSchoolId(),
            sessionId: session.id,
            studentId: r.studentId,
            status: r.status,
          },
          update: { status: r.status },
        });
        if (prev?.status === 'ABSENT' && r.status !== 'ABSENT') {
          await this.cancelAbsenceNotification(tx, record.id);
        }
        if (r.status === 'ABSENT' && !record.notifiedAt && !record.justificationId) {
          const sent = await this.scheduleAbsenceNotification(
            tx,
            record.id,
            r.studentId,
            input.date,
            `${input.startTime}–${input.endTime}`,
            school.name,
            notifyAfter,
          );
          if (sent) notified++;
        }
      }
      await this.audit.log(
        {
          action: 'attendance.submitted',
          entity: 'AttendanceSession',
          entityId: session.id,
          after: { classId: input.classId, date: input.date, records: input.records.length },
        },
        tx,
      );
      return { sessionId: session.id, notified };
    });
    const alerts = await this.checkThresholds(
      input.records.filter((r) => r.status === 'ABSENT').map((r) => r.studentId),
      settings,
    );
    return { ...result, className: cls.name, alerts };
  }

  private async scheduleAbsenceNotification(
    tx: Tx,
    recordId: string,
    studentId: string,
    date: string,
    slot: string,
    schoolName: string,
    availableAt: Date,
  ) {
    const student = await tx.student.findUniqueOrThrow({
      where: { id: studentId },
      select: { firstName: true, lastName: true },
    });
    const link = await tx.studentGuardian.findFirst({
      where: { studentId },
      include: { guardian: true },
      orderBy: { isPrimary: 'desc' },
    });
    if (!link) return false;
    const n = await this.notifications.enqueue(
      {
        schoolId: currentSchoolId(),
        recipient: link.guardian.phone,
        template: 'absence',
        body: templates.absence({
          student: `${student.firstName} ${student.lastName}`,
          date: date.split('-').reverse().join('/'),
          slot,
          school: schoolName,
        }),
        payload: { recordId, studentId },
      },
      tx,
    );
    await tx.notificationOutbox.update({ where: { id: n.id }, data: { availableAt } });
    await tx.attendanceRecord.update({ where: { id: recordId }, data: { notifiedAt: new Date() } });
    return true;
  }

  /** Annule le SMS d'absence pas encore parti si l'élève est finalement marqué présent. */
  private async cancelAbsenceNotification(tx: Tx, recordId: string) {
    await tx.$executeRaw`
      UPDATE "NotificationOutbox" SET "status" = 'FAILED', "lastError" = 'Annulé : élève marqué présent'
      WHERE "status" = 'PENDING' AND "template" = 'absence' AND "payload"->>'recordId' = ${recordId}`;
    await tx.attendanceRecord.update({ where: { id: recordId }, data: { notifiedAt: null } });
  }

  /** Alerte quand un élève dépasse le seuil d'absences non justifiées (par défaut 3 en 7 jours). */
  private async checkThresholds(studentIds: string[], settings: AttendanceSettings) {
    const threshold = settings.absenceAlertThreshold ?? 3;
    const days = settings.absenceAlertWindowDays ?? 7;
    const since = toDbDate(addDays(todayInCameroon(), -(days - 1)));
    const alerts: { studentId: string; count: number }[] = [];
    for (const studentId of studentIds) {
      const count = await this.db.attendanceRecord.count({
        where: {
          studentId,
          status: 'ABSENT',
          session: { date: { gte: since } },
          OR: [{ justificationId: null }, { justification: { status: { not: 'ACCEPTED' } } }],
        },
      });
      if (count < threshold) continue;
      alerts.push({ studentId, count });
      const already = await this.db.notificationOutbox.count({
        where: {
          template: 'absenceThreshold',
          createdAt: { gte: since },
          payload: { path: ['studentId'], equals: studentId },
        },
      });
      if (already > 0) continue;
      const student = await this.db.student.findUniqueOrThrow({
        where: { id: studentId },
        select: { firstName: true, lastName: true },
      });
      const link = await this.db.studentGuardian.findFirst({
        where: { studentId },
        include: { guardian: true },
        orderBy: { isPrimary: 'desc' },
      });
      if (link) {
        await this.notifications.enqueue({
          schoolId: currentSchoolId(),
          recipient: link.guardian.phone,
          template: 'absenceThreshold',
          body: templates.absenceThreshold({
            student: `${student.firstName} ${student.lastName}`,
            count,
            days,
          }),
          payload: { studentId },
        });
      }
      await this.audit.log({
        action: 'attendance.threshold_alert',
        entity: 'Student',
        entityId: studentId,
        after: { count, days },
      });
    }
    return alerts;
  }

  async studentRecords(studentId: string) {
    const year = await this.scope.currentYear();
    const records = await this.db.attendanceRecord.findMany({
      where: { studentId, session: { date: { gte: year.startDate } } },
      include: {
        session: true,
        justification: { select: { id: true, status: true, reason: true } },
      },
      orderBy: { session: { date: 'desc' } },
    });
    return records.map((r) => ({
      id: r.id,
      date: fromDbDate(r.session.date),
      startTime: r.session.startTime,
      endTime: r.session.endTime,
      status: r.status,
      justification: r.justification,
    }));
  }

  async createJustification(
    input: z.infer<typeof justificationCreateSchema>,
    submittedById: string,
    tx?: Tx,
  ) {
    const db = tx ?? this.db;
    const records = await db.attendanceRecord.findMany({
      where: { id: { in: input.recordIds }, studentId: input.studentId },
    });
    if (records.length !== input.recordIds.length)
      throw new BadRequestException('Absence inconnue pour cet élève');
    if (records.some((r) => r.status === 'PRESENT'))
      throw new BadRequestException('Seules les absences et retards se justifient');
    if (records.some((r) => r.justificationId))
      throw new ConflictException('Une de ces absences a déjà un justificatif');
    const justification = await db.justification.create({
      data: {
        schoolId: records[0]?.schoolId ?? currentSchoolId(),
        studentId: input.studentId,
        submittedById,
        reason: input.reason,
      },
    });
    await db.attendanceRecord.updateMany({
      where: { id: { in: input.recordIds } },
      data: { justificationId: justification.id },
    });
    await this.audit.log(
      {
        action: 'attendance.justification_submitted',
        entity: 'Justification',
        entityId: justification.id,
        after: input,
      },
      tx,
    );
    return justification;
  }

  async listJustifications(status?: 'PENDING' | 'ACCEPTED' | 'REJECTED') {
    const items = await this.db.justification.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { records: { include: { session: true } } },
    });
    const students = await this.db.student.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.studentId))] } },
      select: { id: true, firstName: true, lastName: true, matricule: true },
    });
    return items.map((j) => ({
      id: j.id,
      status: j.status,
      reason: j.reason,
      createdAt: j.createdAt,
      student: students.find((s) => s.id === j.studentId) ?? null,
      records: j.records.map((r) => ({
        id: r.id,
        date: fromDbDate(r.session.date),
        startTime: r.session.startTime,
        endTime: r.session.endTime,
        status: r.status,
      })),
    }));
  }

  async review(id: string, decision: 'ACCEPTED' | 'REJECTED') {
    const j = await this.db.justification.findUnique({ where: { id }, include: { records: true } });
    if (!j) throw new NotFoundException('Justificatif introuvable');
    if (j.status !== 'PENDING') throw new ConflictException('Ce justificatif a déjà été traité');
    return this.db.$transaction(async (tx) => {
      const updated = await tx.justification.update({
        where: { id },
        data: { status: decision, reviewedById: currentActorId(), reviewedAt: new Date() },
      });
      if (decision === 'REJECTED') {
        await tx.attendanceRecord.updateMany({
          where: { justificationId: id },
          data: { justificationId: null },
        });
      } else {
        for (const r of j.records) await this.cancelAbsenceNotification(tx, r.id);
      }
      await this.audit.log(
        {
          action: 'attendance.justification_reviewed',
          entity: 'Justification',
          entityId: id,
          after: { decision },
        },
        tx,
      );
      return updated;
    });
  }

  async stats(from?: string, to?: string) {
    const year = await this.scope.currentYear();
    const start = from ?? fromDbDate(year.startDate);
    const end = to ?? todayInCameroon();
    const classes = await this.db.class.findMany({
      where: { academicYearId: year.id },
      orderBy: { name: 'asc' },
    });
    const records = await this.db.attendanceRecord.findMany({
      where: { session: { date: { gte: toDbDate(start), lte: toDbDate(end) } } },
      select: {
        status: true,
        studentId: true,
        justification: { select: { status: true } },
        session: { select: { classId: true } },
      },
    });
    const byClass = classes.map((c) => {
      const rows = records.filter((r) => r.session.classId === c.id);
      const absences = rows.filter((r) => r.status === 'ABSENT');
      return {
        classId: c.id,
        className: c.name,
        records: rows.length,
        absences: absences.length,
        unjustified: absences.filter((r) => r.justification?.status !== 'ACCEPTED').length,
        lates: rows.filter((r) => r.status === 'LATE').length,
        rate: rows.length ? Math.round((absences.length * 1000) / rows.length) / 10 : 0,
      };
    });
    const perStudent = new Map<string, number>();
    for (const r of records)
      if (r.status === 'ABSENT')
        perStudent.set(r.studentId, (perStudent.get(r.studentId) ?? 0) + 1);
    const top = [...perStudent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const students = await this.db.student.findMany({
      where: { id: { in: top.map(([id]) => id) } },
      select: { id: true, firstName: true, lastName: true },
    });
    return {
      from: start,
      to: end,
      classes: byClass,
      topStudents: top.map(([id, count]) => ({
        student: students.find((s) => s.id === id) ?? null,
        absences: count,
      })),
    };
  }

  async createIncident(input: z.infer<typeof incidentSchema>) {
    await this.db.student.findUniqueOrThrow({ where: { id: input.studentId } });
    const incident = await this.db.incident.create({
      data: {
        schoolId: currentSchoolId(),
        studentId: input.studentId,
        date: toDbDate(input.date),
        description: input.description,
        sanction: input.sanction,
        reportedById: currentActorId() ?? '',
      },
    });
    await this.audit.log({
      action: 'discipline.incident',
      entity: 'Incident',
      entityId: incident.id,
      after: input,
    });
    return incident;
  }
}

@ApiTags('attendance')
@ApiBearerAuth()
@RequireModule('attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @RequirePermissions('attendance.write')
  @Get('roster')
  roster(@Query(new ZodPipe(rosterSchema)) q: z.infer<typeof rosterSchema>) {
    return this.attendance.roster(q.classId, q.date, q.startTime);
  }

  @RequirePermissions('attendance.write')
  @Post('sessions')
  submit(@Body(new ZodPipe(attendanceSubmitSchema)) body: z.infer<typeof attendanceSubmitSchema>) {
    return this.attendance.submit(body);
  }

  @RequirePermissions('attendance.read')
  @Get('students/:id')
  student(@Param('id') id: string) {
    return this.attendance.studentRecords(id);
  }

  @RequirePermissions('attendance.justify')
  @Post('justifications')
  justify(
    @Body(new ZodPipe(justificationCreateSchema)) body: z.infer<typeof justificationCreateSchema>,
  ) {
    return this.attendance.createJustification(body, currentActorId() ?? '');
  }

  @RequirePermissions('attendance.read')
  @Get('justifications')
  justifications(@Query('status') status?: 'PENDING' | 'ACCEPTED' | 'REJECTED') {
    return this.attendance.listJustifications(status);
  }

  @RequirePermissions('attendance.justify')
  @Patch('justifications/:id')
  review(
    @Param('id') id: string,
    @Body(new ZodPipe(justificationReviewSchema)) body: z.infer<typeof justificationReviewSchema>,
  ) {
    return this.attendance.review(id, body.decision);
  }

  @RequirePermissions('attendance.read')
  @Get('stats')
  stats(@Query(new ZodPipe(statsSchema)) q: z.infer<typeof statsSchema>) {
    return this.attendance.stats(q.from, q.to);
  }

  @RequirePermissions('discipline.write')
  @Post('incidents')
  incident(@Body(new ZodPipe(incidentSchema)) body: z.infer<typeof incidentSchema>) {
    return this.attendance.createIncident(body);
  }
}

@Module({
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
