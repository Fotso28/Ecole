import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
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
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';

type Filters = z.infer<typeof incidentFilterSchema>;

/** Registre des incidents de toute l'école (surveillance générale et direction). */
@Injectable()
export class DisciplineService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

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
      return { ...incident, date: fromDbDate(incident.date) };
    });
  }
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
}

@Module({ controllers: [DisciplineController], providers: [DisciplineService] })
export class DisciplineModule {}
