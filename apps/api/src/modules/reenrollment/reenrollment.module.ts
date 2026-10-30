import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  reenrollmentSchema,
  suggestPromotionClass,
  suggestReenrollment,
  suggestRepeatClass,
  type ClassRef,
} from '@ecole/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { ScopeService } from '../../common/scope.service';
import { currentSchoolId } from '../../common/context';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { FinanceModule } from '../finance/finance.module';
import { FinanceService } from '../finance/finance.service';

const previewSchema = z.object({ fromYearId: z.string().min(1) });

/** Réinscription en masse d'une année vers la suivante : admis, redoublants, sortants. */
@Injectable()
export class ReenrollmentService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly finance: FinanceService,
    private readonly scope: ScopeService,
  ) {}

  private async years(toYearId: string, fromYearId: string) {
    if (toYearId === fromYearId)
      throw new BadRequestException('Choisissez deux années différentes');
    const [from, to] = await Promise.all([
      this.db.academicYear.findUnique({
        where: { id: fromYearId },
        include: { terms: { orderBy: { order: 'desc' } } },
      }),
      this.db.academicYear.findUnique({ where: { id: toYearId } }),
    ]);
    if (!from || !to) throw new BadRequestException('Année scolaire introuvable');
    return { from, to };
  }

  private async classRefs(academicYearId: string) {
    const classes = await this.db.class.findMany({
      where: { academicYearId },
      include: { level: true },
      orderBy: [{ level: { order: 'asc' } }, { name: 'asc' }],
    });
    return classes.map((c) => ({
      id: c.id,
      name: c.name,
      levelId: c.levelId,
      levelName: c.level.name,
      levelOrder: c.level.order,
      capacity: c.capacity,
    }));
  }

  /**
   * Préparation : élèves de chaque classe de l'année précédente, décision du conseil la plus
   * récente (valeur brute, éventuellement inconnue) et proposition qui en découle.
   */
  async preview(toYearId: string, fromYearId: string) {
    const { from, to } = await this.years(toYearId, fromYearId);
    const [sources, targets] = await Promise.all([this.classRefs(from.id), this.classRefs(to.id)]);
    const enrollments = await this.db.enrollment.findMany({
      where: {
        academicYearId: from.id,
        status: { in: ['ENROLLED', 'REPEATING'] },
        student: { deletedAt: null },
      },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, matricule: true } },
      },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    });
    const studentIds = enrollments.map((e) => e.studentId);
    // Lecture brute : d'autres types de décision peuvent exister sans que ce module les connaisse.
    // La décision de fin d'année (dernier trimestre) prime sur la mention trimestrielle.
    const decisions = await this.db.councilDecision.findMany({
      where: { studentId: { in: studentIds }, termId: { in: from.terms.map((t) => t.id) } },
      select: {
        studentId: true,
        termId: true,
        decision: true,
        yearEndDecision: true,
        comment: true,
      },
    });
    const termOrder = new Map(from.terms.map((t) => [t.id, t.order]));
    const latest = new Map<string, { decision: string; comment: string | null }>();
    for (const d of [...decisions].sort(
      (a, b) => (termOrder.get(a.termId) ?? 0) - (termOrder.get(b.termId) ?? 0),
    ))
      latest.set(d.studentId, {
        decision: String(d.yearEndDecision ?? d.decision),
        comment: d.comment,
      });
    const already = await this.db.enrollment.findMany({
      where: { academicYearId: to.id, studentId: { in: studentIds } },
      select: { studentId: true, status: true, classId: true },
    });
    return {
      fromYear: { id: from.id, name: from.name },
      toYear: { id: to.id, name: to.name },
      targetClasses: targets.map((t) => ({
        id: t.id,
        name: t.name,
        levelName: t.levelName,
        capacity: t.capacity,
      })),
      classes: sources.map((c) => {
        const ref: ClassRef = c;
        return {
          id: c.id,
          name: c.name,
          levelName: c.levelName,
          promotionClassId: suggestPromotionClass(ref, targets),
          repeatClassId: suggestRepeatClass(ref, targets),
          students: enrollments
            .filter((e) => e.classId === c.id)
            .map((e) => {
              const decision = latest.get(e.studentId) ?? null;
              const done = already.find((a) => a.studentId === e.studentId) ?? null;
              return {
                id: e.studentId,
                enrollmentId: e.id,
                firstName: e.student.firstName,
                lastName: e.student.lastName,
                matricule: e.student.matricule,
                status: e.status,
                councilDecision: decision?.decision ?? null,
                councilComment: decision?.comment ?? null,
                suggestion: suggestReenrollment(decision?.decision),
                reenrolled: done ? { classId: done.classId, status: done.status } : null,
              };
            }),
        };
      }),
    };
  }

  async apply(toYearId: string, input: z.infer<typeof reenrollmentSchema>) {
    const { from, to } = await this.years(toYearId, input.fromYearId);
    await this.scope.assertYearOpen(to.id);
    const studentIds = input.items.map((i) => i.studentId);
    if (new Set(studentIds).size !== studentIds.length)
      throw new BadRequestException('Un élève figure deux fois dans la liste');
    const [targets, sources, already, students] = await Promise.all([
      this.db.class.findMany({
        where: { academicYearId: to.id },
        select: { id: true, levelId: true },
      }),
      this.db.enrollment.findMany({
        where: { academicYearId: from.id, studentId: { in: studentIds } },
        select: { id: true, studentId: true },
      }),
      this.db.enrollment.findMany({
        where: { academicYearId: to.id, studentId: { in: studentIds } },
        select: { studentId: true },
      }),
      this.db.student.findMany({
        where: { id: { in: studentIds }, deletedAt: null },
        select: { id: true },
      }),
    ]);
    for (const item of input.items)
      if (item.classId && !targets.some((t) => t.id === item.classId))
        throw new BadRequestException('Classe d’arrivée inconnue pour l’année de destination');
    const fees = await this.db.feeItem.findMany({
      where: { academicYearId: to.id },
      select: { levelId: true },
    });
    const hasFees = (levelId: string) =>
      fees.some((f) => f.levelId === null || f.levelId === levelId);

    const skipped: { studentId: string; reason: string }[] = [];
    const result = { promoted: 0, repeating: 0, left: 0 };
    await this.db.$transaction(
      async (tx: Tx) => {
        for (const item of input.items) {
          const source = sources.find((s) => s.studentId === item.studentId);
          if (!source || !students.some((s) => s.id === item.studentId)) {
            skipped.push({
              studentId: item.studentId,
              reason: 'Élève non inscrit l’année précédente',
            });
            continue;
          }
          if (already.some((a) => a.studentId === item.studentId)) {
            skipped.push({
              studentId: item.studentId,
              reason: 'Déjà inscrit pour la nouvelle année',
            });
            continue;
          }
          if (item.decision === 'LEFT') {
            result.left++;
            continue;
          }
          const target = targets.find((t) => t.id === item.classId);
          if (!target) continue;
          await tx.enrollment.create({
            data: {
              schoolId: currentSchoolId(),
              studentId: item.studentId,
              classId: target.id,
              academicYearId: to.id,
              status: item.decision === 'REPEATING' ? 'REPEATING' : 'ENROLLED',
              previousEnrollmentId: source.id,
            },
          });
          if (hasFees(target.levelId))
            await this.finance.generateInvoice(item.studentId, to.id, [], tx);
          if (item.decision === 'REPEATING') result.repeating++;
          else result.promoted++;
        }
        await this.audit.log(
          {
            action: 'enrollments.reenrolled',
            entity: 'AcademicYear',
            entityId: to.id,
            after: {
              fromYearId: from.id,
              ...result,
              skipped: skipped.length,
              decisions: input.items.map((i) => ({
                studentId: i.studentId,
                decision: i.decision,
                classId: i.classId ?? null,
              })),
            },
          },
          tx,
        );
      },
      { timeout: 60_000 },
    );
    return { ...result, skipped };
  }
}

@ApiTags('reenrollment')
@ApiBearerAuth()
@RequireModule('students')
@Controller('reenrollment')
export class ReenrollmentController {
  constructor(private readonly reenrollment: ReenrollmentService) {}

  @RequirePermissions('enrollments.write', 'academic.read')
  @Get(':toYearId')
  preview(
    @Param('toYearId') toYearId: string,
    @Query(new ZodPipe(previewSchema)) q: z.infer<typeof previewSchema>,
  ) {
    return this.reenrollment.preview(toYearId, q.fromYearId);
  }

  @RequirePermissions('enrollments.write')
  @Post(':toYearId')
  apply(
    @Param('toYearId') toYearId: string,
    @Body(new ZodPipe(reenrollmentSchema)) body: z.infer<typeof reenrollmentSchema>,
  ) {
    return this.reenrollment.apply(toYearId, body);
  }
}

@Module({
  imports: [FinanceModule],
  controllers: [ReenrollmentController],
  providers: [ReenrollmentService],
})
export class ReenrollmentModule {}
