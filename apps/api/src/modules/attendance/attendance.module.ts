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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  attendanceSubmitSchema,
  INCIDENT_TYPES,
  isoDate,
  justificationCreateSchema,
  justificationReviewSchema,
  pastOrTodayDate,
  SANCTION_TYPES,
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
import { FileUpload } from '../files/files.module';
import { FilesService, presentFile, type UploadedFile as Upload } from '../files/files.service';
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
  date: pastOrTodayDate,
  description: z.string().trim().min(3).max(1000),
  sanction: z.string().trim().max(300).optional(),
  type: z.enum(INCIDENT_TYPES).optional(),
  sanctionType: z.enum(SANCTION_TYPES).optional(),
});
const statsSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

/** Motifs d'annulation d'un SMS d'absence pas encore parti. */
const PRESENT_NOTE = 'Annulé : élève marqué présent';
const ACCEPTED_NOTE = 'Annulé : absence justifiée';

@Injectable()
export class AttendanceService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
  ) {}

  /** Liste d'appel : élèves de la classe et statut déjà saisi pour ce créneau. */
  async roster(classId: string, date: string, startTime: string) {
    const cls = await this.scope.classForTeacher(classId, 'attendance.write');
    const students = await this.scope.classStudents(classId);
    const session = await this.db.attendanceSession.findFirst({
      where: { classId, date: toDbDate(date), startTime },
      include: { records: true },
    });
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { settings: true },
    });
    const settings = (school.settings ?? {}) as AttendanceSettings;
    return {
      class: { id: cls.id, name: cls.name },
      /** Délai du SMS d'absence après la fin du cours (ou après l'appel, s'il est fait plus tard). */
      absenceNotificationDelayMinutes: settings.absenceNotificationDelayMinutes ?? 60,
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
        gender: s.gender,
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
    const cls = await this.scope.classForTeacher(input.classId, 'attendance.write');
    await this.scope.assertYearOpen(cls.academicYearId);
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
      select: { firstName: true, lastName: true, gender: true },
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
          gender: student.gender,
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

  /**
   * Annule le SMS d'absence pas encore parti : élève finalement marqué présent, ou absence
   * justifiée entre-temps. Le motif reste lisible dans la table d'envoi.
   */
  private async cancelAbsenceNotification(tx: Tx, recordId: string, why = PRESENT_NOTE) {
    await tx.$executeRaw`
      UPDATE "NotificationOutbox" SET "status" = 'FAILED', "lastError" = ${why}
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
    await this.scope.assertStudentInScope(studentId, 'attendance.read');
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

  /**
   * Justificatif d'une ou plusieurs absences d'un élève. Le rattachement est conditionnel et fait
   * dans la même transaction : une seconde demande identique (double appui) échoue au lieu de
   * laisser un justificatif rattaché à aucune absence.
   */
  async createJustification(
    input: z.infer<typeof justificationCreateSchema>,
    submittedById: string,
    tx?: Tx,
  ) {
    const recordIds = [...new Set(input.recordIds)];
    const run = async (db: Tx) => {
      const records = await db.attendanceRecord.findMany({
        where: { id: { in: recordIds }, studentId: input.studentId },
      });
      if (records.length === 0 || records.length !== recordIds.length)
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
          recordIds,
        },
      });
      const linked = await db.attendanceRecord.updateMany({
        where: { id: { in: recordIds }, justificationId: null },
        data: { justificationId: justification.id },
      });
      if (linked.count !== recordIds.length)
        throw new ConflictException('Une de ces absences a déjà un justificatif');
      await this.audit.log(
        {
          action: 'attendance.justification_submitted',
          entity: 'Justification',
          entityId: justification.id,
          after: { ...input, recordIds },
        },
        db,
      );
      return justification;
    };
    return tx ? run(tx) : this.db.$transaction(run);
  }

  async listJustifications(status?: 'PENDING' | 'ACCEPTED' | 'REJECTED') {
    // Un enseignant ne voit que les justificatifs des élèves de ses classes (motifs souvent médicaux).
    const studentIds = this.scope.isClassScoped('attendance.read')
      ? (
          await this.db.enrollment.findMany({
            where: { classId: { in: await this.scope.teacherClassIds() } },
            select: { studentId: true },
          })
        ).map((e) => e.studentId)
      : null;
    const items = await this.db.justification.findMany({
      where: { status, ...(studentIds ? { studentId: { in: studentIds } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { file: true },
    });
    // Absences visées à l'envoi : un refus les remet « à justifier » sans perdre la trace.
    const [students, records] = await Promise.all([
      this.db.student.findMany({
        where: { id: { in: [...new Set(items.map((i) => i.studentId))] } },
        select: { id: true, firstName: true, lastName: true, matricule: true },
      }),
      this.db.attendanceRecord.findMany({
        where: { id: { in: [...new Set(items.flatMap((i) => i.recordIds))] } },
        include: { session: true },
        orderBy: [{ session: { date: 'asc' } }, { session: { startTime: 'asc' } }],
      }),
    ]);
    return items.map((j) => ({
      id: j.id,
      status: j.status,
      reason: j.reason,
      createdAt: j.createdAt,
      // Nom et détails de la pièce (souvent médicale) réservés à qui traite les justificatifs.
      attachment: this.scope.can('attendance.justify') ? presentFile(j.file) : null,
      hasAttachment: !!presentFile(j.file),
      reviewNote: j.reviewNote,
      reviewedAt: j.reviewedAt,
      student: students.find((s) => s.id === j.studentId) ?? null,
      records: records
        .filter((r) => j.recordIds.includes(r.id))
        .map((r) => ({
          id: r.id,
          date: fromDbDate(r.session.date),
          startTime: r.session.startTime,
          endTime: r.session.endTime,
          status: r.status,
        })),
    }));
  }

  /**
   * Pièce jointe d'un justificatif (déposée par le parent ou l'école). Remplaçable tant que le
   * justificatif est en attente ; figée une fois traité.
   */
  async attach(id: string, upload: Upload | undefined) {
    const j = await this.db.justification.findUnique({ where: { id } });
    if (!j) throw new NotFoundException('Justificatif introuvable');
    if (j.status !== 'PENDING')
      throw new ConflictException('Ce justificatif a déjà été traité : pièce jointe figée');
    this.files.validate(upload);
    return this.db.$transaction(async (tx) => {
      const file = await this.files.store(upload, 'JUSTIFICATION', tx);
      if (j.fileId) await this.files.softDelete(j.fileId, 'Pièce jointe remplacée', tx);
      await tx.justification.update({ where: { id }, data: { fileId: file.id } });
      await this.audit.log(
        {
          action: 'attendance.justification_attachment',
          entity: 'Justification',
          entityId: id,
          before: { fileId: j.fileId },
          after: { fileId: file.id },
        },
        tx,
      );
      return { id, attachment: presentFile(file) };
    });
  }

  /** Lien de consultation de la pièce jointe, journalisé (motifs souvent médicaux). */
  async attachmentLink(id: string) {
    const j = await this.db.justification.findUnique({ where: { id } });
    if (!j) throw new NotFoundException('Justificatif introuvable');
    return this.files.link(j.fileId, true);
  }

  /**
   * Décision de la vie scolaire. Un refus porte un motif, remet les absences « à justifier » (un
   * nouveau justificatif reste possible), garde la trace des absences visées et prévient le parent
   * par la table d'envoi.
   */
  async review(id: string, decision: 'ACCEPTED' | 'REJECTED', note?: string) {
    const j = await this.db.justification.findUnique({ where: { id }, include: { records: true } });
    if (!j) throw new NotFoundException('Justificatif introuvable');
    if (j.status !== 'PENDING') throw new ConflictException('Ce justificatif a déjà été traité');
    const reviewNote = decision === 'REJECTED' ? note?.trim() || null : null;
    return this.db.$transaction(async (tx) => {
      const claimed = await tx.justification.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: decision,
          reviewedById: currentActorId(),
          reviewedAt: new Date(),
          reviewNote,
        },
      });
      if (claimed.count === 0) throw new ConflictException('Ce justificatif a déjà été traité');
      if (decision === 'REJECTED') {
        await tx.attendanceRecord.updateMany({
          where: { justificationId: id },
          data: { justificationId: null },
        });
        await this.notifyRejection(tx, j.studentId, j.recordIds, reviewNote ?? '');
      } else {
        for (const r of j.records) await this.cancelAbsenceNotification(tx, r.id, ACCEPTED_NOTE);
      }
      await this.audit.log(
        {
          action: 'attendance.justification_reviewed',
          entity: 'Justification',
          entityId: id,
          after: { decision, ...(reviewNote ? { note: reviewNote } : {}) },
        },
        tx,
      );
      return tx.justification.findUniqueOrThrow({ where: { id } });
    });
  }

  /** SMS au parent principal : justificatif refusé, motif et absences concernées. */
  private async notifyRejection(tx: Tx, studentId: string, recordIds: string[], note: string) {
    const [student, link, school, records] = await Promise.all([
      tx.student.findUniqueOrThrow({
        where: { id: studentId },
        select: { firstName: true, lastName: true },
      }),
      tx.studentGuardian.findFirst({
        where: { studentId },
        include: { guardian: true },
        orderBy: { isPrimary: 'desc' },
      }),
      tx.school.findUniqueOrThrow({ where: { id: currentSchoolId() }, select: { name: true } }),
      tx.attendanceRecord.findMany({
        where: { id: { in: recordIds } },
        include: { session: true },
        orderBy: [{ session: { date: 'asc' } }, { session: { startTime: 'asc' } }],
      }),
    ]);
    if (!link) return;
    await this.notifications.enqueue(
      {
        schoolId: currentSchoolId(),
        recipient: link.guardian.phone,
        template: 'justificationRejected',
        body: templates.justificationRejected({
          school: school.name,
          student: `${student.firstName} ${student.lastName}`,
          records: records.map((r) => ({
            date: fromDbDate(r.session.date).split('-').reverse().join('/'),
            slot: `${r.session.startTime}–${r.session.endTime}`,
            late: r.status === 'LATE',
          })),
          note,
        }),
        payload: { studentId, recordIds },
      },
      tx,
    );
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
        type: input.type,
        sanctionType: input.sanctionType ?? (input.sanction ? 'OTHER' : 'NONE'),
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
    return this.attendance.review(id, body.decision, body.note);
  }

  @RequirePermissions('attendance.justify')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileUpload)
  @Post('justifications/:id/attachment')
  attach(@Param('id') id: string, @UploadedFile() file: Upload | undefined) {
    return this.attendance.attach(id, file);
  }

  @RequirePermissions('attendance.justify')
  @Get('justifications/:id/attachment')
  attachment(@Param('id') id: string) {
    return this.attendance.attachmentLink(id);
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
