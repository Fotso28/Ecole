import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { formatGrade, justificationCreateSchema, portalPaymentSchema } from '@ecole/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { parentContext, runAsSystem } from '../../common/context';
import { fromDbDate } from '../../common/dates';
import { ParentRoute } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { AttendanceModule, AttendanceService } from '../attendance/attendance.module';
import { FinanceModule } from '../finance/finance.module';
import { FinanceService } from '../finance/finance.service';
import { toParsed } from '../grades/grades.compute';
import { PdfModule } from '../pdf/pdf.module';
import { PdfService } from '../pdf/pdf.service';
import type { ReportCardData } from '../report-cards/report-cards.service';

/**
 * Portail parent : un compte global (téléphone) relié aux dossiers de ses enfants dans
 * plusieurs écoles. Chaque accès vérifie d'abord le lien parent-enfant, puis lit les
 * données avec les droits système limités à l'école de l'enfant.
 */
/** Le portail ne montre que les élèves d'établissements actifs ayant activé le module portail. */
const VISIBLE_STUDENT = {
  deletedAt: null,
  school: { status: 'ACTIVE', modules: { has: 'portal' } },
} satisfies Prisma.StudentWhereInput;

@Injectable()
export class PortalService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly finance: FinanceService,
    private readonly attendance: AttendanceService,
    private readonly pdf: PdfService,
  ) {}

  private async childLink(studentId: string) {
    const userId = parentContext().userId;
    const link = await runAsSystem('portal-link', () =>
      this.db.studentGuardian.findFirst({
        where: { studentId, guardian: { userId }, student: VISIBLE_STUDENT },
        include: { student: { include: { school: { select: { modules: true } } } } },
      }),
    );
    if (!link) throw new NotFoundException('Enfant introuvable');
    return link;
  }

  async children() {
    const userId = parentContext().userId;
    const links = await runAsSystem('portal-children', () =>
      this.db.studentGuardian.findMany({
        where: { guardian: { userId }, student: VISIBLE_STUDENT },
        include: {
          student: {
            include: {
              school: { select: { id: true, name: true, city: true } },
              enrollments: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                include: { class: { select: { name: true } } },
              },
            },
          },
        },
      }),
    );
    const result = [];
    for (const l of links) {
      const account = await runAsSystem(
        'portal-account',
        () => this.finance.account(l.studentId),
        l.schoolId,
      );
      result.push({
        id: l.student.id,
        firstName: l.student.firstName,
        lastName: l.student.lastName,
        matricule: l.student.matricule,
        school: l.student.school,
        className: l.student.enrollments[0]?.class.name ?? null,
        balance: account.totals.outstanding,
        overdue: account.totals.overdue,
        nextDue: account.nextDue,
      });
    }
    return result;
  }

  async overview(studentId: string) {
    const link = await this.childLink(studentId);
    const schoolId = link.schoolId;
    return runAsSystem(
      'portal-overview',
      async () => {
        const enrollment = await this.db.enrollment.findFirst({
          where: { studentId },
          orderBy: { createdAt: 'desc' },
          include: { class: { include: { level: true } } },
        });
        const [account, grades, absences, reportCards, announcements] = await Promise.all([
          this.finance.account(studentId),
          this.db.grade.findMany({
            where: { studentId, evaluation: { status: { in: ['SUBMITTED', 'LOCKED'] } } },
            orderBy: { updatedAt: 'desc' },
            take: 8,
            include: {
              evaluation: {
                include: { classSubject: { include: { subject: true } }, sequence: true },
              },
            },
          }),
          this.db.attendanceRecord.findMany({
            where: { studentId, status: { in: ['ABSENT', 'LATE'] } },
            include: { session: true, justification: { select: { status: true } } },
            orderBy: { session: { date: 'desc' } },
            take: 20,
          }),
          this.db.reportCard.findMany({
            where: { studentId, status: 'PUBLISHED' },
            orderBy: { publishedAt: 'desc' },
            select: {
              id: true,
              version: true,
              generalAverageCenti: true,
              rank: true,
              classSize: true,
              publishedAt: true,
              data: true,
            },
          }),
          this.db.announcement.findMany({
            where: {
              OR: [
                { scope: 'SCHOOL' },
                { scope: 'STUDENTS', studentIds: { has: studentId } },
                ...(enrollment
                  ? [
                      { scope: 'CLASS' as const, targetId: enrollment.classId },
                      { scope: 'LEVEL' as const, targetId: enrollment.class.levelId },
                      { scope: 'CYCLE' as const, targetId: enrollment.class.level.cycleId },
                    ]
                  : []),
              ],
            },
            orderBy: { publishedAt: 'desc' },
            take: 5,
          }),
        ]);
        return {
          student: {
            id: link.student.id,
            firstName: link.student.firstName,
            lastName: link.student.lastName,
            matricule: link.student.matricule,
          },
          className: enrollment?.class.name ?? null,
          finance: {
            totals: account.totals,
            nextDue: account.nextDue,
            lines: account.lines,
            payments: account.payments.slice(0, 10),
          },
          grades: grades.map((g) => {
            const parsed = toParsed(g);
            return {
              id: g.id,
              subject: g.evaluation.classSubject.subject.name,
              evaluation: g.evaluation.name,
              sequence: g.evaluation.sequence.name,
              maxScore: g.evaluation.maxScore,
              value:
                parsed.kind === 'score'
                  ? formatGrade(parsed.centi)
                  : parsed.kind === 'absent'
                    ? 'Absent'
                    : parsed.kind === 'exempt'
                      ? 'Dispensé'
                      : '—',
            };
          }),
          absences: absences.map((r) => ({
            id: r.id,
            date: fromDbDate(r.session.date),
            startTime: r.session.startTime,
            endTime: r.session.endTime,
            status: r.status,
            justification: r.justification?.status ?? null,
          })),
          reportCards: reportCards.map((r) => ({
            id: r.id,
            term: (r.data as unknown as ReportCardData).term.name,
            version: r.version,
            generalAverageCenti: r.generalAverageCenti,
            rank: r.rank,
            classSize: r.classSize,
            publishedAt: r.publishedAt,
          })),
          announcements: announcements.map((a) => ({
            id: a.id,
            title: a.title,
            body: a.body,
            publishedAt: a.publishedAt,
          })),
        };
      },
      schoolId,
    );
  }

  async justify(input: z.infer<typeof justificationCreateSchema>) {
    const link = await this.childLink(input.studentId);
    const userId = parentContext().userId;
    return runAsSystem(
      'portal-justify',
      () => this.attendance.createJustification(input, userId),
      link.schoolId,
    );
  }

  async pay(input: z.infer<typeof portalPaymentSchema>) {
    const link = await this.childLink(input.studentId);
    if (!link.student.school.modules.includes('finance'))
      throw new ForbiddenException('Le paiement en ligne n’est pas activé par cet établissement');
    const userId = parentContext().userId;
    return runAsSystem(
      'portal-payment',
      () => this.finance.createPayment({ ...input }, { initiatedByUserId: userId }),
      link.schoolId,
    );
  }

  async payment(paymentId: string) {
    const userId = parentContext().userId;
    const payment = await runAsSystem('portal-payment-lookup', () =>
      this.db.payment.findUnique({ where: { id: paymentId }, include: { receipt: true } }),
    );
    if (!payment) throw new NotFoundException('Paiement introuvable');
    await this.childLink(payment.studentId);
    if (payment.initiatedByUserId && payment.initiatedByUserId !== userId)
      throw new ForbiddenException();
    const balance = await runAsSystem(
      'portal-balance',
      () => this.finance.account(payment.studentId),
      payment.schoolId,
    );
    return { ...this.finance.presentPayment(payment), balance: balance.totals.outstanding };
  }

  async reportCardPdf(reportCardId: string): Promise<Buffer> {
    const card = await runAsSystem('portal-report-card', () =>
      this.db.reportCard.findUnique({ where: { id: reportCardId } }),
    );
    if (!card || card.status !== 'PUBLISHED') throw new NotFoundException('Bulletin introuvable');
    await this.childLink(card.studentId);
    return runAsSystem('portal-report-card-pdf', () => this.pdf.reportCard(card.id), card.schoolId);
  }

  async receiptPdf(paymentId: string): Promise<Buffer> {
    const payment = await runAsSystem('portal-receipt', () =>
      this.db.payment.findUnique({ where: { id: paymentId } }),
    );
    if (!payment) throw new NotFoundException('Reçu introuvable');
    await this.childLink(payment.studentId);
    return runAsSystem('portal-receipt-pdf', () => this.pdf.receipt(payment.id), payment.schoolId);
  }
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @ParentRoute()
  @Get('children')
  children() {
    return this.portal.children();
  }

  @ParentRoute()
  @Get('children/:id')
  overview(@Param('id') id: string) {
    return this.portal.overview(id);
  }

  @ParentRoute()
  @Post('justifications')
  justify(
    @Body(new ZodPipe(justificationCreateSchema)) body: z.infer<typeof justificationCreateSchema>,
  ) {
    return this.portal.justify(body);
  }

  @ParentRoute()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('payments')
  pay(@Body(new ZodPipe(portalPaymentSchema)) body: z.infer<typeof portalPaymentSchema>) {
    return this.portal.pay(body);
  }

  @ParentRoute()
  @Get('payments/:id')
  payment(@Param('id') id: string) {
    return this.portal.payment(id);
  }

  @ParentRoute()
  @Get('payments/:id/receipt.pdf')
  async receipt(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('content-type', 'application/pdf');
    res.send(await this.portal.receiptPdf(id));
  }

  @ParentRoute()
  @Get('report-cards/:id/pdf')
  async reportCard(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('content-type', 'application/pdf');
    res.send(await this.portal.reportCardPdf(id));
  }
}

@Module({
  imports: [FinanceModule, AttendanceModule, PdfModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
