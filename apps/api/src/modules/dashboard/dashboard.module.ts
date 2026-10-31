import { Controller, Get, Injectable, Module, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Permission } from '@ecole/shared';
import type { Response } from 'express';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { addDays, todayInCameroon, toDbDate } from '../../common/dates';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { FinanceModule } from '../finance/finance.module';
import { FinanceService } from '../finance/finance.service';
import { indicatorsPdf, indicatorsWorkbook, type IndicatorsExport } from './exports';
import { ResultsService } from './results.service';

/** Actions montrées dans « Activité récente », et la permission nécessaire pour les voir. */
const ACTIVITY: Record<string, { label: string; permission: Permission }> = {
  'finance.payment_received': { label: 'a encaissé un paiement', permission: 'finance.read' },
  'finance.payment_reversed': { label: 'a annulé un paiement', permission: 'finance.read' },
  'finance.mobile_money_requested': {
    label: 'a lancé une demande Mobile Money',
    permission: 'finance.read',
  },
  'finance.cash_closed': { label: 'a clôturé sa caisse', permission: 'finance.read' },
  'grades.submitted': { label: 'a soumis une grille de notes', permission: 'grades.read' },
  'grades.validated': { label: 'a validé une grille de notes', permission: 'grades.read' },
  'grades.updated': { label: 'a saisi des notes', permission: 'grades.read' },
  'attendance.submitted': { label: 'a fait l’appel', permission: 'attendance.read' },
  'students.created': { label: 'a inscrit un élève', permission: 'students.read' },
  'students.updated': { label: 'a modifié une fiche élève', permission: 'students.read' },
  'enrollments.class_changed': {
    label: 'a changé un élève de classe',
    permission: 'students.read',
  },
  'enrollments.transferred': {
    label: 'a enregistré le transfert d’un élève',
    permission: 'students.read',
  },
  'enrollments.left': { label: 'a enregistré la sortie d’un élève', permission: 'students.read' },
  'enrollments.reinstated': { label: 'a réintégré un élève', permission: 'students.read' },
  'reportcards.published': { label: 'a publié des bulletins', permission: 'reportcards.read' },
  'reportcards.generated': { label: 'a préparé des bulletins', permission: 'reportcards.read' },
  'academic.subject_updated': {
    label: 'a modifié une matière de classe',
    permission: 'academic.read',
  },
};

/** Actions que la personne a le droit de voir (le surveillant ne voit pas la caisse). */
export function visibleActivity(permissions: ReadonlySet<Permission>): string[] {
  return Object.entries(ACTIVITY)
    .filter(([, a]) => permissions.has(a.permission))
    .map(([action]) => action);
}

@Injectable()
export class DashboardService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly finance: FinanceService,
  ) {}

  async overview() {
    const ctx = staffContext();
    const year = await this.scope.currentYear();
    const today = todayInCameroon();
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = addDays(today, -weekday);
    const canFinance = ctx.permissions.has('finance.read');
    const can = (p: Permission) => ctx.permissions.has(p);
    const none = Promise.resolve(0);

    const [
      byGender,
      previousYear,
      weekAbsences,
      pendingJustifications,
      pendingMobile,
      cashToApprove,
      submittedSheets,
      draftCards,
      activity,
    ] = await Promise.all([
      this.db.student.groupBy({
        by: ['gender'],
        where: {
          deletedAt: null,
          enrollments: {
            some: { academicYearId: year.id, status: { in: ['ENROLLED', 'REPEATING'] } },
          },
        },
        _count: { _all: true },
      }),
      this.db.academicYear.findFirst({
        where: { startDate: { lt: year.startDate } },
        orderBy: { startDate: 'desc' },
      }),
      this.db.attendanceRecord.findMany({
        where: {
          status: 'ABSENT',
          session: { date: { gte: toDbDate(monday), lte: toDbDate(today) } },
        },
        select: { studentId: true, justification: { select: { status: true } } },
      }),
      // Tâches : seulement celles que la personne peut traiter.
      can('attendance.justify')
        ? this.db.justification.count({ where: { status: 'PENDING' } })
        : none,
      canFinance
        ? this.db.payment.count({
            where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 2 * 3600_000) } },
          })
        : none,
      can('finance.cash.approve')
        ? this.db.cashSession.count({ where: { status: 'CLOSED' } })
        : none,
      can('grades.validate')
        ? this.db.evaluation.groupBy({
            by: ['classSubjectId', 'sequenceId'],
            where: { status: 'SUBMITTED' },
          })
        : Promise.resolve([]),
      can('reportcards.publish')
        ? this.db.reportCard.groupBy({ by: ['classId', 'termId'], where: { status: 'DRAFT' } })
        : Promise.resolve([]),
      this.db.auditLog.findMany({
        where: { schoolId: ctx.schoolId, action: { in: visibleActivity(ctx.permissions) } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);
    const previousCount = previousYear
      ? await this.db.enrollment.count({
          where: { academicYearId: previousYear.id, status: { in: ['ENROLLED', 'REPEATING'] } },
        })
      : null;
    const actors = await this.db.user.findMany({
      where: { id: { in: activity.map((a) => a.actorId).filter((x): x is string => !!x) } },
      select: { id: true, firstName: true, lastName: true },
    });
    const total = byGender.reduce((s, g) => s + g._count._all, 0);
    const unjustified = weekAbsences.filter((a) => a.justification?.status !== 'ACCEPTED');
    const perStudent = new Map<string, number>();
    for (const a of unjustified)
      perStudent.set(a.studentId, (perStudent.get(a.studentId) ?? 0) + 1);

    const finance = canFinance
      ? await Promise.all([
          this.finance.summary(year.id),
          this.finance.weeklyCollections(9),
          this.finance.unpaid(year.id),
        ]).then(([summary, weekly, unpaid]) => ({
          ...summary,
          weekly,
          worstClasses: unpaid.classes.slice(0, 5),
        }))
      : null;

    return {
      year: { id: year.id, name: year.name },
      today,
      enrollment: {
        total,
        girls: byGender.find((g) => g.gender === 'F')?._count._all ?? 0,
        boys: byGender.find((g) => g.gender === 'M')?._count._all ?? 0,
        changeFromPreviousYear: previousCount === null ? null : total - previousCount,
      },
      attendance: {
        unjustifiedThisWeek: unjustified.length,
        studentsAboveThreshold: [...perStudent.values()].filter((n) => n >= 3).length,
      },
      finance,
      todo: {
        pendingJustifications,
        pendingMobileMoney: pendingMobile,
        cashSessionsToApprove: cashToApprove,
        gradeSheetsToValidate: submittedSheets.length,
        reportCardBatchesToPublish: draftCards.length,
      },
      activity: activity.map((a) => {
        const actor = actors.find((u) => u.id === a.actorId);
        return {
          id: a.id,
          at: a.createdAt,
          actor: actor ? `${actor.lastName} ${actor.firstName.charAt(0)}.` : 'Système',
          label: ACTIVITY[a.action]?.label ?? a.action,
          action: a.action,
        };
      }),
    };
  }
}

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly results: ResultsService,
    private readonly audit: AuditService,
    @InjectDb() private readonly db: Db,
  ) {}

  @RequirePermissions('dashboard.read')
  @Get()
  overview() {
    return this.dashboard.overview();
  }

  /** Taux de réussite par classe, par trimestre et sur l'année. */
  @RequirePermissions('dashboard.read', 'reportcards.read')
  @Get('results')
  passRates() {
    return this.results.indicators();
  }

  @RequirePermissions('dashboard.read')
  @Get('export.xlsx')
  async excel(@Res() res: Response) {
    const data = await this.exportData('xlsx');
    res.setHeader(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'content-disposition',
      `attachment; filename="indicateurs-${data.overview.year.name}.xlsx"`,
    );
    res.send(await indicatorsWorkbook(data));
  }

  @RequirePermissions('dashboard.read')
  @Get('export.pdf')
  async pdf(@Res() res: Response) {
    const data = await this.exportData('pdf');
    res.setHeader('content-type', 'application/pdf');
    res.setHeader(
      'content-disposition',
      `inline; filename="indicateurs-${data.overview.year.name}.pdf"`,
    );
    res.send(await indicatorsPdf(data));
  }

  /** Mêmes indicateurs que l'écran : finances et résultats selon les permissions. */
  private async exportData(format: 'xlsx' | 'pdf'): Promise<IndicatorsExport> {
    const ctx = staffContext();
    const [overview, results, school] = await Promise.all([
      this.dashboard.overview(),
      ctx.permissions.has('reportcards.read') ? this.results.indicators() : Promise.resolve(null),
      this.db.school.findUniqueOrThrow({
        where: { id: currentSchoolId() },
        select: { name: true },
      }),
    ]);
    await this.audit.log({
      action: 'dashboard.exported',
      entity: 'School',
      entityId: ctx.schoolId,
      after: { format, finance: !!overview.finance, results: !!results },
    });
    return { school: school.name, overview, results, generatedAt: new Date() };
  }
}

@Module({
  imports: [FinanceModule],
  controllers: [DashboardController],
  providers: [DashboardService, ResultsService],
})
export class DashboardModule {}
