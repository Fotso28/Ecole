import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  feeItemCreateSchema,
  formatCameroonPhone,
  formatFcfa,
  installmentStatus,
  isMobileMoney,
  isOverdue,
  ledgerBalance,
  PAYMENT_METHOD_LABELS,
  paymentCreateSchema,
  recoveryRate,
  reminderDate,
  signedLedgerAmount,
} from '@ecole/shared';
import { Payment, PaymentMethod, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentContext, currentSchoolId, runAsSystem, staffContext } from '../../common/context';
import { CountersService } from '../../common/counters.service';
import { verificationCode } from '../../common/crypto';
import {
  addDays,
  doualaDateTime,
  doualaDayStart,
  fromDbDate,
  todayInCameroon,
  toDbDate,
} from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { AccountingService, translateAccountingError } from '../accounting/accounting.service';
import { NotificationsService } from '../notifications/notifications.service';
import { templates } from '../notifications/templates';
import {
  MOBILE_MONEY_PROVIDER,
  MobileMoneyProvider,
  OperatorPendingError,
  OperatorRejectedError,
  OperatorStatus,
  StatusResult,
} from './mobile-money.provider';

export interface LineState {
  id: string;
  invoiceId: string;
  studentId: string;
  academicYearId: string;
  feeItemId: string | null;
  label: string;
  amount: number;
  discount: number;
  due: number;
  paid: number;
  outstanding: number;
  dueDate: string;
  order: number;
  status: 'PAID' | 'PARTIAL' | 'UNPAID';
  overdue: boolean;
}

type PaymentInput = z.infer<typeof paymentCreateSchema>;

export interface SchoolFinanceSettings {
  reminderOffsets?: number[];
}

const lineInclude = {
  invoice: { select: { studentId: true, academicYearId: true } },
  allocations: {
    select: { amount: true, payment: { select: { status: true, reversedAt: true } } },
  },
} satisfies Prisma.InvoiceLineInclude;

type LineWithAllocations = Prisma.InvoiceLineGetPayload<{ include: typeof lineInclude }>;

function toLineState(l: LineWithAllocations, today: string): LineState {
  const paid = l.allocations
    .filter((a) => a.payment.status === 'SUCCESS' && a.payment.reversedAt === null)
    .reduce((s, a) => s + a.amount, 0);
  const due = l.amount - l.discount;
  const outstanding = Math.max(0, due - paid);
  const dueDate = fromDbDate(l.dueDate);
  return {
    id: l.id,
    invoiceId: l.invoiceId,
    studentId: l.invoice.studentId,
    academicYearId: l.invoice.academicYearId,
    feeItemId: l.feeItemId,
    label: l.label,
    amount: l.amount,
    discount: l.discount,
    due,
    paid,
    outstanding,
    dueDate,
    order: l.order,
    status: installmentStatus(due, Math.min(paid, due)),
    overdue: isOverdue(dueDate, outstanding, today),
  };
}

function sortLines<T extends { dueDate: string; order: number }>(lines: T[]): T[] {
  return [...lines].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.order - b.order);
}

@Injectable()
export class FinanceService {
  private readonly logger = new Logger('Finance');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly counters: CountersService,
    private readonly notifications: NotificationsService,
    @Inject(MOBILE_MONEY_PROVIDER) private readonly mobileMoney: MobileMoneyProvider,
    private readonly accounting: AccountingService,
  ) {}

  // ---------------------------------------------------------------- Grille de frais

  listFeeItems(academicYearId: string) {
    return this.db.feeItem.findMany({
      where: { academicYearId },
      orderBy: [{ dueDate: 'asc' }, { order: 'asc' }],
    });
  }

  async createFeeItem(input: z.infer<typeof feeItemCreateSchema>) {
    await this.db.academicYear.findUniqueOrThrow({ where: { id: input.academicYearId } });
    if (input.levelId) await this.db.level.findUniqueOrThrow({ where: { id: input.levelId } });
    const item = await this.db.feeItem.create({
      data: { schoolId: currentSchoolId(), ...input, dueDate: toDbDate(input.dueDate) },
    });
    await this.audit.log({
      action: 'finance.fee_item_created',
      entity: 'FeeItem',
      entityId: item.id,
      after: input,
    });
    return item;
  }

  async deleteFeeItem(id: string) {
    const used = await this.db.invoiceLine.count({ where: { feeItemId: id } });
    if (used > 0)
      throw new ConflictException(
        'Ce frais figure déjà sur des échéanciers : il ne peut plus être supprimé',
      );
    await this.db.feeItem.delete({ where: { id } });
    await this.audit.log({ action: 'finance.fee_item_deleted', entity: 'FeeItem', entityId: id });
    return { ok: true };
  }

  // ---------------------------------------------------------------- Échéanciers

  /** Crée l'échéancier d'un élève à partir de la grille de frais de son niveau. */
  async generateInvoice(
    studentId: string,
    academicYearId: string,
    discounts: { feeItemId: string; amount: number; reason: string }[] = [],
    outerTx?: Tx,
  ) {
    const run = async (tx: Tx) => {
      const schoolId = currentSchoolId();
      const existing = await tx.invoice.findFirst({ where: { studentId, academicYearId } });
      if (existing)
        throw new ConflictException('L’échéancier de cet élève existe déjà pour cette année');
      const enrollment = await tx.enrollment.findFirst({
        where: { studentId, academicYearId },
        include: { class: { select: { levelId: true } } },
      });
      if (!enrollment) throw new ConflictException('L’élève n’est pas inscrit pour cette année');
      const items = await tx.feeItem.findMany({
        where: { academicYearId, OR: [{ levelId: null }, { levelId: enrollment.class.levelId }] },
        orderBy: [{ dueDate: 'asc' }, { order: 'asc' }],
      });
      if (items.length === 0)
        throw new ConflictException('Aucun frais n’est défini pour ce niveau');
      for (const d of discounts) {
        const item = items.find((i) => i.id === d.feeItemId);
        if (!item) throw new BadRequestException('Remise sur un frais inconnu');
        if (d.amount > item.amount)
          throw new BadRequestException(`La remise dépasse le montant de « ${item.name} »`);
      }
      const invoice = await tx.invoice.create({ data: { schoolId, studentId, academicYearId } });
      const createdById = this.actorId();
      for (const item of items) {
        const discount = discounts.find((d) => d.feeItemId === item.id);
        const line = await tx.invoiceLine.create({
          data: {
            schoolId,
            invoiceId: invoice.id,
            feeItemId: item.id,
            label: item.name,
            amount: item.amount,
            discount: discount?.amount ?? 0,
            discountReason: discount?.reason,
            dueDate: item.dueDate,
            order: item.order,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            schoolId,
            studentId,
            type: 'CHARGE',
            amount: signedLedgerAmount('CHARGE', item.amount),
            invoiceLineId: line.id,
            description: item.name,
            createdById,
          },
        });
        if (discount) {
          await tx.ledgerEntry.create({
            data: {
              schoolId,
              studentId,
              type: 'DISCOUNT',
              amount: signedLedgerAmount('DISCOUNT', discount.amount),
              invoiceLineId: line.id,
              description: `Remise : ${discount.reason}`,
              createdById,
            },
          });
        }
      }
      await this.audit.log(
        {
          action: 'finance.invoice_created',
          entity: 'Invoice',
          entityId: invoice.id,
          after: { studentId, academicYearId, discounts },
        },
        tx,
      );
      await this.applyCredit(tx, studentId);
      return invoice;
    };
    return outerTx ? run(outerTx) : this.db.$transaction(run);
  }

  /**
   * Ajoute à l'échéancier de l'année d'un élève une ligne hors grille de frais (transport,
   * pénalité de bibliothèque, vente de fournitures), avec son écriture de dette. Les règles de
   * la scolarité s'appliquent ensuite comme pour toute échéance (paiements, remises, relances).
   * À appeler dans la transaction de l'action métier, qui garantit une seule facturation.
   */
  async addExtraCharge(
    input: {
      studentId: string;
      academicYearId: string;
      label: string;
      amount: number;
      dueDate: string;
    },
    tx: Tx,
  ) {
    if (!Number.isInteger(input.amount) || input.amount <= 0)
      throw new BadRequestException('Montant entier en FCFA attendu');
    const invoice = await tx.invoice.findFirst({
      where: { studentId: input.studentId, academicYearId: input.academicYearId },
      include: { lines: { select: { order: true } } },
    });
    if (!invoice)
      throw new ConflictException(
        'L’échéancier de l’élève n’existe pas encore pour cette année : créez-le d’abord dans la scolarité',
      );
    const schoolId = currentSchoolId();
    const line = await tx.invoiceLine.create({
      data: {
        schoolId,
        invoiceId: invoice.id,
        label: input.label,
        amount: input.amount,
        dueDate: toDbDate(input.dueDate),
        order: Math.max(0, ...invoice.lines.map((l) => l.order)) + 1,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        schoolId,
        studentId: input.studentId,
        type: 'CHARGE',
        amount: signedLedgerAmount('CHARGE', input.amount),
        invoiceLineId: line.id,
        description: input.label,
        createdById: this.actorId(),
      },
    });
    await this.audit.log(
      {
        action: 'finance.extra_charge',
        entity: 'InvoiceLine',
        entityId: line.id,
        after: { ...input },
      },
      tx,
    );
    await this.applyCredit(tx, input.studentId);
    return line;
  }

  /**
   * Avoir sur une ligne hors grille (transport, vente de fournitures), décidé par le module qui
   * l'a facturée : remise plafonnée au reste dû de la ligne, sans autre droit sur la scolarité.
   * La part déjà payée n'est pas remboursée ici. Renvoie l'état de la ligne avant l'avoir et le
   * montant appliqué. À appeler dans la transaction de l'action métier.
   */
  async creditNote(
    input: { lineId: string; amount: number; reason: string; source: string; strict?: boolean },
    tx: Tx,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "InvoiceLine" WHERE "id" = ${input.lineId} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
    const line = await tx.invoiceLine.findUnique({
      where: { id: input.lineId },
      include: lineInclude,
    });
    if (!line) throw new NotFoundException('Échéance introuvable');
    const before = toLineState(line, todayInCameroon());
    if (input.strict && input.amount > before.outstanding)
      throw new ConflictException(
        `L’avoir dépasse le reste dû sur cette échéance (${before.outstanding} FCFA)`,
      );
    const applied = Math.min(Math.max(0, input.amount), before.outstanding);
    if (applied > 0) {
      await tx.invoiceLine.update({
        where: { id: line.id },
        data: {
          discount: line.discount + applied,
          discountReason: [line.discountReason, `Avoir : ${input.reason}`]
            .filter(Boolean)
            .join(' ; '),
        },
      });
      await tx.ledgerEntry.create({
        data: {
          schoolId: currentSchoolId(),
          studentId: line.invoice.studentId,
          type: 'DISCOUNT',
          amount: signedLedgerAmount('DISCOUNT', applied),
          invoiceLineId: line.id,
          description: `Avoir : ${input.reason}`,
          createdById: this.actorId(),
        },
      });
      await this.audit.log(
        {
          action: 'finance.credit_note',
          entity: 'InvoiceLine',
          entityId: line.id,
          before: { discount: line.discount },
          after: {
            discount: line.discount + applied,
            requested: input.amount,
            source: input.source,
          },
          reason: input.reason,
        },
        tx,
      );
    }
    return { before, applied };
  }

  /** Remise ou bourse accordée sur une échéance. */
  async addDiscount(lineId: string, amount: number, reason: string) {
    return this.db.$transaction(async (tx) => {
      // Verrou : deux remises simultanées ne doivent pas s'écraser.
      await tx.$queryRaw`SELECT "id" FROM "InvoiceLine" WHERE "id" = ${lineId} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
      const line = await tx.invoiceLine.findUnique({ where: { id: lineId }, include: lineInclude });
      if (!line) throw new NotFoundException('Échéance introuvable');
      const state = toLineState(line, todayInCameroon());
      if (amount > state.outstanding)
        throw new ConflictException('La remise dépasse le reste dû sur cette échéance');
      await tx.invoiceLine.update({
        where: { id: lineId },
        data: {
          discount: line.discount + amount,
          discountReason: [line.discountReason, reason].filter(Boolean).join(' ; '),
        },
      });
      await tx.ledgerEntry.create({
        data: {
          schoolId: currentSchoolId(),
          studentId: line.invoice.studentId,
          type: 'DISCOUNT',
          amount: signedLedgerAmount('DISCOUNT', amount),
          invoiceLineId: lineId,
          description: `Remise : ${reason}`,
          createdById: this.actorId(),
        },
      });
      await this.audit.log(
        {
          action: 'finance.discount',
          entity: 'InvoiceLine',
          entityId: lineId,
          before: { discount: line.discount },
          after: { discount: line.discount + amount },
          reason,
        },
        tx,
      );
      return { ok: true };
    });
  }

  async lineStates(where: Prisma.InvoiceLineWhereInput, tx?: Tx): Promise<LineState[]> {
    const today = todayInCameroon();
    const lines = await (tx ?? this.db).invoiceLine.findMany({ where, include: lineInclude });
    return sortLines(lines.map((l) => toLineState(l, today)));
  }

  /** Relevé de compte d'un élève : échéances, paiements, solde du ledger. */
  async account(studentId: string) {
    const student = await this.db.student.findUnique({
      where: { id: studentId },
      select: { id: true, firstName: true, lastName: true, matricule: true },
    });
    if (!student) throw new NotFoundException('Élève introuvable');
    const [lines, payments, ledger, invoices] = await Promise.all([
      this.lineStates({ invoice: { studentId } }),
      this.db.payment.findMany({
        where: { studentId },
        orderBy: { createdAt: 'desc' },
        include: { receipt: { select: { number: true, verificationCode: true } } },
      }),
      this.db.ledgerEntry.findMany({ where: { studentId }, select: { type: true, amount: true } }),
      this.db.invoice.findMany({
        where: { studentId },
        select: { id: true, academicYearId: true },
      }),
    ]);
    const balance = ledgerBalance(ledger);
    const outstanding = lines.reduce((s, l) => s + l.outstanding, 0);
    const totals = {
      due: lines.reduce((s, l) => s + l.due, 0),
      paid: lines.reduce((s, l) => s + Math.min(l.paid, l.due), 0),
      outstanding,
      overdue: lines.filter((l) => l.overdue).reduce((s, l) => s + l.outstanding, 0),
      balance,
      credit: Math.max(0, outstanding - balance),
    };
    const next = lines.find((l) => l.outstanding > 0) ?? null;
    return {
      student,
      invoices,
      lines,
      totals,
      nextDue: next
        ? { lineId: next.id, label: next.label, dueDate: next.dueDate, amount: next.outstanding }
        : null,
      payments: payments.map((p) => this.presentPayment(p)),
    };
  }

  presentPayment(p: Payment & { receipt?: { number: string; verificationCode: string } | null }) {
    return {
      id: p.id,
      amount: p.amount,
      method: p.method,
      methodLabel: PAYMENT_METHOD_LABELS[p.method],
      status: p.status,
      reversed: p.reversedAt !== null,
      reversalReason: p.reversalReason,
      operatorReference: p.operatorReference,
      bankName: p.bankName,
      bankReference: p.bankReference,
      payerPhone: p.payerPhone,
      failureReason: p.failureReason,
      receivedById: p.receivedById,
      createdAt: p.createdAt,
      confirmedAt: p.confirmedAt,
      receipt: p.receipt
        ? { number: p.receipt.number, verificationCode: p.receipt.verificationCode }
        : null,
    };
  }

  // ---------------------------------------------------------------- Paiements

  /**
   * Enregistre un paiement. Espèces et banque : encaissés immédiatement (reçu émis).
   * Mobile Money : paiement en attente, confirmé par le webhook de l'opérateur.
   * La clé d'idempotence évite tout double encaissement en cas de nouvel envoi.
   */
  async createPayment(input: PaymentInput, opts: { initiatedByUserId?: string } = {}) {
    const schoolId = currentSchoolId();
    const existing = await this.db.payment.findFirst({
      where: { idempotencyKey: input.idempotencyKey },
      include: { receipt: true },
    });
    if (existing) return this.replayPayment(existing, input);

    const student = await this.db.student.findUnique({ where: { id: input.studentId } });
    if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    if (input.lineIds?.length) {
      const owned = await this.db.invoiceLine.count({
        where: { id: { in: input.lineIds }, invoice: { studentId: input.studentId } },
      });
      if (owned !== input.lineIds.length)
        throw new BadRequestException('Échéance inconnue pour cet élève');
    }

    const ctx = currentContext();
    const receivedById = ctx?.kind === 'staff' ? ctx.userId : null;
    let cashSessionId: string | null = null;
    if (input.method === 'CASH') {
      const session = await this.db.cashSession.findFirst({
        where: { status: 'OPEN', openedById: receivedById ?? '' },
      });
      if (!session)
        throw new ConflictException({
          statusCode: 409,
          code: 'CASH_SESSION_REQUIRED',
          message: 'Ouvrez votre caisse avant d’encaisser des espèces',
        });
      cashSessionId = session.id;
    }

    if (isMobileMoney(input.method)) {
      return this.startMobileMoney(input, schoolId, receivedById, opts.initiatedByUserId);
    }

    try {
      return await this.db.$transaction(async (tx) => {
        if (cashSessionId) {
          // La caisse ne doit pas être clôturée pendant l'encaissement.
          const locked = await tx.$queryRaw<
            { status: string }[]
          >`SELECT "status" FROM "CashSession" WHERE "id" = ${cashSessionId} FOR UPDATE`;
          if (locked[0]?.status !== 'OPEN')
            throw new ConflictException({
              statusCode: 409,
              code: 'CASH_SESSION_REQUIRED',
              message: 'Votre caisse vient d’être clôturée : ouvrez-en une nouvelle',
            });
        }
        const payment = await tx.payment.create({
          data: {
            schoolId,
            studentId: input.studentId,
            amount: input.amount,
            method: input.method,
            status: 'PENDING',
            idempotencyKey: input.idempotencyKey,
            bankName: input.bankName,
            bankReference: input.bankReference,
            payerPhone: input.payerPhone,
            cashSessionId,
            receivedById,
            requestedLineIds: input.lineIds ?? [],
          },
        });
        return this.settle(tx, payment);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const replay = await this.db.payment.findFirst({
          where: { idempotencyKey: input.idempotencyKey },
          include: { receipt: true },
        });
        if (replay) return this.replayPayment(replay, input);
      }
      throw e;
    }
  }

  private async replayPayment(
    existing: Payment & { receipt: { number: string; verificationCode: string } | null },
    input: { studentId: string; amount: number; method: PaymentMethod },
  ) {
    if (
      existing.studentId !== input.studentId ||
      existing.amount !== input.amount ||
      existing.method !== input.method
    ) {
      throw new ConflictException('Cette clé d’idempotence a déjà servi pour un autre paiement');
    }
    return { ...this.presentPayment(existing), replayed: true };
  }

  private async startMobileMoney(
    input: PaymentInput,
    schoolId: string,
    receivedById: string | null,
    initiatedByUserId?: string,
  ) {
    let payment = await this.db.payment.create({
      data: {
        schoolId,
        studentId: input.studentId,
        amount: input.amount,
        method: input.method,
        status: 'PENDING',
        idempotencyKey: input.idempotencyKey,
        payerPhone: input.payerPhone,
        receivedById,
        initiatedByUserId: initiatedByUserId ?? null,
        requestedLineIds: input.lineIds ?? [],
      },
    });
    try {
      const { reference } = await this.mobileMoney.requestPayment({
        paymentId: payment.id,
        amount: input.amount,
        phone: input.payerPhone ?? '',
        method: input.method,
        description: 'Scolarité',
      });
      const updated = await this.db.payment.update({
        where: { id: payment.id },
        data: { operatorReference: reference },
      });
      await this.audit.log({
        action: 'finance.mobile_money_requested',
        entity: 'Payment',
        entityId: payment.id,
        after: { amount: input.amount, method: input.method },
      });
      return { ...this.presentPayment({ ...updated, receipt: null }), replayed: false };
    } catch (e) {
      if (e instanceof OperatorRejectedError) {
        await this.db.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failureReason: 'Demande refusée par l’opérateur' },
        });
        this.logger.warn(`Demande Mobile Money refusée : ${e.message}`);
        throw new BadGatewayException(
          'L’opérateur Mobile Money a refusé la demande. Vérifiez le numéro et réessayez.',
        );
      }
      // Issue inconnue (délai dépassé, coupure réseau) : l'opérateur a peut-être débité le payeur.
      // Le paiement reste en attente ; la réconciliation interroge l'opérateur avec la référence
      // connue ou, à défaut, avec notre identifiant.
      this.logger.warn(
        `Demande Mobile Money sans réponse (${payment.id}) : ${e instanceof Error ? e.message : e}`,
      );
      if (e instanceof OperatorPendingError && e.reference)
        payment = await this.db.payment.update({
          where: { id: payment.id },
          data: { operatorReference: e.reference },
        });
      await this.audit.log({
        action: 'finance.mobile_money_unconfirmed',
        entity: 'Payment',
        entityId: payment.id,
        after: { amount: input.amount, method: input.method },
      });
      return {
        ...this.presentPayment({ ...payment, receipt: null }),
        unconfirmed: true,
        replayed: false,
      };
    }
  }

  /** Passe un paiement en succès : imputation, écriture, reçu, SMS. À appeler dans une transaction. */
  private async settle(tx: Tx, payment: Payment) {
    const schoolId = payment.schoolId;
    // Verrouille les échéances de l'élève pour éviter deux imputations concurrentes.
    await tx.$queryRaw`
      SELECT l."id" FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
      WHERE l."schoolId" = ${schoolId} AND i."studentId" = ${payment.studentId} ORDER BY l."id" FOR UPDATE OF l`;
    const lines = (await this.lineStates({ invoice: { studentId: payment.studentId } }, tx)).filter(
      (l) => l.outstanding > 0,
    );
    const requested = new Set(payment.requestedLineIds);
    const ordered = [
      ...lines.filter((l) => requested.has(l.id)),
      ...lines.filter((l) => !requested.has(l.id)),
    ];
    let left = payment.amount;
    const allocations: { lineId: string; amount: number }[] = [];
    for (const l of ordered) {
      if (left === 0) break;
      const take = Math.min(left, l.outstanding);
      allocations.push({ lineId: l.id, amount: take });
      left -= take;
    }
    for (const a of allocations) {
      await tx.paymentAllocation.create({
        data: { schoolId, paymentId: payment.id, invoiceLineId: a.lineId, amount: a.amount },
      });
    }
    const confirmed = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCESS', confirmedAt: new Date() },
    });
    await tx.ledgerEntry.create({
      data: {
        schoolId,
        studentId: payment.studentId,
        type: 'PAYMENT',
        amount: signedLedgerAmount('PAYMENT', payment.amount),
        paymentId: payment.id,
        description: `Paiement ${PAYMENT_METHOD_LABELS[payment.method]}`,
        createdById: payment.receivedById,
      },
    });
    const year = new Date().getUTCFullYear();
    const seq = await this.counters.next(`receipt:${year}`, tx);
    const receipt = await tx.receipt.create({
      data: {
        schoolId,
        paymentId: payment.id,
        number: `R-${year}-${String(seq).padStart(6, '0')}`,
        verificationCode: verificationCode(),
      },
    });
    const ledger = await tx.ledgerEntry.findMany({
      where: { studentId: payment.studentId },
      select: { type: true, amount: true },
    });
    const balance = ledgerBalance(ledger);
    const [student, school, phone] = await Promise.all([
      tx.student.findUniqueOrThrow({
        where: { id: payment.studentId },
        select: { firstName: true, lastName: true },
      }),
      tx.school.findUniqueOrThrow({ where: { id: schoolId }, select: { name: true } }),
      this.guardianPhone(payment.studentId, tx),
    ]);
    if (phone) {
      await this.notifications.enqueue(
        {
          schoolId,
          recipient: phone,
          template: 'paymentReceived',
          body: templates.paymentReceived({
            school: school.name,
            student: `${student.firstName} ${student.lastName}`,
            amount: payment.amount,
            receipt: receipt.number,
            balance: Math.max(0, balance),
          }),
          payload: { paymentId: payment.id },
        },
        tx,
      );
    }
    await this.audit.log(
      {
        action: 'finance.payment_received',
        entity: 'Payment',
        entityId: payment.id,
        after: {
          amount: payment.amount,
          method: payment.method,
          receipt: receipt.number,
          allocations,
        },
      },
      tx,
    );
    return {
      ...this.presentPayment({ ...confirmed, receipt }),
      allocations,
      unallocated: left,
      balance,
      replayed: false,
    };
  }

  /**
   * Résultat de l'opérateur (webhook ou réconciliation). Idempotent : un paiement déjà
   * finalisé n'est pas retraité. Le montant doit correspondre à la demande. Le paiement est
   * retrouvé par la référence de l'opérateur ou, à défaut, par notre identifiant (externalId).
   */
  async confirmMobileMoney(
    ref: { reference?: string; externalId?: string; operator?: PaymentMethod },
    status: OperatorStatus,
    amount?: number,
  ) {
    const candidates = await runAsSystem('mobile-money-lookup', () =>
      this.db.payment.findMany({
        where: {
          method: ref.operator ? ref.operator : { in: ['MTN_MOMO', 'ORANGE_MONEY'] },
          OR: [
            ...(ref.reference ? [{ operatorReference: ref.reference }] : []),
            ...(ref.externalId ? [{ id: ref.externalId }] : []),
          ],
        },
        take: 2,
      }),
    );
    if (candidates.length > 1)
      throw new ConflictException('Référence ambiguë : précisez l’opérateur');
    const payment = candidates[0];
    if (!payment) throw new NotFoundException('Paiement inconnu');
    if (amount !== undefined && amount !== payment.amount) {
      await runAsSystem(
        'mobile-money-mismatch',
        () =>
          this.audit.log({
            action: 'finance.mobile_money_amount_mismatch',
            entity: 'Payment',
            entityId: payment.id,
            after: { expected: payment.amount, received: amount },
          }),
        payment.schoolId,
      );
      throw new ConflictException('Montant différent de la demande');
    }
    if (status === 'PENDING') return { status: payment.status, changed: false };
    return runAsSystem(
      'mobile-money-confirm',
      () =>
        this.db.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<
            { status: string }[]
          >`SELECT "status" FROM "Payment" WHERE "id" = ${payment.id} FOR UPDATE`;
          const current = locked[0]?.status ?? payment.status;
          if (ref.reference && !payment.operatorReference)
            await tx.payment.update({
              where: { id: payment.id },
              data: { operatorReference: ref.reference },
            });
          // Confirmation tardive d'un paiement expiré de notre côté : l'argent a été débité,
          // il est encaissé et signalé.
          const lateSuccess = current === 'CANCELLED' && status === 'SUCCESS';
          if (current !== 'PENDING' && !lateSuccess) {
            if (status === 'SUCCESS' && current !== 'SUCCESS') {
              this.logger.error(
                `Succès Mobile Money reçu pour le paiement ${payment.id} au statut ${current} : vérification manuelle`,
              );
              await this.audit.log(
                {
                  action: 'finance.mobile_money_conflict',
                  entity: 'Payment',
                  entityId: payment.id,
                  after: { status: current, operatorStatus: status },
                },
                tx,
              );
            }
            return { status: current, changed: false };
          }
          if (status === 'SUCCESS') {
            const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
            const result = await this.settle(tx, fresh);
            if (lateSuccess)
              await this.audit.log(
                {
                  action: 'finance.mobile_money_late_success',
                  entity: 'Payment',
                  entityId: payment.id,
                },
                tx,
              );
            return { status: result.status, changed: true };
          }
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'FAILED', failureReason: 'Refusé ou annulé par le payeur' },
          });
          const [student, phone] = await Promise.all([
            tx.student.findUniqueOrThrow({
              where: { id: payment.studentId },
              select: { firstName: true, lastName: true },
            }),
            payment.payerPhone
              ? Promise.resolve(payment.payerPhone)
              : this.guardianPhone(payment.studentId, tx),
          ]);
          if (phone) {
            await this.notifications.enqueue(
              {
                schoolId: payment.schoolId,
                recipient: phone,
                template: 'paymentFailed',
                body: templates.paymentFailed({
                  student: `${student.firstName} ${student.lastName}`,
                  amount: payment.amount,
                }),
                payload: { paymentId: payment.id },
              },
              tx,
            );
          }
          await this.audit.log(
            { action: 'finance.mobile_money_failed', entity: 'Payment', entityId: payment.id },
            tx,
          );
          return { status: 'FAILED', changed: true };
        }),
      payment.schoolId,
    );
  }

  /** Interroge l'opérateur pour les paiements restés en attente ; expire les plus anciens. */
  async reconcilePending(now = new Date()) {
    const pending = await runAsSystem('reconcile', () =>
      this.db.payment.findMany({
        where: {
          status: 'PENDING',
          method: { in: ['MTN_MOMO', 'ORANGE_MONEY'] },
          createdAt: { lt: new Date(now.getTime() - 10 * 60_000) },
        },
        take: 200,
      }),
    );
    let settled = 0;
    let expired = 0;
    for (const p of pending) {
      try {
        // Opérateur injoignable : le paiement reste en attente, et expire quand même après 24 h.
        const check = await this.mobileMoney
          .checkStatus(p.operatorReference ?? p.id, p.method)
          .catch((e: unknown): StatusResult => {
            this.logger.warn(
              `Statut du paiement ${p.id} indisponible : ${e instanceof Error ? e.message : e}`,
            );
            return { status: 'PENDING' };
          });
        if (check.status !== 'PENDING') {
          const r = await this.confirmMobileMoney(
            p.operatorReference ? { reference: p.operatorReference } : { externalId: p.id },
            check.status,
            check.amount,
          );
          if (r.changed) settled++;
          continue;
        }
        if (p.createdAt < new Date(now.getTime() - 24 * 3600_000)) {
          await runAsSystem(
            'reconcile-expire',
            () =>
              this.db.payment.updateMany({
                where: { id: p.id, status: 'PENDING' },
                data: { status: 'CANCELLED', failureReason: 'Délai de confirmation dépassé' },
              }),
            p.schoolId,
          );
          expired++;
        }
      } catch (e) {
        this.logger.warn(
          `Réconciliation du paiement ${p.id} impossible : ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return { checked: pending.length, settled, expired };
  }

  /**
   * Rappel non signé d'un opérateur (MTN MoMo, Orange Money) : son contenu n'est jamais cru.
   * Le paiement est retrouvé puis son statut est re-vérifié auprès de l'opérateur avant tout
   * encaissement. Seuls les paiements encore ouverts déclenchent une vérification, pour qu'un
   * rappel rejoué ou forgé ne multiplie pas les appels à l'opérateur.
   */
  async verifyOperatorCallback(
    method: 'MTN_MOMO' | 'ORANGE_MONEY',
    hint: { reference?: string; externalId?: string; claimedStatus?: string },
  ): Promise<{ verified: boolean; status?: string }> {
    if (!hint.reference && !hint.externalId) return { verified: false };
    const payment = await runAsSystem('mobile-money-callback', () =>
      this.db.payment.findFirst({
        where: {
          method,
          OR: [
            ...(hint.reference ? [{ operatorReference: hint.reference }] : []),
            ...(hint.externalId ? [{ id: hint.externalId }] : []),
          ],
        },
      }),
    );
    if (!payment) return { verified: false };
    if (payment.status !== 'PENDING' && payment.status !== 'CANCELLED')
      return { verified: false, status: payment.status };
    const check = await this.mobileMoney.checkStatus(
      payment.operatorReference ?? payment.id,
      payment.method,
    );
    if (hint.claimedStatus && /SUCCESS/i.test(hint.claimedStatus) && check.status !== 'SUCCESS')
      this.logger.warn(
        `Rappel ${method} annonçant un succès non confirmé par l'opérateur (paiement ${payment.id})`,
      );
    if (check.status === 'PENDING') return { verified: true, status: 'PENDING' };
    // Un paiement expiré n'est rouvert que par un succès confirmé (confirmation tardive).
    if (payment.status === 'CANCELLED' && check.status !== 'SUCCESS')
      return { verified: true, status: payment.status };
    const r = await this.confirmMobileMoney(
      payment.operatorReference
        ? { reference: payment.operatorReference, operator: method }
        : { externalId: payment.id, operator: method },
      check.status,
      check.amount,
    );
    return { verified: true, status: r.status };
  }

  /**
   * Impute le trop-perçu (part non imputée des paiements encaissés) sur les échéances restant
   * dues, du plus ancien paiement vers la plus ancienne échéance. À appeler dans une transaction.
   */
  private async applyCredit(tx: Tx, studentId: string) {
    const schoolId = currentSchoolId();
    await tx.$queryRaw`
      SELECT l."id" FROM "InvoiceLine" l JOIN "Invoice" i ON i."id" = l."invoiceId"
      WHERE l."schoolId" = ${schoolId} AND i."studentId" = ${studentId} ORDER BY l."id" FOR UPDATE OF l`;
    const payments = await tx.payment.findMany({
      where: { studentId, status: 'SUCCESS', reversedAt: null },
      include: { allocations: { select: { amount: true } } },
      orderBy: { confirmedAt: 'asc' },
    });
    const credits = payments
      .map((p) => ({ id: p.id, left: p.amount - p.allocations.reduce((n, a) => n + a.amount, 0) }))
      .filter((c) => c.left > 0);
    if (credits.length === 0) return;
    const lines = (await this.lineStates({ invoice: { studentId } }, tx)).filter(
      (l) => l.outstanding > 0,
    );
    const applied: { paymentId: string; lineId: string; amount: number }[] = [];
    for (const line of lines) {
      let need = line.outstanding;
      for (const c of credits) {
        if (need === 0) break;
        const take = Math.min(need, c.left);
        if (take === 0) continue;
        await tx.paymentAllocation.create({
          data: { schoolId, paymentId: c.id, invoiceLineId: line.id, amount: take },
        });
        applied.push({ paymentId: c.id, lineId: line.id, amount: take });
        c.left -= take;
        need -= take;
      }
    }
    if (applied.length > 0)
      await this.audit.log(
        {
          action: 'finance.credit_applied',
          entity: 'Student',
          entityId: studentId,
          after: { applied },
        },
        tx,
      );
  }

  /** Annulation d'un paiement par une écriture de correction ; le paiement d'origine reste intact. */
  async reversePayment(id: string, reason: string) {
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "Payment" WHERE "id" = ${id} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Paiement introuvable');
      const payment = await tx.payment.findUniqueOrThrow({ where: { id } });
      if (payment.status !== 'SUCCESS')
        throw new ConflictException('Seul un paiement encaissé peut être annulé');
      if (payment.reversedAt) throw new ConflictException('Ce paiement a déjà été annulé');
      const actorId = this.actorId();
      // Quatre yeux quel que soit le mode : des espèces saisies comme virement puis annulées
      // par la même personne échapperaient sinon au contrôle.
      if (payment.receivedById === actorId)
        throw new ForbiddenException(
          'Un paiement doit être annulé par une autre personne que celle qui l’a enregistré',
        );
      await tx.payment.update({
        where: { id },
        data: { reversedAt: new Date(), reversalReason: reason, reversedById: actorId },
      });
      await tx.ledgerEntry.create({
        data: {
          schoolId: payment.schoolId,
          studentId: payment.studentId,
          type: 'REVERSAL',
          amount: signedLedgerAmount('REVERSAL', payment.amount),
          paymentId: id,
          description: `Annulation : ${reason}`,
          createdById: actorId,
        },
      });
      await this.audit.log(
        {
          action: 'finance.payment_reversed',
          entity: 'Payment',
          entityId: id,
          before: { reversed: false },
          after: { reversed: true },
          reason,
        },
        tx,
      );
      // Les échéances rouvertes reprennent le trop-perçu éventuel des autres paiements.
      await this.applyCredit(tx, payment.studentId);
      return { ok: true };
    });
  }

  async getPayment(id: string) {
    const p = await this.db.payment.findUnique({ where: { id }, include: { receipt: true } });
    if (!p) throw new NotFoundException('Paiement introuvable');
    return this.presentPayment(p);
  }

  async journal(filters: {
    from?: string;
    to?: string;
    method?: PaymentMethod;
    status?: Payment['status'];
  }) {
    const payments = await this.db.payment.findMany({
      where: {
        method: filters.method,
        status: filters.status,
        // Jours calendaires de Douala, comme à l'écran et sur les reçus.
        createdAt: {
          gte: filters.from ? doualaDayStart(filters.from) : undefined,
          lt: filters.to ? doualaDayStart(addDays(filters.to, 1)) : undefined,
        },
      },
      // Export comptable : toute la période, sans troncature silencieuse.
      orderBy: { createdAt: 'desc' },
      include: { receipt: true },
    });
    const students = await this.db.student.findMany({
      where: { id: { in: [...new Set(payments.map((p) => p.studentId))] } },
      select: { id: true, firstName: true, lastName: true, matricule: true },
    });
    const byId = new Map(students.map((s) => [s.id, s]));
    return payments.map((p) => ({
      ...this.presentPayment(p),
      student: byId.get(p.studentId) ?? null,
    }));
  }

  /**
   * Journal paginé par curseur (du plus récent au plus ancien) : une page de `limit` paiements et
   * le curseur de la suivante. Index `Payment(schoolId, createdAt)`.
   */
  async journalPage(filters: {
    from?: string;
    to?: string;
    method?: PaymentMethod;
    status?: Payment['status'];
    cursor?: string;
    limit: number;
  }) {
    const where: Prisma.PaymentWhereInput = {
      method: filters.method,
      status: filters.status,
      // Jours calendaires de Douala, comme à l'écran et sur les reçus.
      createdAt: {
        gte: filters.from ? doualaDayStart(filters.from) : undefined,
        lt: filters.to ? doualaDayStart(addDays(filters.to, 1)) : undefined,
      },
    };
    // Total encaissé sur toute la période (pas seulement la page), calculé à la première page.
    const collected = filters.cursor
      ? null
      : await this.db.payment.aggregate({
          where: { ...where, status: filters.status ?? 'SUCCESS', reversedAt: null },
          _sum: { amount: true },
        });
    const payments = await this.db.payment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filters.limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      include: { receipt: true },
    });
    const page = payments.slice(0, filters.limit);
    const students = await this.db.student.findMany({
      where: { id: { in: [...new Set(page.map((p) => p.studentId))] } },
      select: { id: true, firstName: true, lastName: true, matricule: true },
    });
    const byId = new Map(students.map((s) => [s.id, s]));
    return {
      items: page.map((p) => ({
        ...this.presentPayment(p),
        student: byId.get(p.studentId) ?? null,
      })),
      nextCursor: payments.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
      collected:
        collected && (filters.status ?? 'SUCCESS') === 'SUCCESS'
          ? (collected._sum.amount ?? 0)
          : null,
    };
  }

  /**
   * Export CSV du journal : mêmes filtres que l'écran (période et moyen), heure de Douala,
   * référence de l'opérateur ou n° de bordereau bancaire.
   */
  async exportCsv(from: string, to: string, method?: PaymentMethod): Promise<string> {
    const rows = await this.journal({ from, to, method, status: 'SUCCESS' });
    const header = 'date;recu;matricule;eleve;moyen;montant;annule;reference;banque';
    const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = rows.map((r) =>
      [
        doualaDateTime(r.confirmedAt ?? r.createdAt),
        r.receipt?.number ?? '',
        r.student?.matricule ?? '',
        r.student ? `${r.student.lastName} ${r.student.firstName}` : '',
        r.methodLabel,
        String(r.amount),
        r.reversed ? 'oui' : 'non',
        r.operatorReference ?? r.bankReference ?? '',
        r.bankName ?? '',
      ]
        .map(esc)
        .join(';'),
    );
    return [header, ...lines].join('\n');
  }

  // ---------------------------------------------------------------- Caisse

  async openCashSession() {
    const userId = staffContext().userId;
    return this.db.$transaction(async (tx) => {
      // Deux ouvertures simultanées ne doivent pas créer deux caisses ouvertes.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash:${userId}`}))`;
      const existing = await tx.cashSession.findFirst({
        where: { status: 'OPEN', openedById: userId },
      });
      if (existing) return existing;
      const session = await tx.cashSession.create({
        data: { schoolId: currentSchoolId(), openedById: userId },
      });
      await this.audit.log(
        { action: 'finance.cash_opened', entity: 'CashSession', entityId: session.id },
        tx,
      );
      return session;
    });
  }

  private async sessionTotals(sessionId: string, tx?: Tx) {
    const payments = await (tx ?? this.db).payment.findMany({
      where: { cashSessionId: sessionId, status: 'SUCCESS' },
      select: { amount: true, reversedAt: true },
    });
    const valid = payments.filter((p) => p.reversedAt === null);
    return {
      operations: valid.length,
      expected: valid.reduce((s, p) => s + p.amount, 0),
      reversed: payments.length - valid.length,
    };
  }

  async currentCashSession() {
    const session = await this.db.cashSession.findFirst({
      where: { status: 'OPEN', openedById: staffContext().userId },
    });
    if (!session) return null;
    return { ...session, ...(await this.sessionTotals(session.id)) };
  }

  async listCashSessions(status?: 'OPEN' | 'CLOSED' | 'APPROVED') {
    const ctx = staffContext();
    const sessions = await this.db.cashSession.findMany({
      where: { status },
      orderBy: [{ closedAt: { sort: 'desc', nulls: 'first' } }, { openedAt: 'desc' }],
      take: 100,
    });
    const people = [
      ...new Set(sessions.flatMap((s) => [s.openedById, s.closedById, s.approvedById])),
    ].filter((x): x is string => !!x);
    const users = await this.db.user.findMany({
      where: { id: { in: people } },
      select: { id: true, firstName: true, lastName: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const entries = await this.db.accountingEntry.findMany({
      where: { sourceType: 'CASH_DIFFERENCE', sourceId: { in: sessions.map((s) => s.id) } },
      select: { sourceId: true, reference: true },
    });
    const entryBy = new Map(entries.map((e) => [e.sourceId, e.reference]));
    const open = sessions.filter((s) => s.status === 'OPEN');
    const totals = new Map(
      await Promise.all(open.map(async (s) => [s.id, await this.sessionTotals(s.id)] as const)),
    );
    const canApprove = ctx.permissions.has('finance.cash.approve');
    return sessions.map((s) => {
      const expected = s.expectedAmount ?? totals.get(s.id)?.expected ?? 0;
      return {
        ...s,
        openedBy: byId.get(s.openedById) ?? null,
        closedBy: s.closedById ? (byId.get(s.closedById) ?? null) : null,
        approvedBy: s.approvedById ? (byId.get(s.approvedById) ?? null) : null,
        expectedAmount: expected,
        difference: s.countedAmount === null ? null : s.countedAmount - expected,
        entry: entryBy.get(s.id) ?? null,
        // Contrôle à quatre yeux : ni le caissier ni la personne qui a clôturé n'approuvent.
        canApprove:
          canApprove &&
          s.status === 'CLOSED' &&
          s.openedById !== ctx.userId &&
          s.closedById !== ctx.userId,
      };
    });
  }

  async closeCashSession(id: string, countedAmount: number, note?: string) {
    const ctx = staffContext();
    return this.db.$transaction(async (tx) => {
      // Verrou : un encaissement en cours se termine avant la clôture et compte dans le total.
      await tx.$queryRaw`SELECT "id" FROM "CashSession" WHERE "id" = ${id} AND "schoolId" = ${currentSchoolId()} FOR UPDATE`;
      const session = await tx.cashSession.findUnique({ where: { id } });
      if (!session) throw new NotFoundException('Caisse introuvable');
      if (session.status !== 'OPEN') throw new ConflictException('Cette caisse est déjà clôturée');
      if (session.openedById !== ctx.userId && !ctx.permissions.has('finance.cash.approve')) {
        throw new ForbiddenException('Seul le caissier ou la direction peut clôturer cette caisse');
      }
      const totals = await this.sessionTotals(id, tx);
      const difference = countedAmount - totals.expected;
      if (difference !== 0 && !note?.trim())
        throw new BadRequestException(
          `${difference < 0 ? 'Manquant' : 'Excédent'} de ${formatFcfa(Math.abs(difference))} : indiquez le motif de l’écart`,
        );
      const closed = await tx.cashSession.update({
        where: { id, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          closedById: ctx.userId,
          expectedAmount: totals.expected,
          countedAmount,
          note: note?.trim() || null,
        },
      });
      await this.audit.log(
        {
          action: 'finance.cash_closed',
          entity: 'CashSession',
          entityId: id,
          after: { expected: totals.expected, counted: countedAmount, difference },
          reason: note?.trim() || undefined,
        },
        tx,
      );
      return { ...closed, difference, operations: totals.operations };
    });
  }

  /**
   * Approbation d'une clôture par une autre personne que le caissier. L'écart éventuel est passé
   * en comptabilité dans la même transaction (manquant en 6588, excédent en 7588, contre 571).
   */
  async approveCashSession(id: string) {
    const ctx = staffContext();
    const session = await this.db.cashSession.findUnique({ where: { id } });
    if (!session) throw new NotFoundException('Caisse introuvable');
    if (session.status !== 'CLOSED')
      throw new ConflictException(
        session.status === 'APPROVED'
          ? 'Cette clôture est déjà approuvée'
          : 'La caisse doit être clôturée avant validation',
      );
    // Contrôle à quatre yeux : ni le caissier ni la personne qui a clôturé ne valident.
    if (session.closedById === ctx.userId || session.openedById === ctx.userId) {
      throw new ForbiddenException(
        'La validation doit être faite par une autre personne que le caissier',
      );
    }
    const difference = (session.countedAmount ?? 0) - (session.expectedAmount ?? 0);
    const accounting = difference !== 0 && (await this.accounting.enabled());
    if (accounting) await this.accounting.ensureSetup();
    try {
      return await this.db.$transaction(
        async (tx) => {
          const { count } = await tx.cashSession.updateMany({
            where: { id, status: 'CLOSED' },
            data: { status: 'APPROVED', approvedById: ctx.userId, approvedAt: new Date() },
          });
          if (count === 0) throw new ConflictException('Cette clôture est déjà approuvée');
          let entry: string | null = null;
          if (accounting) {
            await this.accounting.postOperation(tx, 'CASH_DIFFERENCE', id);
            entry =
              (
                await tx.accountingEntry.findFirst({
                  where: { sourceType: 'CASH_DIFFERENCE', sourceId: id },
                  select: { reference: true },
                })
              )?.reference ?? null;
          }
          await this.audit.log(
            {
              action: 'finance.cash_approved',
              entity: 'CashSession',
              entityId: id,
              after: {
                expected: session.expectedAmount,
                counted: session.countedAmount,
                difference,
                entry,
              },
            },
            tx,
          );
          const approved = await tx.cashSession.findUniqueOrThrow({ where: { id } });
          return { ...approved, difference, entry };
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      throw translateAccountingError(e);
    }
  }

  // ---------------------------------------------------------------- Pilotage

  async summary(academicYearId: string) {
    const lines = await this.lineStates({ invoice: { academicYearId } });
    const expected = lines.reduce((s, l) => s + l.due, 0);
    const collected = lines.reduce((s, l) => s + Math.min(l.paid, l.due), 0);
    const overdueLines = lines.filter((l) => l.overdue);
    const byItem = new Map<string, { name: string; dueDate: string; due: number; paid: number }>();
    for (const l of lines) {
      const key = l.feeItemId ?? l.label;
      const cur = byItem.get(key) ?? { name: l.label, dueDate: l.dueDate, due: 0, paid: 0 };
      cur.due += l.due;
      cur.paid += Math.min(l.paid, l.due);
      byItem.set(key, cur);
    }
    return {
      expected,
      collected,
      recoveryRate: recoveryRate(collected, expected),
      overdue: overdueLines.reduce((s, l) => s + l.outstanding, 0),
      overdueStudents: new Set(overdueLines.map((l) => l.studentId)).size,
      items: [...byItem.values()]
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .map((i) => ({ ...i, rate: recoveryRate(i.paid, i.due) })),
    };
  }

  async unpaid(
    academicYearId: string,
    classId?: string,
    paging: { page: number; pageSize: number } = { page: 1, pageSize: 50 },
  ) {
    const enrollments = await this.db.enrollment.findMany({
      where: { academicYearId, ...(classId ? { classId } : {}), student: { deletedAt: null } },
      include: {
        student: { select: { id: true, firstName: true, lastName: true, matricule: true } },
        class: { select: { id: true, name: true } },
      },
    });
    const byStudent = new Map(enrollments.map((e) => [e.studentId, e]));
    const lines = await this.lineStates({
      invoice: { academicYearId, studentId: { in: [...byStudent.keys()] } },
    });
    const perStudent = new Map<
      string,
      { overdue: number; outstanding: number; oldest: string | null; due: number; paid: number }
    >();
    for (const l of lines) {
      const cur = perStudent.get(l.studentId) ?? {
        overdue: 0,
        outstanding: 0,
        oldest: null,
        due: 0,
        paid: 0,
      };
      cur.outstanding += l.outstanding;
      cur.due += l.due;
      cur.paid += Math.min(l.paid, l.due);
      if (l.overdue) {
        cur.overdue += l.outstanding;
        if (!cur.oldest || l.dueDate < cur.oldest) cur.oldest = l.dueDate;
      }
      perStudent.set(l.studentId, cur);
    }
    const students = [...perStudent.entries()]
      .filter(([, v]) => v.overdue > 0)
      .map(([studentId, v]) => {
        const e = byStudent.get(studentId);
        return {
          student: e?.student,
          class: e?.class,
          overdue: v.overdue,
          outstanding: v.outstanding,
          oldestDueDate: v.oldest,
        };
      })
      // Ordre total : les pages successives ne se recouvrent pas.
      .sort(
        (a, b) =>
          b.overdue - a.overdue ||
          `${a.student?.lastName} ${a.student?.firstName}`.localeCompare(
            `${b.student?.lastName} ${b.student?.firstName}`,
            'fr',
          ) ||
          (a.student?.id ?? '').localeCompare(b.student?.id ?? ''),
      );
    const perClass = new Map<
      string,
      {
        classId: string;
        className: string;
        students: number;
        overdue: number;
        due: number;
        paid: number;
      }
    >();
    for (const [studentId, v] of perStudent) {
      const e = byStudent.get(studentId);
      if (!e) continue;
      const cur = perClass.get(e.class.id) ?? {
        classId: e.class.id,
        className: e.class.name,
        students: 0,
        overdue: 0,
        due: 0,
        paid: 0,
      };
      if (v.overdue > 0) cur.students++;
      cur.overdue += v.overdue;
      cur.due += v.due;
      cur.paid += v.paid;
      perClass.set(e.class.id, cur);
    }
    const start = (paging.page - 1) * paging.pageSize;
    return {
      total: students.length,
      page: paging.page,
      pageSize: paging.pageSize,
      students: students.slice(start, start + paging.pageSize),
      classes: [...perClass.values()]
        .map((c) => ({ ...c, rate: recoveryRate(c.paid, c.due) }))
        .sort((a, b) => a.rate - b.rate),
    };
  }

  /** Encaissements des dernières semaines (lundi au dimanche). */
  async weeklyCollections(weeks = 9, now = new Date()) {
    const today = todayInCameroon(now);
    const d = new Date(`${today}T00:00:00Z`);
    const monday = addDays(today, -((d.getUTCDay() + 6) % 7));
    const start = addDays(monday, -7 * (weeks - 1));
    const payments = await this.db.payment.findMany({
      where: { status: 'SUCCESS', reversedAt: null, confirmedAt: { gte: toDbDate(start) } },
      select: { amount: true, confirmedAt: true },
    });
    const buckets = Array.from({ length: weeks }, (_, i) => ({
      weekStart: addDays(start, i * 7),
      amount: 0,
    }));
    for (const p of payments) {
      if (!p.confirmedAt) continue;
      const day = todayInCameroon(p.confirmedAt);
      const idx = Math.floor(
        (toDbDate(day).getTime() - toDbDate(start).getTime()) / (7 * 86_400_000),
      );
      const bucket = buckets[idx];
      if (bucket) bucket.amount += p.amount;
    }
    return buckets;
  }

  /** Relances automatiques J+n après échéance (une seule par échéance et par palier). */
  async sendReminders(today = todayInCameroon()) {
    const schools = await this.db.school.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, settings: true },
    });
    let sent = 0;
    for (const school of schools) {
      const offsets = ((school.settings as SchoolFinanceSettings).reminderOffsets ?? [5, 15, 30])
        .slice()
        .sort((a, b) => a - b);
      sent += await runAsSystem(
        'fee-reminders',
        async () => {
          let count = 0;
          const lines = (await this.lineStates({ dueDate: { lt: toDbDate(today) } })).filter(
            (l) => l.outstanding > 0,
          );
          for (const line of lines) {
            const reached = offsets.filter((o) => reminderDate(line.dueDate, o) <= today);
            const offset = reached[reached.length - 1];
            if (offset === undefined) continue;
            const scheduledFor = reminderDate(line.dueDate, offset);
            const exists = await this.db.reminder.findFirst({
              where: { invoiceLineId: line.id, scheduledFor: toDbDate(scheduledFor) },
            });
            if (exists) continue;
            const phone = await this.guardianPhone(line.studentId);
            const student = await this.db.student.findUnique({
              where: { id: line.studentId },
              select: { firstName: true, lastName: true, deletedAt: true },
            });
            if (!student || student.deletedAt) continue;
            await this.db.$transaction(async (tx) => {
              await tx.reminder.create({
                data: {
                  schoolId: school.id,
                  studentId: line.studentId,
                  invoiceLineId: line.id,
                  scheduledFor: toDbDate(scheduledFor),
                  sentAt: phone ? new Date() : null,
                },
              });
              if (phone) {
                await this.notifications.enqueue(
                  {
                    schoolId: school.id,
                    recipient: phone,
                    template: 'feeReminder',
                    body: templates.feeReminder({
                      school: school.name,
                      student: `${student.firstName} ${student.lastName}`,
                      label: line.label,
                      amount: line.outstanding,
                      dueDate: line.dueDate.split('-').reverse().join('/'),
                    }),
                    payload: { invoiceLineId: line.id, offset },
                  },
                  tx,
                );
              }
            });
            if (phone) count++;
          }
          return count;
        },
        school.id,
      );
    }
    return { sent };
  }

  /** Téléphone du parent principal (sinon du premier parent) d'un élève. */
  async guardianPhone(studentId: string, tx?: Tx): Promise<string | null> {
    const links = await (tx ?? this.db).studentGuardian.findMany({
      where: { studentId },
      include: { guardian: { select: { phone: true } } },
      orderBy: { isPrimary: 'desc' },
    });
    return links[0]?.guardian.phone ?? null;
  }

  private actorId(): string | null {
    const ctx = currentContext();
    if (ctx?.kind === 'staff' || ctx?.kind === 'parent') return ctx.userId;
    if (ctx?.kind === 'system') return ctx.actorId ?? null;
    return null;
  }

  static displayPhone(phone: string | null): string {
    return phone ? formatCameroonPhone(phone) : '';
  }
}
