import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  addIsoDays,
  canBorrow,
  daysLate,
  latePenalty,
  librarySettings,
  reminderDue,
  renewal,
  type LibrarySettings,
  libraryBookSchema,
  libraryLoanSchema,
  libraryReturnSchema,
} from '@ecole/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId, runAsSystem } from '../../common/context';
import { CountersService } from '../../common/counters.service';
import { fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';

export const LIBRARY_REMINDER_TEMPLATE = 'libraryOverdue';

export const libraryTemplates = {
  overdue: (p: { school: string; student: string; title: string; dueDate: string }) =>
    `${p.school} : ${p.student} n'a pas rendu « ${p.title} » à la bibliothèque (retour prévu le ${p.dueDate}). Merci de le rapporter rapidement.`,
};

type BookInput = z.infer<typeof libraryBookSchema>;
type LoanInput = z.infer<typeof libraryLoanSchema>;
type ReturnInput = z.infer<typeof libraryReturnSchema>;

export type LoanFilter = 'active' | 'overdue' | 'history';

const loanInclude = {
  copy: { include: { book: { select: { id: true, title: true, authors: true } } } },
} satisfies Prisma.LibraryLoanInclude;
type LoanRow = Prisma.LibraryLoanGetPayload<{ include: typeof loanInclude }>;

/** Bibliothèque : catalogue, exemplaires, prêts, retards et pénalités. */
@Injectable()
export class LibraryService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
    private readonly scope: ScopeService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- Réglages

  async settings(tx?: Tx): Promise<LibrarySettings> {
    const school = await (tx ?? this.db).school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { settings: true },
    });
    return librarySettings((school.settings as { library?: Partial<LibrarySettings> }).library);
  }

  async updateSettings(input: LibrarySettings) {
    const schoolId = currentSchoolId();
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { settings: true },
    });
    const before = (school.settings ?? {}) as Record<string, unknown>;
    await this.db.school.update({
      where: { id: schoolId },
      data: { settings: { ...before, library: { ...input } } as Prisma.InputJsonValue },
    });
    await this.audit.log({
      action: 'library.settings_updated',
      entity: 'School',
      entityId: schoolId,
      before: before.library ?? null,
      after: input,
    });
    return input;
  }

  // ---------------------------------------------------------------- Catalogue

  async books(q: { search?: string; page: number; pageSize: number }) {
    const search = q.search?.trim();
    const where: Prisma.LibraryBookWhereInput = search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { authors: { has: search } },
            { isbn: { contains: search.replace(/[-\s]/g, '') } },
            { callNumber: { contains: search, mode: 'insensitive' } },
            { copies: { some: { code: { equals: search.toUpperCase() } } } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      this.db.libraryBook.count({ where }),
      this.db.libraryBook.findMany({
        where,
        include: { copies: { select: { id: true, code: true, status: true } } },
        orderBy: { title: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((b) => ({
        id: b.id,
        title: b.title,
        authors: b.authors,
        isbn: b.isbn,
        callNumber: b.callNumber,
        publisher: b.publisher,
        copies: b.copies.sort((x, y) => x.code.localeCompare(y.code)),
        available: b.copies.filter((c) => c.status === 'AVAILABLE').length,
      })),
    };
  }

  private async createCopies(tx: Tx, bookId: string, count: number) {
    const schoolId = currentSchoolId();
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const n = await this.counters.next('library-copy', tx);
      const code = `BIB-${String(n).padStart(5, '0')}`;
      await tx.libraryCopy.create({ data: { schoolId, bookId, code } });
      codes.push(code);
    }
    return codes;
  }

  async createBook(input: BookInput) {
    if (input.isbn && (await this.db.libraryBook.findFirst({ where: { isbn: input.isbn } })))
      throw new ConflictException(
        'Ce livre figure déjà au catalogue : ajoutez-lui des exemplaires',
      );
    return this.db.$transaction(async (tx) => {
      const book = await tx.libraryBook.create({
        data: {
          schoolId: currentSchoolId(),
          title: input.title,
          authors: input.authors,
          isbn: input.isbn ?? null,
          callNumber: input.callNumber || null,
          publisher: input.publisher || null,
        },
      });
      const codes = await this.createCopies(tx, book.id, input.copies);
      await this.audit.log(
        { action: 'library.book_created', entity: 'LibraryBook', entityId: book.id, after: input },
        tx,
      );
      return { ...book, codes };
    });
  }

  async addCopies(bookId: string, count: number) {
    const book = await this.db.libraryBook.findUnique({ where: { id: bookId } });
    if (!book) throw new NotFoundException('Livre introuvable');
    return this.db.$transaction(async (tx) => {
      const codes = await this.createCopies(tx, bookId, count);
      await this.audit.log(
        {
          action: 'library.copies_added',
          entity: 'LibraryBook',
          entityId: bookId,
          after: { codes },
        },
        tx,
      );
      return { codes };
    });
  }

  /** Retrait d'un exemplaire du fonds (abîmé, perdu) ; il reste dans l'historique. */
  async withdrawCopy(copyId: string) {
    const copy = await this.db.libraryCopy.findUnique({ where: { id: copyId } });
    if (!copy) throw new NotFoundException('Exemplaire introuvable');
    if (copy.status === 'LOANED')
      throw new ConflictException('Cet exemplaire est prêté : enregistrez d’abord son retour');
    await this.db.libraryCopy.update({ where: { id: copyId }, data: { status: 'WITHDRAWN' } });
    await this.audit.log({
      action: 'library.copy_withdrawn',
      entity: 'LibraryCopy',
      entityId: copyId,
      before: { status: copy.status },
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------- Lecteurs

  /** Personnel de l'école pouvant emprunter. */
  async staffReaders() {
    const memberships = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId(), active: true },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    return memberships
      .map((m) => m.user)
      .sort((a, b) => a.lastName.localeCompare(b.lastName, 'fr'));
  }

  private async borrowerNames(rows: { studentId: string | null; staffUserId: string | null }[]) {
    const studentIds = [...new Set(rows.map((r) => r.studentId).filter((x): x is string => !!x))];
    const staffIds = [...new Set(rows.map((r) => r.staffUserId).filter((x): x is string => !!x))];
    const [students, users] = await Promise.all([
      this.db.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, firstName: true, lastName: true, matricule: true },
      }),
      this.db.user.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, firstName: true, lastName: true },
      }),
    ]);
    return (r: { studentId: string | null; staffUserId: string | null }) => {
      if (r.studentId) {
        const s = students.find((x) => x.id === r.studentId);
        return s
          ? { id: s.id, name: `${s.lastName} ${s.firstName}`, detail: s.matricule }
          : { id: r.studentId, name: '—', detail: null };
      }
      const u = users.find((x) => x.id === r.staffUserId);
      return u
        ? { id: u.id, name: `${u.lastName} ${u.firstName}`, detail: 'Personnel' }
        : { id: r.staffUserId ?? '', name: '—', detail: 'Personnel' };
    };
  }

  private presentLoan(
    l: LoanRow,
    borrower: ReturnType<Awaited<ReturnType<LibraryService['borrowerNames']>>>,
    today: string,
  ) {
    const dueDate = fromDbDate(l.dueDate);
    const returnedOn = l.returnedAt ? todayInCameroon(l.returnedAt) : null;
    return {
      id: l.id,
      borrowerType: l.borrowerType,
      borrower,
      book: l.copy.book,
      copy: { id: l.copy.id, code: l.copy.code },
      loanedAt: l.loanedAt,
      dueDate,
      renewals: l.renewals,
      returnedAt: l.returnedAt,
      lost: l.lost,
      daysLate: daysLate(dueDate, returnedOn ?? today),
      overdue: !l.returnedAt && daysLate(dueDate, today) > 0,
      penaltyAmount: l.penaltyAmount,
      lastReminderOn: l.lastReminderOn ? fromDbDate(l.lastReminderOn) : null,
    };
  }

  // ---------------------------------------------------------------- Prêts

  async loans(q: {
    filter: LoanFilter;
    studentId?: string;
    staffUserId?: string;
    bookId?: string;
    page: number;
    pageSize: number;
  }) {
    const today = todayInCameroon();
    const where: Prisma.LibraryLoanWhereInput = {
      ...(q.studentId ? { studentId: q.studentId } : {}),
      ...(q.staffUserId ? { staffUserId: q.staffUserId } : {}),
      ...(q.bookId ? { copy: { bookId: q.bookId } } : {}),
      ...(q.filter === 'active' ? { returnedAt: null } : {}),
      ...(q.filter === 'overdue' ? { returnedAt: null, dueDate: { lt: toDbDate(today) } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.db.libraryLoan.count({ where }),
      this.db.libraryLoan.findMany({
        where,
        include: loanInclude,
        orderBy: q.filter === 'history' ? { loanedAt: 'desc' } : { dueDate: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const name = await this.borrowerNames(rows);
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((l) => this.presentLoan(l, name(l), today)),
    };
  }

  async stats() {
    const today = toDbDate(todayInCameroon());
    const [books, copies, active, overdue] = await Promise.all([
      this.db.libraryBook.count(),
      this.db.libraryCopy.count({ where: { status: { in: ['AVAILABLE', 'LOANED'] } } }),
      this.db.libraryLoan.count({ where: { returnedAt: null } }),
      this.db.libraryLoan.count({ where: { returnedAt: null, dueDate: { lt: today } } }),
    ]);
    return { books, copies, active, overdue };
  }

  /** Prêt : exemplaire disponible, lecteur connu, plafond d'emprunts respecté (sous verrou). */
  async lend(input: LoanInput) {
    const schoolId = currentSchoolId();
    const settings = await this.settings();
    const today = todayInCameroon();
    const dueDate = input.dueDate ?? addIsoDays(today, settings.loanDays);
    if (dueDate < today) throw new BadRequestException('La date de retour est déjà passée');
    if (input.borrowerType === 'STUDENT') {
      const student = await this.db.student.findUnique({ where: { id: input.studentId ?? '' } });
      if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    } else {
      const member = await this.db.membership.findFirst({
        where: { schoolId, userId: input.staffUserId ?? '', active: true },
      });
      if (!member) throw new NotFoundException('Membre du personnel introuvable');
    }
    const borrower =
      input.borrowerType === 'STUDENT'
        ? { studentId: input.studentId ?? null, staffUserId: null }
        : { studentId: null, staffUserId: input.staffUserId ?? null };
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "LibraryCopy" WHERE "id" = ${input.copyId} AND "schoolId" = ${schoolId} FOR UPDATE`;
      // Verrou par lecteur : deux prêts simultanés ne dépassent pas le plafond.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`library:${schoolId}:${borrower.studentId ?? borrower.staffUserId}`}))`;
      const copy = await tx.libraryCopy.findUnique({
        where: { id: input.copyId },
        include: { book: { select: { title: true } } },
      });
      if (!copy) throw new NotFoundException('Exemplaire introuvable');
      if (copy.status !== 'AVAILABLE')
        throw new ConflictException(`L’exemplaire ${copy.code} n’est pas disponible`);
      const active = await tx.libraryLoan.count({ where: { ...borrower, returnedAt: null } });
      if (!canBorrow(active, settings.maxLoans))
        throw new ConflictException(
          `Plafond atteint : ${settings.maxLoans} emprunts en cours pour ce lecteur`,
        );
      const overdue = await tx.libraryLoan.count({
        where: { ...borrower, returnedAt: null, dueDate: { lt: toDbDate(today) } },
      });
      if (overdue > 0)
        throw new ConflictException('Ce lecteur a un prêt en retard : il doit d’abord le rendre');
      const loan = await tx.libraryLoan.create({
        data: {
          schoolId,
          copyId: copy.id,
          borrowerType: input.borrowerType,
          ...borrower,
          dueDate: toDbDate(dueDate),
          loanedById: currentActorId() ?? null,
        },
      });
      await tx.libraryCopy.update({ where: { id: copy.id }, data: { status: 'LOANED' } });
      await this.audit.log(
        {
          action: 'library.loan',
          entity: 'LibraryLoan',
          entityId: loan.id,
          after: { ...input, dueDate, code: copy.code, title: copy.book.title },
        },
        tx,
      );
      return { ...loan, dueDate };
    });
  }

  async renew(loanId: string) {
    const settings = await this.settings();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "LibraryLoan" WHERE "id" = ${loanId} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
      const loan = await tx.libraryLoan.findUnique({ where: { id: loanId } });
      if (!loan || loan.returnedAt) throw new NotFoundException('Prêt en cours introuvable');
      const r = renewal(
        { dueDate: fromDbDate(loan.dueDate), renewals: loan.renewals },
        settings,
        todayInCameroon(),
      );
      if (!r.ok) throw new ConflictException(r.reason);
      await tx.libraryLoan.update({
        where: { id: loanId },
        data: { dueDate: toDbDate(r.dueDate), renewals: loan.renewals + 1 },
      });
      await this.audit.log(
        {
          action: 'library.renewed',
          entity: 'LibraryLoan',
          entityId: loanId,
          before: { dueDate: fromDbDate(loan.dueDate) },
          after: { dueDate: r.dueDate },
        },
        tx,
      );
      return { dueDate: r.dueDate, renewals: loan.renewals + 1 };
    });
  }

  /**
   * Retour d'un prêt. En retard, un élève se voit facturer la pénalité par la scolarité si l'école
   * l'a activée et que le bibliothécaire ne l'a pas levée ; la ligne de facture est unique par prêt.
   */
  async giveBack(loanId: string, input: ReturnInput) {
    const schoolId = currentSchoolId();
    const settings = await this.settings();
    const today = todayInCameroon();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "LibraryLoan" WHERE "id" = ${loanId} AND "schoolId" = ${schoolId} FOR UPDATE`;
      const loan = await tx.libraryLoan.findUnique({ where: { id: loanId }, include: loanInclude });
      if (!loan) throw new NotFoundException('Prêt introuvable');
      if (loan.returnedAt) throw new ConflictException('Ce prêt est déjà rendu');
      const late = daysLate(fromDbDate(loan.dueDate), today);
      const penalty =
        loan.borrowerType === 'STUDENT' && !input.waivePenalty
          ? latePenalty(late, settings.lateFeePerDay, settings.lateFeeCap)
          : 0;
      let penaltyInvoiceLineId: string | null = null;
      if (penalty > 0 && loan.studentId) {
        const year = await this.scope.currentYear(tx);
        const line = await this.finance.addExtraCharge(
          {
            studentId: loan.studentId,
            academicYearId: year.id,
            label: `Pénalité de retard bibliothèque – ${loan.copy.book.title}`,
            amount: penalty,
            dueDate: today,
          },
          tx,
        );
        penaltyInvoiceLineId = line.id;
      }
      await tx.libraryLoan.update({
        where: { id: loanId },
        data: {
          returnedAt: new Date(),
          returnedById: currentActorId() ?? null,
          lost: input.lost,
          penaltyAmount: penalty > 0 ? penalty : null,
          penaltyInvoiceLineId,
        },
      });
      await tx.libraryCopy.update({
        where: { id: loan.copyId },
        data: { status: input.lost ? 'LOST' : 'AVAILABLE' },
      });
      await this.audit.log(
        {
          action: 'library.returned',
          entity: 'LibraryLoan',
          entityId: loanId,
          after: { late, penalty, waived: input.waivePenalty, lost: input.lost },
        },
        tx,
      );
      return { daysLate: late, penalty, lost: input.lost };
    });
  }

  /** Rappels de retard aux parents (élèves), au premier jour de retard puis chaque semaine. */
  async sendOverdueReminders(today = todayInCameroon()) {
    const schools = await this.db.school.findMany({
      where: { status: 'ACTIVE', modules: { has: 'library' } },
      select: { id: true, name: true, settings: true },
    });
    let sent = 0;
    for (const school of schools) {
      const settings = librarySettings(
        (school.settings as { library?: Partial<LibrarySettings> }).library,
      );
      if (!settings.reminderSms) continue;
      sent += await runAsSystem(
        'library-reminders',
        async () => {
          let count = 0;
          const loans = await this.db.libraryLoan.findMany({
            where: {
              borrowerType: 'STUDENT',
              returnedAt: null,
              dueDate: { lt: toDbDate(today) },
            },
            include: loanInclude,
          });
          for (const loan of loans) {
            const due = fromDbDate(loan.dueDate);
            const last = loan.lastReminderOn ? fromDbDate(loan.lastReminderOn) : null;
            if (!loan.studentId || !reminderDue(due, last, today)) continue;
            const student = await this.db.student.findUnique({
              where: { id: loan.studentId },
              select: { firstName: true, lastName: true, deletedAt: true },
            });
            if (!student || student.deletedAt) continue;
            const phone = await this.finance.guardianPhone(loan.studentId);
            await this.db.$transaction(async (tx) => {
              await tx.libraryLoan.update({
                where: { id: loan.id },
                data: { lastReminderOn: toDbDate(today) },
              });
              if (!phone) return;
              await this.notifications.enqueue(
                {
                  schoolId: school.id,
                  recipient: phone,
                  template: LIBRARY_REMINDER_TEMPLATE,
                  body: libraryTemplates.overdue({
                    school: school.name,
                    student: `${student.firstName} ${student.lastName}`,
                    title: loan.copy.book.title,
                    dueDate: due.split('-').reverse().join('/'),
                  }),
                  payload: { loanId: loan.id },
                },
                tx,
              );
              count++;
            });
          }
          return count;
        },
        school.id,
      );
    }
    return { sent };
  }
}
