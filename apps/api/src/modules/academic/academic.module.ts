import {
  Body,
  ConflictException,
  Controller,
  Delete,
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
  academicYearCreateSchema,
  classCreateSchema,
  classSubjectCreateSchema,
  cycleCreateSchema,
  levelCreateSchema,
  subjectCreateSchema,
  termCreateSchema,
} from '@ecole/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId } from '../../common/context';
import { fromDbDate, toDbDate } from '../../common/dates';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';

const classSubjectUpdateSchema = z.object({
  coefficient: z.number().int().min(1).max(10).optional(),
  teacherId: z.string().min(1).nullable().optional(),
  weeklyHours: z.number().int().min(0).max(20).nullable().optional(),
});
const rolloverSchema = z.object({ fromYearId: z.string().min(1) });

function shiftYear(d: Date): Date {
  const n = new Date(d);
  n.setUTCFullYear(n.getUTCFullYear() + 1);
  return n;
}

@Injectable()
export class AcademicService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  listYears() {
    return this.db.academicYear.findMany({ orderBy: { startDate: 'desc' } });
  }

  async createYear(input: z.infer<typeof academicYearCreateSchema>) {
    const year = await this.db.academicYear.create({
      data: {
        schoolId: currentSchoolId(),
        name: input.name,
        startDate: toDbDate(input.startDate),
        endDate: toDbDate(input.endDate),
      },
    });
    await this.audit.log({
      action: 'academic.year_created',
      entity: 'AcademicYear',
      entityId: year.id,
      after: input,
    });
    return year;
  }

  async setCurrentYear(id: string) {
    await this.db.academicYear.findUniqueOrThrow({ where: { id } });
    await this.db.$transaction([
      this.db.academicYear.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } }),
      this.db.academicYear.update({ where: { id }, data: { isCurrent: true } }),
    ]);
    await this.audit.log({ action: 'academic.year_current', entity: 'AcademicYear', entityId: id });
    return this.db.academicYear.findUniqueOrThrow({ where: { id } });
  }

  async closeYear(id: string) {
    const year = await this.db.academicYear.update({ where: { id }, data: { status: 'CLOSED' } });
    await this.audit.log({ action: 'academic.year_closed', entity: 'AcademicYear', entityId: id });
    return year;
  }

  async structure(yearId: string) {
    const year = await this.db.academicYear.findUnique({
      where: { id: yearId },
      include: {
        terms: { orderBy: { order: 'asc' }, include: { sequences: { orderBy: { order: 'asc' } } } },
        classes: {
          orderBy: [{ level: { order: 'asc' } }, { name: 'asc' }],
          include: {
            level: { include: { cycle: true } },
            subjects: { include: { subject: true }, orderBy: { subject: { name: 'asc' } } },
            _count: {
              select: { enrollments: { where: { status: { in: ['ENROLLED', 'REPEATING'] } } } },
            },
          },
        },
      },
    });
    if (!year) throw new NotFoundException('Année scolaire introuvable');
    return year;
  }

  async createTerm(input: z.infer<typeof termCreateSchema>) {
    const schoolId = currentSchoolId();
    await this.db.academicYear.findUniqueOrThrow({ where: { id: input.academicYearId } });
    return this.db.$transaction(async (tx) => {
      const term = await tx.term.create({
        data: {
          schoolId,
          academicYearId: input.academicYearId,
          name: input.name,
          order: input.order,
          startDate: toDbDate(input.startDate),
          endDate: toDbDate(input.endDate),
        },
      });
      for (const s of input.sequences) {
        await tx.sequence.create({
          data: { schoolId, termId: term.id, name: s.name, order: s.order },
        });
      }
      return tx.term.findUniqueOrThrow({
        where: { id: term.id },
        include: { sequences: { orderBy: { order: 'asc' } } },
      });
    });
  }

  listCycles() {
    return this.db.cycle.findMany({
      orderBy: { order: 'asc' },
      include: { levels: { orderBy: { order: 'asc' } } },
    });
  }

  createCycle(input: z.infer<typeof cycleCreateSchema>) {
    return this.db.cycle.create({ data: { schoolId: currentSchoolId(), ...input } });
  }

  async createLevel(input: z.infer<typeof levelCreateSchema>) {
    await this.db.cycle.findUniqueOrThrow({ where: { id: input.cycleId } });
    return this.db.level.create({ data: { schoolId: currentSchoolId(), ...input } });
  }

  listClasses(academicYearId?: string) {
    return this.db.class.findMany({
      where: academicYearId ? { academicYearId } : { academicYear: { isCurrent: true } },
      orderBy: [{ level: { order: 'asc' } }, { name: 'asc' }],
      include: {
        level: { include: { cycle: true } },
        _count: {
          select: { enrollments: { where: { status: { in: ['ENROLLED', 'REPEATING'] } } } },
        },
      },
    });
  }

  async createClass(input: z.infer<typeof classCreateSchema>) {
    await this.db.academicYear.findUniqueOrThrow({ where: { id: input.academicYearId } });
    await this.db.level.findUniqueOrThrow({ where: { id: input.levelId } });
    if (input.mainTeacherId) await this.assertTeacher(input.mainTeacherId);
    try {
      return await this.db.class.create({ data: { schoolId: currentSchoolId(), ...input } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Une classe porte déjà ce nom cette année');
      }
      throw e;
    }
  }

  async classDetail(id: string) {
    const cls = await this.db.class.findUnique({
      where: { id },
      include: {
        level: { include: { cycle: true } },
        academicYear: true,
        subjects: { include: { subject: true }, orderBy: { subject: { name: 'asc' } } },
      },
    });
    if (!cls) throw new NotFoundException('Classe introuvable');
    const teacherIds = [
      ...new Set(
        [cls.mainTeacherId, ...cls.subjects.map((s) => s.teacherId)].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
    const teachers = await this.db.user.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    return { ...cls, teachers };
  }

  listSubjects() {
    return this.db.subject.findMany({ orderBy: { name: 'asc' } });
  }

  async createSubject(input: z.infer<typeof subjectCreateSchema>) {
    try {
      return await this.db.subject.create({ data: { schoolId: currentSchoolId(), ...input } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ce code de matière existe déjà');
      }
      throw e;
    }
  }

  async assignSubject(input: z.infer<typeof classSubjectCreateSchema>) {
    const cls = await this.db.class.findUniqueOrThrow({ where: { id: input.classId } });
    await this.db.subject.findUniqueOrThrow({ where: { id: input.subjectId } });
    const existing = await this.db.classSubject.findFirst({
      where: { classId: input.classId, subjectId: input.subjectId },
    });
    if (existing)
      throw new ConflictException('Cette matière est déjà affectée à la classe pour cette année');
    if (input.teacherId) {
      await this.assertTeacher(input.teacherId);
      await this.assertTeacherLoad(input.teacherId, cls.academicYearId, input.weeklyHours ?? 0);
    }
    const cs = await this.db.classSubject.create({
      data: { schoolId: currentSchoolId(), ...input },
    });
    await this.audit.log({
      action: 'academic.subject_assigned',
      entity: 'ClassSubject',
      entityId: cs.id,
      after: input,
    });
    return cs;
  }

  async updateClassSubject(id: string, input: z.infer<typeof classSubjectUpdateSchema>) {
    const before = await this.db.classSubject.findUniqueOrThrow({
      where: { id },
      include: { class: true },
    });
    const teacherId = input.teacherId === undefined ? before.teacherId : input.teacherId;
    const hours =
      input.weeklyHours === undefined ? (before.weeklyHours ?? 0) : (input.weeklyHours ?? 0);
    if (teacherId) {
      await this.assertTeacher(teacherId);
      await this.assertTeacherLoad(teacherId, before.class.academicYearId, hours, id);
    }
    const after = await this.db.classSubject.update({ where: { id }, data: input });
    await this.audit.log({
      action: 'academic.subject_updated',
      entity: 'ClassSubject',
      entityId: id,
      before,
      after,
    });
    return after;
  }

  /**
   * Retrait d'une matière d'une classe (affectation faite par erreur). Refusé dès que des notes,
   * des appels, un emploi du temps ou un cahier de texte y sont rattachés : rien ne se perd.
   */
  async removeClassSubject(id: string) {
    const cs = await this.db.classSubject.findUniqueOrThrow({
      where: { id },
      include: { subject: true, class: true },
    });
    const label = `${cs.subject.name} (${cs.class.name})`;
    const [evaluations, sessions, timetable, lessons, materials] = await Promise.all([
      this.db.evaluation.count({ where: { classSubjectId: id } }),
      this.db.attendanceSession.count({ where: { classSubjectId: id } }),
      this.db.timetableEntry.count({ where: { classSubjectId: id } }),
      this.db.lessonLog.count({ where: { classSubjectId: id } }),
      this.db.courseMaterial.count({ where: { classSubjectId: id } }),
    ]);
    if (evaluations > 0)
      throw new ConflictException(
        `Impossible de retirer ${label} : des évaluations y sont déjà saisies`,
      );
    if (sessions + timetable + lessons + materials > 0)
      throw new ConflictException(
        `Impossible de retirer ${label} : l’emploi du temps, des appels ou le cahier de texte y sont rattachés`,
      );
    await this.db.$transaction(async (tx: Tx) => {
      await tx.classSubject.delete({ where: { id } });
      await this.audit.log(
        {
          action: 'academic.subject_removed',
          entity: 'ClassSubject',
          entityId: id,
          before: {
            classId: cs.classId,
            subjectId: cs.subjectId,
            coefficient: cs.coefficient,
            teacherId: cs.teacherId,
            weeklyHours: cs.weeklyHours,
          },
        },
        tx,
      );
    });
    return { ok: true };
  }

  /** Copie la structure d'une année (classes, matières, coefficients, enseignants, frais) vers une autre. */
  async rollover(toYearId: string, fromYearId: string) {
    const schoolId = currentSchoolId();
    const [from, to] = await Promise.all([
      this.db.academicYear.findUniqueOrThrow({ where: { id: fromYearId } }),
      this.db.academicYear.findUniqueOrThrow({ where: { id: toYearId } }),
    ]);
    if (from.id === to.id) throw new ConflictException('Choisissez une année différente');
    const already = await this.db.class.count({ where: { academicYearId: to.id } });
    if (already > 0)
      throw new ConflictException('L’année de destination contient déjà des classes');
    return this.db.$transaction(async (tx: Tx) => {
      const classes = await tx.class.findMany({
        where: { academicYearId: from.id },
        include: { subjects: true },
      });
      let subjects = 0;
      for (const c of classes) {
        const created = await tx.class.create({
          data: {
            schoolId,
            academicYearId: to.id,
            levelId: c.levelId,
            name: c.name,
            capacity: c.capacity,
            mainTeacherId: c.mainTeacherId,
          },
        });
        for (const s of c.subjects) {
          await tx.classSubject.create({
            data: {
              schoolId,
              classId: created.id,
              subjectId: s.subjectId,
              coefficient: s.coefficient,
              teacherId: s.teacherId,
              weeklyHours: s.weeklyHours,
            },
          });
          subjects++;
        }
      }
      const fees = await tx.feeItem.findMany({ where: { academicYearId: from.id } });
      for (const f of fees) {
        await tx.feeItem.create({
          data: {
            schoolId,
            academicYearId: to.id,
            name: f.name,
            amount: f.amount,
            dueDate: shiftYear(f.dueDate),
            levelId: f.levelId,
            order: f.order,
          },
        });
      }
      await this.audit.log(
        {
          action: 'academic.rollover',
          entity: 'AcademicYear',
          entityId: to.id,
          after: { fromYearId, classes: classes.length },
        },
        tx,
      );
      return { classes: classes.length, subjects, feeItems: fees.length };
    });
  }

  private async assertTeacher(userId: string) {
    const m = await this.db.membership.findUnique({
      where: { userId_schoolId: { userId, schoolId: currentSchoolId() } },
    });
    if (!m?.active)
      throw new ConflictException('Cet enseignant ne fait pas partie de l’établissement');
    return m;
  }

  /** Contrôle la charge horaire maximale configurée pour l'enseignant. */
  private async assertTeacherLoad(
    teacherId: string,
    academicYearId: string,
    addedHours: number,
    excludeId?: string,
  ) {
    const m = await this.assertTeacher(teacherId);
    if (!m.maxWeeklyHours) return;
    const agg = await this.db.classSubject.aggregate({
      where: {
        teacherId,
        class: { academicYearId },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      _sum: { weeklyHours: true },
    });
    const total = (agg._sum.weeklyHours ?? 0) + addedHours;
    if (total > m.maxWeeklyHours) {
      throw new ConflictException(
        `Charge horaire maximale dépassée : ${total} h pour ${m.maxWeeklyHours} h autorisées`,
      );
    }
  }
}

@ApiTags('academic')
@ApiBearerAuth()
@Controller('academic')
export class AcademicController {
  constructor(private readonly academic: AcademicService) {}

  @RequirePermissions('academic.read')
  @Get('years')
  years() {
    return this.academic.listYears();
  }

  @RequirePermissions('academic.write')
  @Post('years')
  createYear(
    @Body(new ZodPipe(academicYearCreateSchema)) body: z.infer<typeof academicYearCreateSchema>,
  ) {
    return this.academic.createYear(body);
  }

  @RequirePermissions('academic.write')
  @Post('years/:id/current')
  setCurrent(@Param('id') id: string) {
    return this.academic.setCurrentYear(id);
  }

  @RequirePermissions('academic.write')
  @Post('years/:id/close')
  close(@Param('id') id: string) {
    return this.academic.closeYear(id);
  }

  @RequirePermissions('academic.read')
  @Get('years/:id/structure')
  async structure(@Param('id') id: string) {
    const s = await this.academic.structure(id);
    return {
      ...s,
      startDate: fromDbDate(s.startDate),
      endDate: fromDbDate(s.endDate),
      terms: s.terms.map((t) => ({
        ...t,
        startDate: fromDbDate(t.startDate),
        endDate: fromDbDate(t.endDate),
      })),
    };
  }

  @RequirePermissions('academic.write')
  @Post('years/:id/rollover')
  rollover(
    @Param('id') id: string,
    @Body(new ZodPipe(rolloverSchema)) body: z.infer<typeof rolloverSchema>,
  ) {
    return this.academic.rollover(id, body.fromYearId);
  }

  @RequirePermissions('academic.write')
  @Post('terms')
  createTerm(@Body(new ZodPipe(termCreateSchema)) body: z.infer<typeof termCreateSchema>) {
    return this.academic.createTerm(body);
  }

  @RequirePermissions('academic.read')
  @Get('cycles')
  cycles() {
    return this.academic.listCycles();
  }

  @RequirePermissions('academic.write')
  @Post('cycles')
  createCycle(@Body(new ZodPipe(cycleCreateSchema)) body: z.infer<typeof cycleCreateSchema>) {
    return this.academic.createCycle(body);
  }

  @RequirePermissions('academic.write')
  @Post('levels')
  createLevel(@Body(new ZodPipe(levelCreateSchema)) body: z.infer<typeof levelCreateSchema>) {
    return this.academic.createLevel(body);
  }

  @RequirePermissions('academic.read')
  @Get('classes')
  classes(@Query('academicYearId') academicYearId?: string) {
    return this.academic.listClasses(academicYearId);
  }

  @RequirePermissions('academic.write')
  @Post('classes')
  createClass(@Body(new ZodPipe(classCreateSchema)) body: z.infer<typeof classCreateSchema>) {
    return this.academic.createClass(body);
  }

  @RequirePermissions('academic.read')
  @Get('classes/:id')
  classDetail(@Param('id') id: string) {
    return this.academic.classDetail(id);
  }

  @RequirePermissions('academic.read')
  @Get('subjects')
  subjects() {
    return this.academic.listSubjects();
  }

  @RequirePermissions('academic.write')
  @Post('subjects')
  createSubject(@Body(new ZodPipe(subjectCreateSchema)) body: z.infer<typeof subjectCreateSchema>) {
    return this.academic.createSubject(body);
  }

  @RequirePermissions('academic.write')
  @Post('class-subjects')
  assign(
    @Body(new ZodPipe(classSubjectCreateSchema)) body: z.infer<typeof classSubjectCreateSchema>,
  ) {
    return this.academic.assignSubject(body);
  }

  @RequirePermissions('academic.write')
  @Patch('class-subjects/:id')
  updateClassSubject(
    @Param('id') id: string,
    @Body(new ZodPipe(classSubjectUpdateSchema)) body: z.infer<typeof classSubjectUpdateSchema>,
  ) {
    return this.academic.updateClassSubject(id, body);
  }

  @RequirePermissions('academic.write')
  @Delete('class-subjects/:id')
  removeClassSubject(@Param('id') id: string) {
    return this.academic.removeClassSubject(id);
  }
}

@Module({
  controllers: [AcademicController],
  providers: [AcademicService],
  exports: [AcademicService],
})
export class AcademicModule {}
