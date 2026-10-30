import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { evaluationCreateSchema, gradesUpsertSchema } from '@ecole/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { toDbDate } from '../../common/dates';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { computeSheet, compactGrade, toStored } from './grades.compute';

const sheetQuerySchema = z.object({
  classSubjectId: z.string().min(1),
  sequenceId: z.string().min(1),
});
const reopenSchema = sheetQuerySchema.extend({ reason: z.string().trim().min(5).max(300) });

@Injectable()
export class GradesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /** Matières de l'enseignant (ou toutes, pour le censeur), pour l'année en cours. */
  async myClassSubjects(classId?: string) {
    const year = await this.scope.currentYear();
    const teacherOnly = this.scope.isClassScoped('grades.read');
    const rows = await this.db.classSubject.findMany({
      where: {
        class: { academicYearId: year.id, ...(classId ? { id: classId } : {}) },
        ...(teacherOnly ? { teacherId: this.scope.userId() } : {}),
      },
      include: { class: { include: { level: true } }, subject: true },
      orderBy: [
        { class: { level: { order: 'asc' } } },
        { class: { name: 'asc' } },
        { subject: { name: 'asc' } },
      ],
    });
    const sequences = await this.db.sequence.findMany({
      where: { term: { academicYearId: year.id } },
      include: { term: true },
      orderBy: [{ term: { order: 'asc' } }, { order: 'asc' }],
    });
    return {
      classSubjects: rows.map((r) => ({
        id: r.id,
        classId: r.classId,
        className: r.class.name,
        subjectId: r.subjectId,
        subjectName: r.subject.name,
        coefficient: r.coefficient,
        teacherId: r.teacherId,
      })),
      sequences: sequences.map((s) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        termId: s.termId,
        termName: s.term.name,
      })),
    };
  }

  async createEvaluation(input: z.infer<typeof evaluationCreateSchema>) {
    const cs = await this.scope.classSubject(input.classSubjectId, 'grades.write');
    const sequence = await this.db.sequence.findUnique({
      where: { id: input.sequenceId },
      include: { term: true },
    });
    if (!sequence || sequence.term.academicYearId !== cs.class.academicYearId) {
      throw new BadRequestException('Séquence hors de l’année scolaire de la classe');
    }
    await this.assertSheetEditable(input.classSubjectId, input.sequenceId);
    const evaluation = await this.db.evaluation.create({
      data: {
        schoolId: currentSchoolId(),
        classSubjectId: input.classSubjectId,
        sequenceId: input.sequenceId,
        name: input.name,
        type: input.type,
        weight: input.weight,
        maxScore: input.maxScore,
        date: input.date ? toDbDate(input.date) : null,
        createdById: staffContext().userId,
      },
    });
    await this.audit.log({
      action: 'grades.evaluation_created',
      entity: 'Evaluation',
      entityId: evaluation.id,
      after: input,
    });
    return evaluation;
  }

  async deleteEvaluation(id: string) {
    const evaluation = await this.db.evaluation.findUnique({ where: { id } });
    if (!evaluation) throw new NotFoundException('Évaluation introuvable');
    await this.scope.classSubject(evaluation.classSubjectId, 'grades.write');
    if (evaluation.status !== 'DRAFT')
      throw new ConflictException('Seule une évaluation en brouillon peut être supprimée');
    await this.db.evaluation.delete({ where: { id } });
    await this.audit.log({
      action: 'grades.evaluation_deleted',
      entity: 'Evaluation',
      entityId: id,
      before: evaluation,
    });
    return { ok: true };
  }

  async sheet(classSubjectId: string, sequenceId: string) {
    const cs = await this.db.classSubject.findUnique({
      where: { id: classSubjectId },
      include: { class: true, subject: true },
    });
    if (!cs) throw new NotFoundException('Matière de classe introuvable');
    if (this.scope.isClassScoped('grades.read') && cs.teacherId !== this.scope.userId()) {
      throw new ForbiddenException('Vous n’enseignez pas cette matière dans cette classe');
    }
    const sequence = await this.db.sequence.findUniqueOrThrow({
      where: { id: sequenceId },
      include: { term: true },
    });
    const [students, evaluations] = await Promise.all([
      this.scope.classStudents(cs.classId),
      this.db.evaluation.findMany({
        where: { classSubjectId, sequenceId },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    const grades = await this.db.grade.findMany({
      where: { evaluationId: { in: evaluations.map((e) => e.id) } },
    });
    const computed = computeSheet(students, evaluations, grades);
    const statuses = new Set(evaluations.map((e) => e.status));
    const status =
      evaluations.length === 0 ? 'DRAFT' : statuses.size === 1 ? [...statuses][0] : 'MIXED';
    return {
      classSubject: {
        id: cs.id,
        coefficient: cs.coefficient,
        className: cs.class.name,
        classId: cs.classId,
        subjectName: cs.subject.name,
      },
      sequence: { id: sequence.id, name: sequence.name, termName: sequence.term.name },
      status,
      evaluations: evaluations.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        weight: e.weight,
        maxScore: e.maxScore,
        status: e.status,
      })),
      ...computed,
    };
  }

  async upsertGrades(evaluationId: string, rows: z.infer<typeof gradesUpsertSchema>['grades']) {
    const evaluation = await this.db.evaluation.findUnique({ where: { id: evaluationId } });
    if (!evaluation) throw new NotFoundException('Évaluation introuvable');
    const cs = await this.scope.classSubject(evaluation.classSubjectId, 'grades.write');
    const ctx = staffContext();
    if (evaluation.status === 'LOCKED')
      throw new ConflictException('Notes validées : demandez au censeur de rouvrir la grille');
    if (evaluation.status === 'SUBMITTED' && !ctx.permissions.has('grades.validate')) {
      throw new ConflictException('Notes soumises : seule la vie pédagogique peut les corriger');
    }
    const enrolled = new Set((await this.scope.classStudents(cs.classId)).map((s) => s.id));
    const errors: { studentId: string; message: string }[] = [];
    const parsed = rows.map((r) => {
      if (!enrolled.has(r.studentId))
        errors.push({ studentId: r.studentId, message: 'Élève non inscrit dans la classe' });
      const stored = toStored(r.value, evaluation.maxScore);
      if (stored === 'invalid') {
        errors.push({
          studentId: r.studentId,
          message: `Note invalide : entre 0 et ${evaluation.maxScore}, deux décimales au plus`,
        });
      }
      return { studentId: r.studentId, stored };
    });
    if (errors.length > 0) throw new BadRequestException({ message: 'Notes invalides', errors });

    const before = await this.db.grade.findMany({
      where: { evaluationId, studentId: { in: rows.map((r) => r.studentId) } },
    });
    const beforeBy = new Map(before.map((g) => [g.studentId, g]));
    const changes: { studentId: string; before: string; after: string }[] = [];
    await this.db.$transaction(async (tx) => {
      // Écritures groupées : une requête pour les nouvelles notes et une pour les effacements,
      // au lieu d'une requête par élève (une classe compte souvent 50 à 80 élèves).
      const created: Prisma.GradeCreateManyInput[] = [];
      const removed: string[] = [];
      for (const p of parsed) {
        const prev = beforeBy.get(p.studentId);
        if (p.stored === 'invalid') continue;
        if (p.stored === null) {
          if (prev) {
            removed.push(prev.id);
            changes.push({ studentId: p.studentId, before: compactGrade(prev), after: '' });
          }
          continue;
        }
        if (prev && prev.status === p.stored.status && prev.valueCenti === p.stored.valueCenti)
          continue;
        if (prev) {
          await tx.grade.update({
            where: { id: prev.id },
            data: { ...p.stored, updatedById: ctx.userId },
          });
        } else {
          created.push({
            schoolId: currentSchoolId(),
            evaluationId,
            studentId: p.studentId,
            ...p.stored,
            updatedById: ctx.userId,
          });
        }
        changes.push({
          studentId: p.studentId,
          before: compactGrade(prev),
          after: compactGrade(p.stored),
        });
      }
      if (removed.length > 0) await tx.grade.deleteMany({ where: { id: { in: removed } } });
      // Deux enregistrements simultanés de la même grille : le second échoue sur la contrainte
      // d'unicité (409, transaction annulée) et l'enseignant enregistre de nouveau.
      if (created.length > 0) await tx.grade.createMany({ data: created });
      if (changes.length > 0) {
        await this.audit.log(
          {
            action: 'grades.updated',
            entity: 'Evaluation',
            entityId: evaluationId,
            after: { changes },
          },
          tx,
        );
      }
    });
    return { saved: changes.length };
  }

  /** Soumission au censeur : refusée tant qu'une note manque. */
  async submit(classSubjectId: string, sequenceId: string) {
    await this.scope.classSubject(classSubjectId, 'grades.write');
    const sheet = await this.sheet(classSubjectId, sequenceId);
    if (sheet.evaluations.length === 0)
      throw new ConflictException('Aucune évaluation à soumettre');
    if (sheet.missing > 0) {
      const missing = sheet.rows
        .filter((r) => r.cells.some((c) => c.value === ''))
        .map((r) => `${r.student.lastName} ${r.student.firstName}`);
      throw new ConflictException({
        statusCode: 409,
        message: `${sheet.missing} note(s) manquante(s)`,
        missing,
      });
    }
    const updated = await this.db.evaluation.updateMany({
      where: { classSubjectId, sequenceId, status: 'DRAFT' },
      data: { status: 'SUBMITTED' },
    });
    await this.audit.log({
      action: 'grades.submitted',
      entity: 'ClassSubject',
      entityId: classSubjectId,
      after: { sequenceId },
    });
    return { submitted: updated.count };
  }

  async validate(classSubjectId: string, sequenceId: string) {
    const draft = await this.db.evaluation.count({
      where: { classSubjectId, sequenceId, status: 'DRAFT' },
    });
    if (draft > 0) throw new ConflictException('La grille n’a pas encore été soumise');
    const updated = await this.db.evaluation.updateMany({
      where: { classSubjectId, sequenceId, status: 'SUBMITTED' },
      data: { status: 'LOCKED' },
    });
    await this.audit.log({
      action: 'grades.validated',
      entity: 'ClassSubject',
      entityId: classSubjectId,
      after: { sequenceId },
    });
    return { locked: updated.count };
  }

  async reopen(classSubjectId: string, sequenceId: string, reason: string) {
    const updated = await this.db.evaluation.updateMany({
      where: { classSubjectId, sequenceId, status: { in: ['SUBMITTED', 'LOCKED'] } },
      data: { status: 'DRAFT' },
    });
    await this.audit.log({
      action: 'grades.reopened',
      entity: 'ClassSubject',
      entityId: classSubjectId,
      after: { sequenceId },
      reason,
    });
    return { reopened: updated.count };
  }

  /** État de saisie des grilles d'une séquence (suivi du censeur). */
  async progress(sequenceId: string) {
    const year = await this.scope.currentYear();
    const classSubjects = await this.db.classSubject.findMany({
      where: { class: { academicYearId: year.id } },
      include: {
        class: true,
        subject: true,
        evaluations: { where: { sequenceId }, select: { status: true } },
      },
    });
    const users = await this.db.user.findMany({
      where: { id: { in: classSubjects.map((c) => c.teacherId).filter((x): x is string => !!x) } },
      select: { id: true, firstName: true, lastName: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return classSubjects
      .map((c) => {
        const statuses = c.evaluations.map((e) => e.status);
        const status =
          statuses.length === 0
            ? 'EMPTY'
            : statuses.every((s) => s === 'LOCKED')
              ? 'LOCKED'
              : statuses.every((s) => s !== 'DRAFT')
                ? 'SUBMITTED'
                : 'DRAFT';
        const t = c.teacherId ? byId.get(c.teacherId) : undefined;
        return {
          classSubjectId: c.id,
          className: c.class.name,
          subjectName: c.subject.name,
          teacher: t ? `${t.lastName} ${t.firstName}` : null,
          evaluations: statuses.length,
          status,
        };
      })
      .sort(
        (a, b) =>
          a.className.localeCompare(b.className, 'fr') ||
          a.subjectName.localeCompare(b.subjectName, 'fr'),
      );
  }

  private async assertSheetEditable(classSubjectId: string, sequenceId: string) {
    const locked = await this.db.evaluation.count({
      where: { classSubjectId, sequenceId, status: { not: 'DRAFT' } },
    });
    if (locked > 0) throw new ConflictException('La grille de cette séquence a déjà été soumise');
  }
}

@ApiTags('grades')
@ApiBearerAuth()
@RequireModule('grades')
@Controller('grades')
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  @RequirePermissions('grades.read')
  @Get('class-subjects')
  classSubjects(@Query('classId') classId?: string) {
    return this.grades.myClassSubjects(classId);
  }

  @RequirePermissions('grades.write')
  @Post('evaluations')
  createEvaluation(
    @Body(new ZodPipe(evaluationCreateSchema)) body: z.infer<typeof evaluationCreateSchema>,
  ) {
    return this.grades.createEvaluation(body);
  }

  @RequirePermissions('grades.write')
  @Delete('evaluations/:id')
  deleteEvaluation(@Param('id') id: string) {
    return this.grades.deleteEvaluation(id);
  }

  @RequirePermissions('grades.write')
  @Put('evaluations/:id/grades')
  upsert(
    @Param('id') id: string,
    @Body(new ZodPipe(gradesUpsertSchema)) body: z.infer<typeof gradesUpsertSchema>,
  ) {
    return this.grades.upsertGrades(id, body.grades);
  }

  @RequirePermissions('grades.read')
  @Get('sheet')
  sheet(@Query(new ZodPipe(sheetQuerySchema)) q: z.infer<typeof sheetQuerySchema>) {
    return this.grades.sheet(q.classSubjectId, q.sequenceId);
  }

  @RequirePermissions('grades.write')
  @Post('sheet/submit')
  submit(@Body(new ZodPipe(sheetQuerySchema)) body: z.infer<typeof sheetQuerySchema>) {
    return this.grades.submit(body.classSubjectId, body.sequenceId);
  }

  @RequirePermissions('grades.validate')
  @Post('sheet/validate')
  validate(@Body(new ZodPipe(sheetQuerySchema)) body: z.infer<typeof sheetQuerySchema>) {
    return this.grades.validate(body.classSubjectId, body.sequenceId);
  }

  @RequirePermissions('grades.validate')
  @Post('sheet/reopen')
  reopen(@Body(new ZodPipe(reopenSchema)) body: z.infer<typeof reopenSchema>) {
    return this.grades.reopen(body.classSubjectId, body.sequenceId, body.reason);
  }

  @RequirePermissions('grades.validate')
  @Get('progress')
  progress(@Query('sequenceId') sequenceId: string) {
    return this.grades.progress(sequenceId);
  }
}

@Module({ controllers: [GradesController], providers: [GradesService], exports: [GradesService] })
export class GradesModule {}
