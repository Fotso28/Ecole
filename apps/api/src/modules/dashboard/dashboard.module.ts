import { Controller, Get, Injectable, Module, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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

const ACTION_LABELS: Record<string, string> = {
  'finance.payment_received': 'a encaissé un paiement',
  'finance.payment_reversed': 'a annulé un paiement',
  'finance.mobile_money_requested': 'a lancé une demande Mobile Money',
  'grades.submitted': 'a soumis une grille de notes',
  'grades.validated': 'a validé une grille de notes',
  'grades.updated': 'a saisi des notes',
  'attendance.submitted': 'a fait l’appel',
  'students.created': 'a inscrit un élève',
  'students.updated': 'a modifié une fiche élève',
  'reportcards.published': 'a publié des bulletins',
  'reportcards.generated': 'a préparé des bulletins',
  'finance.cash_closed': 'a clôturé sa caisse',
  'academic.subject_updated': 'a modifié une matière de classe',
};

@Injectable()
export class DashboardService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly finance: FinanceService,
  ) {}

  private pendingApprovals() {
    return pendingApprovalsFor(this.db, staffContext());
  }

  async overview() {
    const ctx = staffContext();
    const year = await this.scope.currentYear();
    const today = todayInCameroon();
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = addDays(today, -weekday);
    const canFinance = ctx.permissions.has('finance.read');

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
      this.db.justification.count({ where: { status: 'PENDING' } }),
      canFinance
        ? this.db.payment.count({
            where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 2 * 3600_000) } },
          })
        : Promise.resolve(0),
      // Clôtures que la personne peut approuver : jamais les siennes (contrôle à quatre yeux).
      ctx.permissions.has('finance.cash.approve')
        ? this.db.cashSession.count({
            where: {
              status: 'CLOSED',
              openedById: { not: ctx.userId },
              OR: [{ closedById: null }, { closedById: { not: ctx.userId } }],
            },
          })
        : Promise.resolve(0),
      this.db.evaluation.groupBy({
        by: ['classSubjectId', 'sequenceId'],
        where: { status: 'SUBMITTED' },
      }),
      this.db.reportCard.groupBy({ by: ['classId', 'termId'], where: { status: 'DRAFT' } }),
      this.db.auditLog.findMany({
        where: { schoolId: ctx.schoolId, action: { in: Object.keys(ACTION_LABELS) } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);
    const approvals = await this.pendingApprovals();
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
        ...approvals,
      },
      activity: activity.map((a) => {
        const actor = actors.find((u) => u.id === a.actorId);
        return {
          id: a.id,
          at: a.createdAt,
          actor: actor ? `${actor.lastName} ${actor.firstName.charAt(0)}.` : 'Système',
          label: ACTION_LABELS[a.action] ?? a.action,
          action: a.action,
        };
      }),
    };
  }
}

/**
 * Ce qui attend une seconde personne et que la personne connectée peut traiter : jamais ce
 * qu'elle a saisi elle-même (la validation revient toujours à quelqu'un d'autre).
 */
async function pendingApprovalsFor(db: Db, ctx: ReturnType<typeof staffContext>) {
  const school = await db.school.findUniqueOrThrow({
    where: { id: ctx.schoolId },
    select: { modules: true },
  });
  const accounting =
    school.modules.includes('accounting') && ctx.permissions.has('accounting.write');
  const hr = school.modules.includes('hr');
  const validate = hr && ctx.permissions.has('hr.payroll.validate');
  const pay = hr && ctx.permissions.has('hr.payroll.pay');
  const me = { not: ctx.userId };
  const [expenses, entries, payroll, advances, approved] = await Promise.all([
    accounting ? db.expense.count({ where: { status: 'PENDING_APPROVAL', createdById: me } }) : 0,
    accounting ? db.manualEntryRequest.count({ where: { status: 'PENDING', createdById: me } }) : 0,
    validate
      ? db.payrollRun.count({
          where: {
            status: 'PREPARED',
            computedById: me,
            OR: [{ preparedById: null }, { preparedById: me }],
          },
        })
      : 0,
    validate ? db.salaryAdvance.count({ where: { status: 'REQUESTED', requestedById: me } }) : 0,
    pay
      ? db.salaryAdvance.findMany({
          where: { status: 'APPROVED', decidedById: me },
          select: { id: true },
        })
      : [],
  ]);
  const paidOut = approved.length
    ? await db.staffPayout.count({
        where: { kind: 'ADVANCE', sourceId: { in: approved.map((a) => a.id) } },
      })
    : 0;
  return {
    expensesToApprove: expenses,
    entriesToApprove: entries,
    payrollToValidate: payroll,
    advancesToDecide: advances,
    advancesToPay: approved.length - paidOut,
  };
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
