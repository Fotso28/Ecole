import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  accountClass,
  AccountingRuleError,
  assertBalancedEntry,
  assertFiscalYearRange,
  carryForwardLines,
  dateInFiscalYear,
  defaultFiscalYear,
  DEFAULT_EXPENSE_APPROVAL_THRESHOLD,
  entryReference,
  expenseCreateSchema,
  expenseNeedsApproval,
  expensePostings,
  fiscalYearsOverlap,
  incomeStatement,
  isPostable,
  JOURNAL_CODES,
  JOURNAL_LABELS,
  manualEntrySchema,
  PAYMENT_METHOD_ACCOUNTS,
  SYSCOHADA_CHART,
  tuitionPosting,
  validateSubAccount,
  type AccountBalance,
  type EntryLine,
  type JournalCode,
} from '@ecole/shared';
import { FiscalYear, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId, runAsSystem } from '../../common/context';
import { CountersService } from '../../common/counters.service';
import { addDays, fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';

export interface PostingInput {
  journal: JournalCode;
  date: string;
  label: string;
  lines: EntryLine[];
  pieceRef?: string | null;
  sourceType?: string;
  sourceId?: string;
  reversesEntryId?: string;
  /** Exercice imposé (à-nouveaux) ; sinon celui qui couvre la date. */
  fiscalYear?: FiscalYear;
}

const DB_MESSAGES =
  /(Exercice clôturé[^"\n]*|Écriture déséquilibrée[^"\n]*|Numérotation du journal[^"\n]*|La date de l'écriture[^"\n]*|Compte inconnu[^"\n]*|Les écritures comptables[^"\n]*|Un exercice[^"\n]*|Une dépense[^"\n]*|Les données d'une dépense[^"\n]*)/;

/** Traduit les refus des déclencheurs PostgreSQL et des règles comptables en erreurs HTTP. */
export function translateAccountingError(e: unknown): unknown {
  if (e instanceof AccountingRuleError) return new BadRequestException(e.message);
  const message = e instanceof Error ? e.message : '';
  const m = DB_MESSAGES.exec(message);
  if (m?.[1] && !(e instanceof HttpException)) return new ConflictException(m[1].trim());
  return e;
}

const frDate = (iso: string) => iso.split('-').reverse().join('/');

@Injectable()
export class AccountingService {
  private readonly logger = new Logger('Accounting');
  /** Établissements dont le plan comptable et les journaux sont déjà en place (ce processus). */
  private readonly ready = new Set<string>();

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
  ) {}

  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn, { timeout: 30_000 });
    } catch (e) {
      throw translateAccountingError(e);
    }
  }

  // ---------------------------------------------------------------- Mise en place

  /** Plan comptable SYSCOHADA, journaux et réglages de l'école : idempotent. */
  async ensureSetup(): Promise<void> {
    const schoolId = currentSchoolId();
    if (this.ready.has(schoolId)) return;
    await this.db.accountingAccount.createMany({
      data: SYSCOHADA_CHART.map((a) => ({ schoolId, ...a, isSystem: true })),
      skipDuplicates: true,
    });
    await this.db.accountingJournal.createMany({
      data: JOURNAL_CODES.map((code) => ({ schoolId, code, label: JOURNAL_LABELS[code] })),
      skipDuplicates: true,
    });
    await this.db.accountingSettings.createMany({
      data: [{ schoolId, expenseApprovalThreshold: DEFAULT_EXPENSE_APPROVAL_THRESHOLD }],
      skipDuplicates: true,
    });
    this.ready.add(schoolId);
  }

  // ---------------------------------------------------------------- Plan comptable

  async listAccounts() {
    await this.ensureSetup();
    const accounts = await this.db.accountingAccount.findMany({ orderBy: { number: 'asc' } });
    return accounts.map((a) => ({
      id: a.id,
      number: a.number,
      label: a.label,
      class: accountClass(a.number),
      isSystem: a.isSystem,
      postable: isPostable(a.number),
    }));
  }

  async createAccount(input: { parentNumber: string; number: string; label: string }) {
    await this.ensureSetup();
    const parent = await this.db.accountingAccount.findFirst({
      where: { number: input.parentNumber },
    });
    if (!parent) throw new NotFoundException('Compte parent introuvable');
    const existing = await this.db.accountingAccount.findMany({
      where: { number: { startsWith: input.parentNumber } },
      select: { number: true },
    });
    try {
      validateSubAccount(
        input.parentNumber,
        input.number,
        existing.map((a) => a.number),
      );
    } catch (e) {
      throw translateAccountingError(e);
    }
    const account = await this.db.accountingAccount.create({
      data: { schoolId: currentSchoolId(), number: input.number, label: input.label },
    });
    await this.audit.log({
      action: 'accounting.account_created',
      entity: 'AccountingAccount',
      entityId: account.id,
      after: input,
    });
    return account;
  }

  async listJournals() {
    await this.ensureSetup();
    const journals = await this.db.accountingJournal.findMany();
    return JOURNAL_CODES.map((code) => journals.find((j) => j.code === code)).filter(
      (j) => j !== undefined,
    );
  }

  // ---------------------------------------------------------------- Exercices

  async listFiscalYears() {
    const years = await this.db.fiscalYear.findMany({ orderBy: { startDate: 'desc' } });
    const counts = await this.db.accountingEntry.groupBy({
      by: ['fiscalYearId'],
      _count: { _all: true },
    });
    return years.map((y) => ({
      ...this.presentYear(y),
      entries: counts.find((c) => c.fiscalYearId === y.id)?._count._all ?? 0,
    }));
  }

  private presentYear(y: FiscalYear) {
    return {
      id: y.id,
      name: y.name,
      startDate: fromDbDate(y.startDate),
      endDate: fromDbDate(y.endDate),
      status: y.status,
      closedAt: y.closedAt,
    };
  }

  async openFiscalYear(input: { name?: string; startDate: string; endDate: string }) {
    try {
      assertFiscalYearRange(input);
    } catch (e) {
      throw translateAccountingError(e);
    }
    await this.ensureSetup();
    const year = await this.run(async (tx) => {
      await this.lockSchool(tx, 'fiscal-years');
      const created = await this.createFiscalYear(tx, {
        name: input.name ?? `Exercice ${input.startDate.slice(0, 4)}`,
        startDate: input.startDate,
        endDate: input.endDate,
      });
      if (!created) throw new ConflictException('Cet exercice chevauche un exercice existant');
      await this.audit.log(
        {
          action: 'accounting.fiscal_year_opened',
          entity: 'FiscalYear',
          entityId: created.id,
          after: input,
        },
        tx,
      );
      return created;
    });
    return this.presentYear(year);
  }

  /** Crée l'exercice s'il ne chevauche aucun autre ; sinon null. */
  private async createFiscalYear(
    tx: Tx,
    r: { name: string; startDate: string; endDate: string },
  ): Promise<FiscalYear | null> {
    const years = await tx.fiscalYear.findMany();
    if (
      years.some((y) =>
        fiscalYearsOverlap(r, {
          startDate: fromDbDate(y.startDate),
          endDate: fromDbDate(y.endDate),
        }),
      )
    )
      return null;
    return tx.fiscalYear.create({
      data: {
        schoolId: currentSchoolId(),
        name: r.name,
        startDate: toDbDate(r.startDate),
        endDate: toDbDate(r.endDate),
        openedById: currentActorId() ?? null,
      },
    });
  }

  /** Verrou transactionnel par école, pour sérialiser créations d'exercices et alimentation. */
  private async lockSchool(tx: Tx, key: string): Promise<void> {
    const lock = `accounting:${key}:${currentSchoolId()}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))::text`;
  }

  /**
   * Exercice ouvert couvrant la date. S'il n'en existe aucun, l'exercice calendaire est ouvert
   * automatiquement (règle OHADA par défaut) lorsqu'il ne chevauche aucun exercice existant.
   */
  private async fiscalYearForDate(tx: Tx, date: string): Promise<FiscalYear> {
    const covering = await tx.fiscalYear.findFirst({
      where: { startDate: { lte: toDbDate(date) }, endDate: { gte: toDbDate(date) } },
    });
    if (covering) {
      if (covering.status !== 'OPEN')
        throw new ConflictException(
          `Exercice clôturé : aucune nouvelle écriture n’est possible au ${frDate(date)}`,
        );
      return covering;
    }
    await this.lockSchool(tx, 'fiscal-years');
    const created = await this.createFiscalYear(tx, defaultFiscalYear(date));
    if (!created)
      throw new BadRequestException(`Aucun exercice ouvert ne couvre le ${frDate(date)}`);
    return created;
  }

  /**
   * Exercice d'une écriture automatique : celui de l'opération s'il est ouvert ; si la période est
   * clôturée, le premier exercice ouvert suivant, à sa date d'ouverture.
   */
  private async fiscalYearForAutomatic(
    tx: Tx,
    date: string,
  ): Promise<{ year: FiscalYear; date: string; late: boolean } | null> {
    const covering = await tx.fiscalYear.findFirst({
      where: { startDate: { lte: toDbDate(date) }, endDate: { gte: toDbDate(date) } },
    });
    if (covering?.status === 'OPEN') return { year: covering, date, late: false };
    if (covering) {
      const next = await tx.fiscalYear.findFirst({
        where: { status: 'OPEN', startDate: { gt: toDbDate(date) } },
        orderBy: { startDate: 'asc' },
      });
      return next ? { year: next, date: fromDbDate(next.startDate), late: true } : null;
    }
    await this.lockSchool(tx, 'fiscal-years');
    const created = await this.createFiscalYear(tx, defaultFiscalYear(date));
    return created ? { year: created, date, late: false } : null;
  }

  /**
   * Clôture : plus aucune écriture sur la période ; les soldes des comptes de bilan et le résultat
   * sont reportés à nouveau à l'ouverture de l'exercice suivant (créé au besoin).
   */
  async closeFiscalYear(id: string) {
    await this.ensureSetup();
    // Dernières opérations de scolarité passées avant la clôture.
    await this.syncTuition();
    return this.run(async (tx) => {
      await this.lockSchool(tx, 'fiscal-years');
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "FiscalYear" WHERE "id" = ${id} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Exercice introuvable');
      const year = await tx.fiscalYear.findUniqueOrThrow({ where: { id } });
      if (year.status !== 'OPEN') throw new ConflictException('Cet exercice est déjà clôturé');
      const range = { startDate: fromDbDate(year.startDate), endDate: fromDbDate(year.endDate) };
      if (todayInCameroon() <= range.endDate)
        throw new ConflictException(
          `L’exercice ne peut être clôturé qu’après sa date de fin (${frDate(range.endDate)})`,
        );
      const pendingExpenses = await tx.expense.count({
        where: {
          status: 'PENDING_APPROVAL',
          date: { gte: year.startDate, lte: year.endDate },
        },
      });
      if (pendingExpenses > 0)
        throw new ConflictException(
          `${pendingExpenses} dépense(s) de cet exercice attendent encore leur validation`,
        );
      const balances = await this.balances(tx, { fiscalYearId: id });
      const lines = carryForwardLines(balances);
      let next = await tx.fiscalYear.findFirst({
        where: { startDate: toDbDate(addDays(range.endDate, 1)) },
      });
      if (!next) {
        const start = addDays(range.endDate, 1);
        const calendar = start.endsWith('-01-01');
        const end = calendar
          ? `${start.slice(0, 4)}-12-31`
          : addDays(`${Number(start.slice(0, 4)) + 1}${start.slice(4)}`, -1);
        next = await this.createFiscalYear(tx, {
          name: calendar
            ? `Exercice ${start.slice(0, 4)}`
            : `Exercice ${start.slice(0, 4)}-${end.slice(0, 4)}`,
          startDate: start,
          endDate: end,
        });
        if (!next) throw new ConflictException('L’exercice suivant chevauche un exercice existant');
      }
      if (next.status !== 'OPEN') throw new ConflictException('L’exercice suivant est clôturé');
      let carryForward: string | null = null;
      if (lines.length >= 2) {
        const entry = await this.post(tx, {
          journal: 'AN',
          date: fromDbDate(next.startDate),
          label: `Report à nouveau : ${year.name}`,
          lines,
          sourceType: 'CARRY_FORWARD',
          sourceId: year.id,
          fiscalYear: next,
        });
        carryForward = entry.reference;
      }
      const result = incomeStatement(balances).result;
      const closed = await tx.fiscalYear.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: new Date(), closedById: currentActorId() ?? null },
      });
      await this.audit.log(
        {
          action: 'accounting.fiscal_year_closed',
          entity: 'FiscalYear',
          entityId: id,
          before: { status: 'OPEN' },
          after: { status: 'CLOSED', result, carryForward, nextFiscalYearId: next.id },
        },
        tx,
      );
      return {
        ...this.presentYear(closed),
        result,
        carryForward,
        nextFiscalYear: this.presentYear(next),
      };
    });
  }

  // ---------------------------------------------------------------- Écritures

  /** Passe une écriture équilibrée, numérotée sans trou dans son journal et son exercice. */
  async post(tx: Tx, input: PostingInput) {
    const total = assertBalancedEntry(input.lines);
    const year = input.fiscalYear ?? (await this.fiscalYearForDate(tx, input.date));
    if (
      !dateInFiscalYear(input.date, {
        startDate: fromDbDate(year.startDate),
        endDate: fromDbDate(year.endDate),
      })
    )
      throw new BadRequestException('La date de l’écriture est hors de l’exercice');
    const numbers = [...new Set(input.lines.map((l) => l.accountNumber))];
    const known = await tx.accountingAccount.count({ where: { number: { in: numbers } } });
    if (known !== numbers.length) throw new BadRequestException('Compte inconnu du plan comptable');
    const number = await this.counters.next(`accounting:${year.id}:${input.journal}`, tx);
    const schoolId = currentSchoolId();
    const entry = await tx.accountingEntry.create({
      data: {
        schoolId,
        fiscalYearId: year.id,
        journalCode: input.journal,
        number,
        reference: entryReference(input.journal, fromDbDate(year.startDate), number),
        date: toDbDate(input.date),
        label: input.label.slice(0, 200),
        pieceRef: input.pieceRef ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        reversesEntryId: input.reversesEntryId ?? null,
        total,
        createdById: currentActorId() ?? null,
      },
    });
    await tx.accountingLine.createMany({
      data: input.lines.map((l, order) => ({
        schoolId,
        entryId: entry.id,
        accountNumber: l.accountNumber,
        label: l.label ?? null,
        debit: l.debit,
        credit: l.credit,
        order,
      })),
    });
    return entry;
  }

  async createManualEntry(input: z.infer<typeof manualEntrySchema>) {
    await this.ensureSetup();
    const entry = await this.run(async (tx) => {
      const created = await this.post(tx, {
        journal: input.journal,
        date: input.date,
        label: input.label,
        pieceRef: input.pieceRef,
        lines: input.lines,
      });
      await this.audit.log(
        {
          action: 'accounting.entry_created',
          entity: 'AccountingEntry',
          entityId: created.id,
          after: { reference: created.reference, ...input },
        },
        tx,
      );
      return created;
    });
    return this.getEntry(entry.id);
  }

  /** Correction par contre-passation : une nouvelle écriture inverse, l'originale reste intacte. */
  async reverseEntry(id: string, reason: string, date?: string) {
    await this.ensureSetup();
    const entry = await this.run(async (tx) => {
      const original = await tx.accountingEntry.findUnique({
        where: { id },
        include: { lines: { orderBy: { order: 'asc' } } },
      });
      if (!original) throw new NotFoundException('Écriture introuvable');
      if (original.reversesEntryId)
        throw new ConflictException('Une contre-passation ne se contre-passe pas');
      if (original.sourceType === 'LEDGER')
        throw new ConflictException(
          'Écriture automatique de la scolarité : corrigez l’opération dans la scolarité (annulation ou remise)',
        );
      if (original.sourceType === 'CARRY_FORWARD')
        throw new ConflictException('Le report à nouveau ne se contre-passe pas');
      const already = await tx.accountingEntry.findFirst({ where: { reversesEntryId: id } });
      if (already)
        throw new ConflictException(`Écriture déjà contre-passée (${already.reference})`);
      const created = await this.post(tx, {
        journal: original.journalCode as JournalCode,
        date: date ?? todayInCameroon(),
        label: `Contre-passation de ${original.reference} : ${reason}`,
        pieceRef: original.pieceRef,
        lines: original.lines.map((l) => ({
          accountNumber: l.accountNumber,
          debit: l.credit,
          credit: l.debit,
          label: l.label ?? undefined,
        })),
        sourceType: 'REVERSAL',
        sourceId: original.id,
        reversesEntryId: original.id,
      });
      await this.audit.log(
        {
          action: 'accounting.entry_reversed',
          entity: 'AccountingEntry',
          entityId: original.id,
          after: { reversal: created.reference },
          reason,
        },
        tx,
      );
      return created;
    });
    return this.getEntry(entry.id);
  }

  async getEntry(id: string) {
    const e = await this.db.accountingEntry.findUnique({
      where: { id },
      include: { lines: { orderBy: { order: 'asc' } } },
    });
    if (!e) throw new NotFoundException('Écriture introuvable');
    const [reversedBy] = await Promise.all([
      this.db.accountingEntry.findFirst({
        where: { reversesEntryId: id },
        select: { reference: true },
      }),
    ]);
    return this.presentEntry(e, reversedBy?.reference ?? null);
  }

  private presentEntry(
    e: Prisma.AccountingEntryGetPayload<{ include: { lines: true } }>,
    reversedBy: string | null,
  ) {
    return {
      id: e.id,
      reference: e.reference,
      journal: e.journalCode,
      number: e.number,
      date: fromDbDate(e.date),
      label: e.label,
      pieceRef: e.pieceRef,
      sourceType: e.sourceType,
      total: e.total,
      reversesEntryId: e.reversesEntryId,
      reversedBy,
      createdAt: e.createdAt,
      lines: e.lines.map((l) => ({
        accountNumber: l.accountNumber,
        label: l.label,
        debit: l.debit,
        credit: l.credit,
      })),
    };
  }

  async listEntries(q: { from: string; to: string; journal?: string; account?: string }) {
    const entries = await this.db.accountingEntry.findMany({
      where: {
        date: { gte: toDbDate(q.from), lte: toDbDate(q.to) },
        journalCode: q.journal,
        lines: q.account ? { some: { accountNumber: { startsWith: q.account } } } : undefined,
      },
      include: { lines: { orderBy: { order: 'asc' } } },
      orderBy: [{ date: 'desc' }, { journalCode: 'asc' }, { number: 'desc' }],
      take: 300,
    });
    const reversals = await this.db.accountingEntry.findMany({
      where: { reversesEntryId: { in: entries.map((e) => e.id) } },
      select: { reversesEntryId: true, reference: true },
    });
    return entries.map((e) =>
      this.presentEntry(e, reversals.find((r) => r.reversesEntryId === e.id)?.reference ?? null),
    );
  }

  /** Soldes nets par compte (positif = débiteur) sur un exercice ou une plage de dates. */
  async balances(
    tx: Tx | Db,
    where: { fiscalYearId?: string; from?: string; to?: string; before?: string },
  ): Promise<AccountBalance[]> {
    const groups = await tx.accountingLine.groupBy({
      by: ['accountNumber'],
      where: {
        entry: {
          fiscalYearId: where.fiscalYearId,
          date: {
            gte: where.from ? toDbDate(where.from) : undefined,
            lte: where.to ? toDbDate(where.to) : undefined,
            lt: where.before ? toDbDate(where.before) : undefined,
          },
        },
      },
      _sum: { debit: true, credit: true },
    });
    const labels = await tx.accountingAccount.findMany({
      where: { number: { in: groups.map((g) => g.accountNumber) } },
      select: { number: true, label: true },
    });
    return groups.map((g) => ({
      accountNumber: g.accountNumber,
      label: labels.find((l) => l.number === g.accountNumber)?.label ?? g.accountNumber,
      balance: (g._sum.debit ?? 0) - (g._sum.credit ?? 0),
    }));
  }

  // ---------------------------------------------------------------- Alimentation automatique

  /** Opérations du grand livre de scolarité pas encore comptabilisées. */
  private async pendingLedgerIds(limit: number): Promise<string[]> {
    const schoolId = currentSchoolId();
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT l."id" FROM "LedgerEntry" l
      WHERE l."schoolId" = ${schoolId}
        AND NOT EXISTS (
          SELECT 1 FROM "AccountingEntry" a
          WHERE a."schoolId" = l."schoolId" AND a."sourceType" = 'LEDGER' AND a."sourceId" = l."id"
        )
      ORDER BY l."createdAt", l."id"
      LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  async pendingTuitionCount(): Promise<number> {
    const schoolId = currentSchoolId();
    const rows = await this.db.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM "LedgerEntry" l
      WHERE l."schoolId" = ${schoolId}
        AND NOT EXISTS (
          SELECT 1 FROM "AccountingEntry" a
          WHERE a."schoolId" = l."schoolId" AND a."sourceType" = 'LEDGER' AND a."sourceId" = l."id"
        )`;
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Comptabilise les factures, remises, paiements et annulations de la scolarité, historique
   * compris. Idempotent : chaque opération porte une clé unique (LEDGER, identifiant) et passe
   * sous verrou ; une relance du worker ou deux synchronisations simultanées ne la doublent pas.
   */
  async syncTuition(limit = 1000): Promise<{ posted: number; pending: number; failed: number }> {
    await this.ensureSetup();
    const ids = await this.pendingLedgerIds(limit);
    let posted = 0;
    let failed = 0;
    let waiting = 0;
    for (const id of ids) {
      try {
        const done = await this.db.$transaction(
          async (tx) => {
            await this.lockSchool(tx, 'tuition-sync');
            const exists = await tx.accountingEntry.findFirst({
              where: { sourceType: 'LEDGER', sourceId: id },
              select: { id: true },
            });
            if (exists) return 'skipped' as const;
            const op = await tx.ledgerEntry.findUniqueOrThrow({ where: { id } });
            const [student, payment] = await Promise.all([
              tx.student.findUnique({
                where: { id: op.studentId },
                select: { firstName: true, lastName: true, matricule: true },
              }),
              op.paymentId
                ? tx.payment.findUnique({ where: { id: op.paymentId }, select: { method: true } })
                : null,
            ]);
            const date = todayInCameroon(op.createdAt);
            const target = await this.fiscalYearForAutomatic(tx, date);
            if (!target) return 'waiting' as const;
            const posting = tuitionPosting({
              type: op.type,
              amount: op.amount,
              description: op.description,
              studentName: student
                ? `${student.lastName} ${student.firstName} (${student.matricule})`
                : 'Élève',
              method: payment?.method ?? null,
            });
            await this.post(tx, {
              journal: posting.journal,
              date: target.date,
              label: target.late
                ? `${posting.label} (opération du ${frDate(date)}, exercice clos)`
                : posting.label,
              lines: posting.lines,
              sourceType: 'LEDGER',
              sourceId: op.id,
              fiscalYear: target.year,
            });
            return 'posted' as const;
          },
          { timeout: 30_000 },
        );
        if (done === 'posted') posted++;
        if (done === 'waiting') waiting++;
      } catch (e) {
        failed++;
        this.logger.error(
          `Écriture automatique impossible pour l’opération ${id} : ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    if (posted > 0)
      await this.audit.log({
        action: 'accounting.tuition_synced',
        entity: 'AccountingEntry',
        after: { posted, failed, waiting },
      });
    return { posted, failed, pending: await this.pendingTuitionCount() };
  }

  /** Tâche de fond : alimentation de toutes les écoles ayant activé la comptabilité. */
  async syncAllSchools(): Promise<{ schools: number; posted: number; failed: number }> {
    const schools = await this.db.school.findMany({
      where: { status: 'ACTIVE', modules: { has: 'accounting' } },
      select: { id: true },
    });
    let posted = 0;
    let failed = 0;
    for (const s of schools) {
      const r = await runAsSystem('job:accounting', () => this.syncTuition(), s.id);
      posted += r.posted;
      failed += r.failed;
    }
    return { schools: schools.length, posted, failed };
  }

  // ---------------------------------------------------------------- Dépenses

  async getSettings() {
    await this.ensureSetup();
    const s = await this.db.accountingSettings.findFirstOrThrow();
    return { expenseApprovalThreshold: s.expenseApprovalThreshold };
  }

  async updateSettings(input: { expenseApprovalThreshold: number }) {
    await this.ensureSetup();
    const before = await this.db.accountingSettings.findFirstOrThrow();
    await this.db.accountingSettings.update({
      where: { id: before.id },
      data: { expenseApprovalThreshold: input.expenseApprovalThreshold },
    });
    await this.audit.log({
      action: 'accounting.settings_updated',
      entity: 'AccountingSettings',
      entityId: before.id,
      before: { expenseApprovalThreshold: before.expenseApprovalThreshold },
      after: input,
    });
    return input;
  }

  listSuppliers() {
    return this.db.supplier.findMany({ orderBy: { name: 'asc' } });
  }

  async createSupplier(input: { name: string; phone?: string; taxId?: string }) {
    const supplier = await this.db.supplier.create({
      data: { schoolId: currentSchoolId(), ...input },
    });
    await this.audit.log({
      action: 'accounting.supplier_created',
      entity: 'Supplier',
      entityId: supplier.id,
      after: input,
    });
    return supplier;
  }

  async listExpenses(status?: 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED') {
    const expenses = await this.db.expense.findMany({
      where: { status },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 300,
    });
    const [suppliers, users, entries] = await Promise.all([
      this.db.supplier.findMany({
        where: { id: { in: [...new Set(expenses.map((e) => e.supplierId))] } },
        select: { id: true, name: true },
      }),
      this.db.user.findMany({
        where: {
          id: { in: [...new Set(expenses.flatMap((e) => [e.createdById, e.approvedById ?? '']))] },
        },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.db.accountingEntry.findMany({
        where: {
          sourceType: { in: ['EXPENSE', 'EXPENSE_PAYMENT'] },
          sourceId: { in: expenses.map((e) => e.id) },
        },
        select: { sourceId: true, reference: true },
      }),
    ]);
    const name = (id: string | null) => {
      const u = users.find((x) => x.id === id);
      return u ? `${u.firstName} ${u.lastName}` : null;
    };
    return expenses.map((e) => ({
      id: e.id,
      date: fromDbDate(e.date),
      label: e.label,
      amount: e.amount,
      accountNumber: e.accountNumber,
      method: e.method,
      pieceRef: e.pieceRef,
      status: e.status,
      supplier: suppliers.find((s) => s.id === e.supplierId)?.name ?? '',
      createdById: e.createdById,
      createdBy: name(e.createdById),
      approvedBy: name(e.approvedById),
      rejectedReason: e.rejectedReason,
      entries: entries.filter((x) => x.sourceId === e.id).map((x) => x.reference),
    }));
  }

  private async postExpense(
    tx: Tx,
    e: {
      id: string;
      amount: number;
      accountNumber: string;
      method: keyof typeof PAYMENT_METHOD_ACCOUNTS;
      label: string;
      date: Date;
      pieceRef: string;
    },
    supplierName: string,
  ) {
    const [invoice, payment] = expensePostings({
      amount: e.amount,
      chargeAccount: e.accountNumber,
      method: e.method,
      label: `${e.label} · ${supplierName}`,
    });
    const date = fromDbDate(e.date);
    const refs: string[] = [];
    for (const [posting, sourceType] of [
      [invoice, 'EXPENSE'],
      [payment, 'EXPENSE_PAYMENT'],
    ] as const) {
      if (!posting) continue;
      const entry = await this.post(tx, {
        journal: posting.journal,
        date,
        label: posting.label,
        lines: posting.lines,
        pieceRef: e.pieceRef,
        sourceType,
        sourceId: e.id,
      });
      refs.push(entry.reference);
    }
    return refs;
  }

  async createExpense(input: z.infer<typeof expenseCreateSchema>) {
    await this.ensureSetup();
    const actorId = currentActorId();
    if (!actorId) throw new ForbiddenException();
    const account = await this.db.accountingAccount.findFirst({
      where: { number: input.accountNumber },
    });
    if (!account) throw new BadRequestException('Compte de charge inconnu');
    if (accountClass(account.number) !== 6 || !isPostable(account.number))
      throw new BadRequestException('Une dépense s’impute sur un compte de charge (classe 6)');
    const { expenseApprovalThreshold } = await this.getSettings();
    const needsApproval = expenseNeedsApproval(input.amount, expenseApprovalThreshold);
    const result = await this.run(async (tx) => {
      let supplier = input.supplierId
        ? await tx.supplier.findUnique({ where: { id: input.supplierId } })
        : await tx.supplier.findFirst({ where: { name: input.supplierName } });
      if (input.supplierId && !supplier) throw new NotFoundException('Fournisseur introuvable');
      supplier ??= await tx.supplier.create({
        data: { schoolId: currentSchoolId(), name: input.supplierName ?? '' },
      });
      const expense = await tx.expense.create({
        data: {
          schoolId: currentSchoolId(),
          supplierId: supplier.id,
          date: toDbDate(input.date),
          label: input.label,
          amount: input.amount,
          accountNumber: input.accountNumber,
          method: input.method,
          pieceRef: input.pieceRef,
          status: needsApproval ? 'PENDING_APPROVAL' : 'POSTED',
          createdById: actorId,
        },
      });
      const entries = needsApproval ? [] : await this.postExpense(tx, expense, supplier.name);
      await this.audit.log(
        {
          action: 'accounting.expense_created',
          entity: 'Expense',
          entityId: expense.id,
          after: { ...input, supplier: supplier.name, status: expense.status, entries },
        },
        tx,
      );
      return { id: expense.id, status: expense.status, entries };
    });
    return { ...result, needsApproval, threshold: expenseApprovalThreshold };
  }

  async approveExpense(id: string) {
    await this.ensureSetup();
    return this.run(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Expense" WHERE "id" = ${id} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Dépense introuvable');
      const expense = await tx.expense.findUniqueOrThrow({ where: { id } });
      if (expense.status !== 'PENDING_APPROVAL')
        throw new ConflictException('Cette dépense n’est plus en attente de validation');
      const actorId = currentActorId();
      if (expense.createdById === actorId)
        throw new ForbiddenException(
          'La dépense doit être validée par une autre personne que celle qui l’a saisie',
        );
      const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: expense.supplierId } });
      const entries = await this.postExpense(tx, expense, supplier.name);
      await tx.expense.update({
        where: { id },
        data: { status: 'POSTED', approvedById: actorId ?? null, approvedAt: new Date() },
      });
      await this.audit.log(
        {
          action: 'accounting.expense_approved',
          entity: 'Expense',
          entityId: id,
          before: { status: 'PENDING_APPROVAL' },
          after: { status: 'POSTED', entries },
        },
        tx,
      );
      return { id, status: 'POSTED' as const, entries };
    });
  }

  async rejectExpense(id: string, reason: string) {
    return this.run(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Expense" WHERE "id" = ${id} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Dépense introuvable');
      const expense = await tx.expense.findUniqueOrThrow({ where: { id } });
      if (expense.status !== 'PENDING_APPROVAL')
        throw new ConflictException('Cette dépense n’est plus en attente de validation');
      await tx.expense.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectedReason: reason,
          approvedById: currentActorId() ?? null,
          approvedAt: new Date(),
        },
      });
      await this.audit.log(
        {
          action: 'accounting.expense_rejected',
          entity: 'Expense',
          entityId: id,
          before: { status: 'PENDING_APPROVAL' },
          after: { status: 'REJECTED' },
          reason,
        },
        tx,
      );
      return { id, status: 'REJECTED' as const };
    });
  }

  // ---------------------------------------------------------------- Vue d'ensemble

  async overview() {
    await this.ensureSetup();
    const today = todayInCameroon();
    const years = await this.db.fiscalYear.findMany({ orderBy: { startDate: 'desc' } });
    const current =
      years.find((y) =>
        dateInFiscalYear(today, {
          startDate: fromDbDate(y.startDate),
          endDate: fromDbDate(y.endDate),
        }),
      ) ??
      years.find((y) => y.status === 'OPEN') ??
      null;
    const balances = current ? await this.balances(this.db, { fiscalYearId: current.id }) : [];
    const treasury = Object.entries(PAYMENT_METHOD_ACCOUNTS).map(([method, number]) => ({
      method,
      accountNumber: number,
      label: SYSCOHADA_CHART.find((a) => a.number === number)?.label ?? number,
      balance: balances.find((b) => b.accountNumber === number)?.balance ?? 0,
    }));
    const [pendingTuition, pendingExpenses, settings] = await Promise.all([
      this.pendingTuitionCount(),
      this.db.expense.count({ where: { status: 'PENDING_APPROVAL' } }),
      this.getSettings(),
    ]);
    const is = incomeStatement(balances);
    return {
      fiscalYear: current ? this.presentYear(current) : null,
      treasury,
      receivables: balances.find((b) => b.accountNumber === '4111')?.balance ?? 0,
      products: is.totalProducts,
      charges: is.totalCharges,
      result: is.result,
      pendingTuition,
      pendingExpenses,
      ...settings,
    };
  }
}
