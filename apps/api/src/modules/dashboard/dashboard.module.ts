import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { staffContext } from '../../common/context';
import { addDays, todayInCameroon, toDbDate } from '../../common/dates';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { FinanceModule } from '../finance/finance.module';
import { FinanceService } from '../finance/finance.service';

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

  async overview() {
    const ctx = staffContext();
    const year = await this.scope.currentYear();
    const today = todayInCameroon();
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = addDays(today, -weekday);
    const canFinance = ctx.permissions.has('finance.read');

    const [byGender, previousYear, weekAbsences, pendingJustifications, pendingMobile, cashToApprove, submittedSheets, draftCards, activity] = await Promise.all([
      this.db.student.groupBy({
        by: ['gender'],
        where: { deletedAt: null, enrollments: { some: { academicYearId: year.id, status: { in: ['ENROLLED', 'REPEATING'] } } } },
        _count: { _all: true },
      }),
      this.db.academicYear.findFirst({ where: { startDate: { lt: year.startDate } }, orderBy: { startDate: 'desc' } }),
      this.db.attendanceRecord.findMany({
        where: { status: 'ABSENT', session: { date: { gte: toDbDate(monday), lte: toDbDate(today) } } },
        select: { studentId: true, justification: { select: { status: true } } },
      }),
      this.db.justification.count({ where: { status: 'PENDING' } }),
      canFinance
        ? this.db.payment.count({ where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 2 * 3600_000) } } })
        : Promise.resolve(0),
      canFinance ? this.db.cashSession.count({ where: { status: 'CLOSED' } }) : Promise.resolve(0),
      this.db.evaluation.groupBy({ by: ['classSubjectId', 'sequenceId'], where: { status: 'SUBMITTED' } }),
      this.db.reportCard.groupBy({ by: ['classId', 'termId'], where: { status: 'DRAFT' } }),
      this.db.auditLog.findMany({
        where: { schoolId: ctx.schoolId, action: { in: Object.keys(ACTION_LABELS) } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);
    const previousCount = previousYear
      ? await this.db.enrollment.count({ where: { academicYearId: previousYear.id, status: { in: ['ENROLLED', 'REPEATING'] } } })
      : null;
    const actors = await this.db.user.findMany({
      where: { id: { in: activity.map((a) => a.actorId).filter((x): x is string => !!x) } },
      select: { id: true, firstName: true, lastName: true },
    });
    const total = byGender.reduce((s, g) => s + g._count._all, 0);
    const unjustified = weekAbsences.filter((a) => a.justification?.status !== 'ACCEPTED');
    const perStudent = new Map<string, number>();
    for (const a of unjustified) perStudent.set(a.studentId, (perStudent.get(a.studentId) ?? 0) + 1);

    const finance = canFinance
      ? await Promise.all([this.finance.summary(year.id), this.finance.weeklyCollections(9), this.finance.unpaid(year.id)]).then(([summary, weekly, unpaid]) => ({
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
          label: ACTION_LABELS[a.action] ?? a.action,
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
  constructor(private readonly dashboard: DashboardService) {}

  @RequirePermissions('dashboard.read')
  @Get()
  overview() {
    return this.dashboard.overview();
  }
}

@Module({ imports: [FinanceModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
