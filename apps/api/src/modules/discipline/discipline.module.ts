import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
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
  INCIDENT_TYPE_LABELS,
  incidentCreateSchema,
  incidentFilterSchema,
  SANCTION_TYPE_LABELS,
  summarizeIncidents,
} from '@ecole/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId } from '../../common/context';
import { fromDbDate, toDbDate } from '../../common/dates';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { NotificationsService } from '../notifications/notifications.service';
import { subjects, templates } from '../notifications/templates';

type Filters = z.infer<typeof incidentFilterSchema>;

/** Registre des incidents de toute l'école (surveillance générale et direction). */
@Injectable()
export class DisciplineService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Exclusion temporaire : le parent principal est prévenu (SMS ou e-mail) par la table d'envoi,
   * dans la transaction du signalement ou de la correction.
   */
  private async notifyExclusion(
    tx: Tx,
    incident: { id: string; studentId: string; date: Date; sanction: string | null },
  ) {
    const [student, link, school] = await Promise.all([
      tx.student.findUniqueOrThrow({
        where: { id: incident.studentId },
        select: { firstName: true, lastName: true, gender: true },
      }),
      tx.studentGuardian.findFirst({
        where: { studentId: incident.studentId },
        include: { guardian: { select: { phone: true, email: true } } },
        orderBy: { isPrimary: 'desc' },
      }),
      tx.school.findUniqueOrThrow({ where: { id: currentSchoolId() }, select: { name: true } }),
    ]);
    if (!link) return;
    const name = `${student.firstName} ${student.lastName}`;
    await this.notifications.notifyContact(
      {
        schoolId: currentSchoolId(),
        contact: link.guardian,
        template: 'temporaryExclusion',
        body: templates.temporaryExclusion({
          school: school.name,
          student: name,
          gender: student.gender,
          date: fromDbDate(incident.date).split('-').reverse().join('/'),
          details: incident.sanction,
        }),
        subject: subjects.temporaryExclusion({ student: name }),
        payload: { incidentId: incident.id, studentId: incident.studentId },
      },
      tx,
    );
  }

  /**
   * Correction ou suppression : l'auteur du signalement, ou la vie scolaire et la direction
   * (`discipline.manage`), toujours avec le droit de signaler.
   */
  private canEdit(reportedById: string): boolean {
    return (
      this.scope.can('discipline.write') &&
      (reportedById === currentActorId() || this.scope.can('discipline.manage'))
    );
  }

  private async editable(id: string) {
    const incident = await this.db.incident.findUnique({ where: { id } });
    if (!incident) throw new NotFoundException('Incident introuvable');
    if (!this.canEdit(incident.reportedById))
      throw new ForbiddenException(
        'Seuls l’auteur du signalement, la vie scolaire et la direction peuvent corriger cet incident',
      );
    return incident;
  }

  private async where(f: Omit<Filters, 'page' | 'pageSize'>): Promise<Prisma.IncidentWhereInput> {
    const where: Prisma.IncidentWhereInput = {
      ...(f.type ? { type: f.type } : {}),
      ...(f.sanctionType ? { sanctionType: f.sanctionType } : {}),
    };
    if (f.from || f.to)
      where.date = {
        ...(f.from ? { gte: toDbDate(f.from) } : {}),
        ...(f.to ? { lte: toDbDate(f.to) } : {}),
      };
    if (f.classId) {
      const enrollments = await this.db.enrollment.findMany({
        where: { classId: f.classId },
        select: { studentId: true },
      });
      where.studentId = { in: enrollments.map((e) => e.studentId) };
    }
    return where;
  }

  /** Élève et classe de l'année en cours, pour l'affichage. */
  private async people(studentIds: string[], userIds: string[]) {
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    const [students, enrollments, users] = await Promise.all([
      this.db.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, firstName: true, lastName: true, matricule: true },
      }),
      this.db.enrollment.findMany({
        where: { studentId: { in: studentIds }, academicYearId: year?.id ?? '' },
        select: { studentId: true, class: { select: { id: true, name: true } } },
      }),
      this.db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true },
      }),
    ]);
    return {
      student: (id: string) => students.find((s) => s.id === id) ?? null,
      class: (id: string) => enrollments.find((e) => e.studentId === id)?.class ?? null,
      user: (id: string) => {
        const u = users.find((x) => x.id === id);
        return u ? `${u.firstName} ${u.lastName}` : null;
      },
    };
  }

  async list(f: Filters) {
    const where = await this.where(f);
    const [total, rows] = await Promise.all([
      this.db.incident.count({ where }),
      this.db.incident.findMany({
        where,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
      }),
    ]);
    const p = await this.people(
      [...new Set(rows.map((r) => r.studentId))],
      [...new Set(rows.map((r) => r.reportedById))],
    );
    return {
      total,
      page: f.page,
      pageSize: f.pageSize,
      items: rows.map((r) => ({
        id: r.id,
        date: fromDbDate(r.date),
        type: r.type,
        typeLabel: INCIDENT_TYPE_LABELS[r.type],
        description: r.description,
        sanctionType: r.sanctionType,
        sanctionLabel: SANCTION_TYPE_LABELS[r.sanctionType],
        sanction: r.sanction,
        student: p.student(r.studentId),
        class: p.class(r.studentId),
        reportedBy: p.user(r.reportedById),
        createdAt: r.createdAt,
        canEdit: this.canEdit(r.reportedById),
      })),
    };
  }

  async stats(f: Omit<Filters, 'page' | 'pageSize'>) {
    const rows = await this.db.incident.findMany({
      where: await this.where(f),
      select: { studentId: true, type: true, sanctionType: true, date: true },
      take: 20_000,
    });
    const summary = summarizeIncidents(rows.map((r) => ({ ...r, date: fromDbDate(r.date) })));
    const p = await this.people([...new Set(rows.map((r) => r.studentId))], []);
    const byClass = new Map<string, { classId: string | null; className: string; count: number }>();
    for (const r of rows) {
      const c = p.class(r.studentId);
      const key = c?.id ?? '';
      const entry = byClass.get(key) ?? {
        classId: c?.id ?? null,
        className: c?.name ?? 'Sans classe',
        count: 0,
      };
      entry.count++;
      byClass.set(key, entry);
    }
    return {
      ...summary,
      byClass: [...byClass.values()].sort(
        (a, b) => b.count - a.count || a.className.localeCompare(b.className, 'fr'),
      ),
      repeatStudents: summary.repeatStudents.map((r) => ({
        ...r,
        student: p.student(r.studentId),
        class: p.class(r.studentId),
      })),
    };
  }

  async create(input: z.infer<typeof incidentCreateSchema>) {
    const student = await this.db.student.findUnique({ where: { id: input.studentId } });
    if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    return this.db.$transaction(async (tx) => {
      const incident = await tx.incident.create({
        data: {
          schoolId: currentSchoolId(),
          studentId: input.studentId,
          date: toDbDate(input.date),
          type: input.type,
          description: input.description,
          sanctionType: input.sanctionType,
          sanction: input.sanction || null,
          reportedById: currentActorId() ?? '',
        },
      });
      await this.audit.log(
        { action: 'discipline.incident', entity: 'Incident', entityId: incident.id, after: input },
        tx,
      );
      if (incident.sanctionType === 'TEMPORARY_EXCLUSION') await this.notifyExclusion(tx, incident);
      return { ...incident, date: fromDbDate(incident.date) };
    });
  }

  /** Correction d'un incident (élève, date, faits, sanction), journalisée avant et après. */
  async update(id: string, input: z.infer<typeof incidentCreateSchema>) {
    const before = await this.editable(id);
    if (input.studentId !== before.studentId) {
      const student = await this.db.student.findUnique({ where: { id: input.studentId } });
      if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    }
    return this.db.$transaction(async (tx) => {
      const incident = await tx.incident.update({
        where: { id },
        data: {
          studentId: input.studentId,
          date: toDbDate(input.date),
          type: input.type,
          description: input.description,
          sanctionType: input.sanctionType,
          sanction: input.sanction || null,
        },
      });
      // Exclusion ajoutée par la correction (ou élève changé) : le bon parent est prévenu.
      if (
        incident.sanctionType === 'TEMPORARY_EXCLUSION' &&
        (before.sanctionType !== 'TEMPORARY_EXCLUSION' || before.studentId !== incident.studentId)
      )
        await this.notifyExclusion(tx, incident);
      await this.audit.log(
        {
          action: 'discipline.incident_updated',
          entity: 'Incident',
          entityId: id,
          before: snapshot(before),
          after: snapshot(incident),
        },
        tx,
      );
      return { ...incident, date: fromDbDate(incident.date) };
    });
  }

  /** Suppression d'un incident saisi par erreur ; son contenu reste au journal d'audit. */
  async remove(id: string) {
    const before = await this.editable(id);
    await this.db.$transaction(async (tx) => {
      await tx.incident.delete({ where: { id } });
      await this.audit.log(
        {
          action: 'discipline.incident_deleted',
          entity: 'Incident',
          entityId: id,
          before: snapshot(before),
        },
        tx,
      );
    });
  }
}

/** Contenu d'un incident pour le journal d'audit. */
function snapshot(i: {
  studentId: string;
  date: Date;
  type: string;
  description: string;
  sanctionType: string;
  sanction: string | null;
  reportedById: string;
}) {
  return {
    studentId: i.studentId,
    date: fromDbDate(i.date),
    type: i.type,
    description: i.description,
    sanctionType: i.sanctionType,
    sanction: i.sanction,
    reportedById: i.reportedById,
  };
}

const statsSchema = incidentFilterSchema.innerType().omit({ page: true, pageSize: true });

@ApiTags('discipline')
@ApiBearerAuth()
@RequireModule('attendance')
@Controller('discipline')
export class DisciplineController {
  constructor(private readonly discipline: DisciplineService) {}

  @RequirePermissions('discipline.read')
  @Get('incidents')
  list(@Query(new ZodPipe(incidentFilterSchema)) q: Filters) {
    return this.discipline.list(q);
  }

  @RequirePermissions('discipline.read')
  @Get('stats')
  stats(@Query(new ZodPipe(statsSchema)) q: z.infer<typeof statsSchema>) {
    return this.discipline.stats(q);
  }

  @RequirePermissions('discipline.read', 'discipline.write')
  @Post('incidents')
  create(@Body(new ZodPipe(incidentCreateSchema)) body: z.infer<typeof incidentCreateSchema>) {
    return this.discipline.create(body);
  }

  @RequirePermissions('discipline.read', 'discipline.write')
  @Patch('incidents/:id')
  update(
    @Param('id') id: string,
    @Body(new ZodPipe(incidentCreateSchema)) body: z.infer<typeof incidentCreateSchema>,
  ) {
    return this.discipline.update(id, body);
  }

  @RequirePermissions('discipline.read', 'discipline.write')
  @Delete('incidents/:id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.discipline.remove(id);
  }
}

@Module({ controllers: [DisciplineController], providers: [DisciplineService] })
export class DisciplineModule {}
