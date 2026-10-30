import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  computeSubscriptionInvoice,
  subscriptionInvoiceState,
  type SubscriptionLine,
  subscriptionPaymentSchema,
  subscriptionPlanSchema,
} from '@ecole/shared';
import { Prisma, type SubscriptionPayment, type SubscriptionPlan } from '@prisma/client';
import type { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId, runAsSystem } from '../../common/context';
import { fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { NotificationsService } from '../notifications/notifications.service';
import { templates } from '../notifications/templates';

type InvoiceWithPayments = Prisma.SubscriptionInvoiceGetPayload<{
  include: { payments: true; reminders: true };
}>;

/** Montants réglés et état d'une facture, à partir des règlements (ajout seul). */
function presentInvoice(invoice: InvoiceWithPayments, today = todayInCameroon()) {
  const paid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
  const dueDate = fromDbDate(invoice.dueDate);
  const state = subscriptionInvoiceState({
    amount: invoice.amount,
    paid,
    dueDate,
    today,
    cancelled: invoice.status === 'CANCELLED',
  });
  const corrected = new Set(invoice.payments.map((p) => p.correctsId).filter(Boolean));
  return {
    id: invoice.id,
    number: invoice.number,
    period: invoice.period,
    planName: invoice.planName,
    pricing: invoice.pricing,
    studentCount: invoice.studentCount,
    modules: invoice.modules,
    lines: invoice.lines as unknown as SubscriptionLine[],
    amount: invoice.amount,
    paid,
    due: state === 'CANCELLED' ? 0 : Math.max(0, invoice.amount - paid),
    dueDate,
    state,
    issuedAt: invoice.issuedAt,
    cancelledAt: invoice.cancelledAt,
    cancelReason: invoice.cancelReason,
    payments: [...invoice.payments]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => ({
        id: p.id,
        amount: p.amount,
        method: p.method,
        reference: p.reference,
        paidOn: fromDbDate(p.paidOn),
        note: p.note,
        correctsId: p.correctsId,
        corrected: corrected.has(p.id),
        createdAt: p.createdAt,
      })),
    reminders: invoice.reminders.length,
    lastReminderAt:
      invoice.reminders.reduce<Date | null>(
        (last, r) => (!last || r.createdAt > last ? r.createdAt : last),
        null,
      ) ?? null,
  };
}

export type PresentedInvoice = ReturnType<typeof presentInvoice>;

/** Avertissement affiché à la direction : jamais de coupure de l'accès. */
function warningFor(
  invoices: PresentedInvoice[],
): { level: 'overdue' | 'due'; due: number } | null {
  const open = invoices.filter((i) => i.state !== 'CANCELLED' && i.due > 0);
  if (open.length === 0) return null;
  const due = open.reduce((sum, i) => sum + i.due, 0);
  return { level: open.some((i) => i.state === 'OVERDUE') ? 'overdue' : 'due', due };
}

function presentPlan(plan: SubscriptionPlan) {
  return {
    id: plan.id,
    name: plan.name,
    pricing: plan.pricing,
    pricePerStudent: plan.pricePerStudent,
    modulePrices: plan.modulePrices as Record<string, number>,
    active: plan.active,
  };
}

/**
 * Facturation de l'abonnement des établissements par le super-administrateur. Les factures
 * reposent sur des chiffres agrégés (effectif inscrit, modules activés) : aucune donnée
 * nominative d'élève n'est lue ni renvoyée.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ——— Catalogue des offres ———

  async listPlans() {
    const plans = await this.db.subscriptionPlan.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return plans.map(presentPlan);
  }

  async createPlan(input: z.infer<typeof subscriptionPlanSchema>) {
    const exists = await this.db.subscriptionPlan.findUnique({ where: { name: input.name } });
    if (exists) throw new ConflictException('Une offre porte déjà ce nom');
    const plan = await this.db.subscriptionPlan.create({
      data: {
        name: input.name,
        pricing: input.pricing,
        pricePerStudent: input.pricing === 'PER_STUDENT' ? input.pricePerStudent : 0,
        modulePrices: input.pricing === 'PER_MODULE' ? input.modulePrices : {},
      },
    });
    await this.audit.log({
      action: 'platform.subscription_plan_created',
      entity: 'SubscriptionPlan',
      entityId: plan.id,
      schoolId: null,
      after: presentPlan(plan),
    });
    return presentPlan(plan);
  }

  async archivePlan(id: string) {
    const plan = await this.db.subscriptionPlan.update({ where: { id }, data: { active: false } });
    await this.audit.log({
      action: 'platform.subscription_plan_archived',
      entity: 'SubscriptionPlan',
      entityId: id,
      schoolId: null,
    });
    return presentPlan(plan);
  }

  // ——— Chiffres agrégés d'un établissement ———

  /** Effectif inscrit (inscrits et redoublants) d'une année : un simple décompte. */
  private async studentCount(schoolId: string, period?: string) {
    return runAsSystem(
      'billing-count',
      async () => {
        const year = await this.db.academicYear.findFirst({
          where: period ? { name: period } : { isCurrent: true },
          select: { id: true, name: true },
        });
        if (!year) return null;
        const count = await this.db.enrollment.count({
          where: { academicYearId: year.id, status: { in: ['ENROLLED', 'REPEATING'] } },
        });
        return { period: year.name, count };
      },
      schoolId,
    );
  }

  private async schoolOrThrow(schoolId: string) {
    const school = await this.db.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true, city: true, status: true, modules: true, phone: true },
    });
    if (!school) throw new NotFoundException('Établissement introuvable');
    return school;
  }

  private async invoicesOf(schoolId: string) {
    const rows = await runAsSystem(
      'billing-invoices',
      () =>
        this.db.subscriptionInvoice.findMany({
          include: { payments: true, reminders: true },
          orderBy: { issuedAt: 'desc' },
        }),
      schoolId,
    );
    return rows.map((r) => presentInvoice(r));
  }

  private async subscriptionOf(schoolId: string) {
    return runAsSystem(
      'billing-subscription',
      () => this.db.schoolSubscription.findFirst({ include: { plan: true } }),
      schoolId,
    );
  }

  /** Aperçu de la prochaine facture (sans l'émettre). */
  private async preview(
    school: { id: string; modules: string[] },
    plan: SubscriptionPlan | null,
    period?: string,
  ) {
    const counted = await this.studentCount(school.id, period);
    if (!plan || !counted)
      return {
        period: counted?.period ?? null,
        studentCount: counted?.count ?? 0,
        lines: [],
        total: null,
      };
    const { lines, total } = computeSubscriptionInvoice({
      pricing: plan.pricing,
      pricePerStudent: plan.pricePerStudent,
      modulePrices: plan.modulePrices as Record<string, number>,
      studentCount: counted.count,
      modules: school.modules,
    });
    return { period: counted.period, studentCount: counted.count, lines, total };
  }

  // ——— Vue du super-administrateur ———

  async overview() {
    const schools = await this.db.school.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, city: true, status: true, modules: true },
    });
    const rows = await Promise.all(
      schools.map(async (school) => {
        const [subscription, invoices] = await Promise.all([
          this.subscriptionOf(school.id),
          this.invoicesOf(school.id),
        ]);
        const preview = await this.preview(school, subscription?.plan ?? null);
        const live = invoices.filter((i) => i.state !== 'CANCELLED');
        return {
          id: school.id,
          name: school.name,
          city: school.city,
          status: school.status,
          modulesCount: school.modules.length,
          studentCount: preview.studentCount,
          plan: subscription ? { id: subscription.plan.id, name: subscription.plan.name } : null,
          estimate: preview.total,
          invoiced: live.reduce((s, i) => s + i.amount, 0),
          paid: live.reduce((s, i) => s + i.paid, 0),
          due: live.reduce((s, i) => s + i.due, 0),
          latest: live[0] ? { number: live[0].number, state: live[0].state } : null,
          warning: warningFor(invoices),
        };
      }),
    );
    return {
      summary: {
        schools: rows.length,
        invoiced: rows.reduce((s, r) => s + r.invoiced, 0),
        paid: rows.reduce((s, r) => s + r.paid, 0),
        due: rows.reduce((s, r) => s + r.due, 0),
        overdue: rows.filter((r) => r.warning?.level === 'overdue').length,
      },
      schools: rows,
    };
  }

  async schoolDetail(schoolId: string) {
    const school = await this.schoolOrThrow(schoolId);
    const [subscription, invoices] = await Promise.all([
      this.subscriptionOf(schoolId),
      this.invoicesOf(schoolId),
    ]);
    return {
      school: {
        id: school.id,
        name: school.name,
        city: school.city,
        status: school.status,
        modules: school.modules,
      },
      plan: subscription ? presentPlan(subscription.plan) : null,
      preview: await this.preview(school, subscription?.plan ?? null),
      invoices,
      warning: warningFor(invoices),
    };
  }

  async assignPlan(schoolId: string, planId: string) {
    await this.schoolOrThrow(schoolId);
    const plan = await this.db.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan?.active) throw new BadRequestException('Offre inconnue ou archivée');
    return runAsSystem(
      'billing-assign',
      async () => {
        const before = await this.db.schoolSubscription.findFirst({ include: { plan: true } });
        await this.db.schoolSubscription.upsert({
          where: { schoolId },
          create: { schoolId, planId },
          update: { planId },
        });
        await this.audit.log({
          action: 'platform.subscription_assigned',
          entity: 'SchoolSubscription',
          entityId: schoolId,
          before: before ? { plan: before.plan.name } : undefined,
          after: { plan: plan.name },
        });
        return this.schoolDetail(schoolId);
      },
      schoolId,
    );
  }

  async issueInvoice(schoolId: string, input: { period?: string; dueDate: string }) {
    const school = await this.schoolOrThrow(schoolId);
    const subscription = await this.subscriptionOf(schoolId);
    if (!subscription)
      throw new BadRequestException('Choisissez d’abord une offre pour cet établissement');
    const preview = await this.preview(school, subscription.plan, input.period);
    if (!preview.period || preview.total === null)
      throw new BadRequestException(
        input.period
          ? `Année scolaire ${input.period} introuvable dans cet établissement`
          : 'Aucune année scolaire en cours dans cet établissement',
      );
    const period = preview.period;
    const total = preview.total;
    const actorId = currentActorId() ?? null;
    try {
      return await runAsSystem(
        'billing-issue',
        () =>
          this.db.$transaction(async (tx) => {
            const year = Number(period.slice(0, 4));
            const seq = await this.nextInvoiceNumber(tx, year);
            const invoice = await tx.subscriptionInvoice.create({
              data: {
                schoolId,
                number: `ABO-${year}-${String(seq).padStart(4, '0')}`,
                period,
                planName: subscription.plan.name,
                pricing: subscription.plan.pricing,
                studentCount: preview.studentCount,
                modules: school.modules,
                lines: preview.lines as unknown as Prisma.InputJsonValue,
                amount: total,
                dueDate: toDbDate(input.dueDate),
                issuedById: actorId,
              },
              include: { payments: true, reminders: true },
            });
            await this.audit.log(
              {
                action: 'platform.subscription_invoice_issued',
                entity: 'SubscriptionInvoice',
                entityId: invoice.id,
                after: {
                  number: invoice.number,
                  period,
                  amount: total,
                  studentCount: preview.studentCount,
                  modules: school.modules,
                },
              },
              tx,
            );
            return presentInvoice(invoice);
          }),
        schoolId,
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException(
          `Une facture est déjà émise pour ${period} : annulez-la avant d’en émettre une nouvelle`,
        );
      throw e;
    }
  }

  /** Numérotation commune à la plateforme, sans trou ni doublon. */
  private async nextInvoiceNumber(tx: Tx, year: number): Promise<number> {
    const rows = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO "Counter" ("schoolId", "key", "value") VALUES ('__platform__', ${`subscription-invoice:${year}`}, 1)
      ON CONFLICT ("schoolId", "key") DO UPDATE SET "value" = "Counter"."value" + 1
      RETURNING "value"`;
    const value = rows[0]?.value;
    if (value === undefined) throw new Error('Compteur indisponible');
    return Number(value);
  }

  /** Facture d'un établissement, lue dans son périmètre. */
  private async invoiceOrThrow(invoiceId: string) {
    const invoice = await this.db.subscriptionInvoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true, reminders: true },
    });
    if (!invoice) throw new NotFoundException('Facture introuvable');
    return invoice;
  }

  async recordPayment(invoiceId: string, input: z.infer<typeof subscriptionPaymentSchema>) {
    const invoice = await this.invoiceOrThrow(invoiceId);
    if (invoice.status === 'CANCELLED')
      throw new BadRequestException('Facture annulée : aucun règlement possible');
    const current = presentInvoice(invoice);
    if (input.amount > current.due)
      throw new BadRequestException(`Le règlement dépasse le reste à payer (${current.due} FCFA)`);
    return runAsSystem(
      'billing-payment',
      () =>
        this.db.$transaction(async (tx) => {
          // Verrou de la facture : deux saisies simultanées ne dépassent pas le reste à payer.
          await tx.$queryRaw`SELECT "id" FROM "SubscriptionInvoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
          const fresh = presentInvoice(
            await tx.subscriptionInvoice.findUniqueOrThrow({
              where: { id: invoiceId },
              include: { payments: true, reminders: true },
            }),
          );
          // Annulation concurrente : relue sous le verrou.
          if (fresh.state === 'CANCELLED')
            throw new BadRequestException('Facture annulée : aucun règlement possible');
          if (input.amount > fresh.due)
            throw new BadRequestException(
              `Le règlement dépasse le reste à payer (${fresh.due} FCFA)`,
            );
          const payment = await tx.subscriptionPayment.create({
            data: {
              schoolId: invoice.schoolId,
              invoiceId,
              amount: input.amount,
              method: input.method,
              reference: input.reference || null,
              paidOn: toDbDate(input.paidOn),
              note: input.note || null,
              recordedById: currentActorId() ?? null,
            },
          });
          await this.audit.log(
            {
              action: 'platform.subscription_payment_recorded',
              entity: 'SubscriptionPayment',
              entityId: payment.id,
              after: { invoice: invoice.number, amount: input.amount, method: input.method },
            },
            tx,
          );
          return presentInvoice(
            await tx.subscriptionInvoice.findUniqueOrThrow({
              where: { id: invoiceId },
              include: { payments: true, reminders: true },
            }),
          );
        }),
      invoice.schoolId,
    );
  }

  /** Correction d'un règlement : écriture négative, le règlement d'origine reste intact. */
  async correctPayment(paymentId: string, reason: string) {
    const original: SubscriptionPayment | null = await this.db.subscriptionPayment.findUnique({
      where: { id: paymentId },
    });
    if (!original) throw new NotFoundException('Règlement introuvable');
    if (original.amount <= 0 || original.correctsId)
      throw new BadRequestException('Une écriture de correction ne se corrige pas');
    try {
      return await runAsSystem(
        'billing-correct',
        () =>
          this.db.$transaction(async (tx) => {
            const correction = await tx.subscriptionPayment.create({
              data: {
                schoolId: original.schoolId,
                invoiceId: original.invoiceId,
                amount: -original.amount,
                method: original.method,
                reference: original.reference,
                paidOn: toDbDate(todayInCameroon()),
                note: reason,
                correctsId: original.id,
                recordedById: currentActorId() ?? null,
              },
            });
            await this.audit.log(
              {
                action: 'platform.subscription_payment_corrected',
                entity: 'SubscriptionPayment',
                entityId: original.id,
                reason,
                after: { correctionId: correction.id, amount: -original.amount },
              },
              tx,
            );
            return presentInvoice(
              await tx.subscriptionInvoice.findUniqueOrThrow({
                where: { id: original.invoiceId },
                include: { payments: true, reminders: true },
              }),
            );
          }),
        original.schoolId,
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('Ce règlement a déjà été corrigé');
      throw e;
    }
  }

  async cancelInvoice(invoiceId: string, reason: string) {
    const invoice = await this.invoiceOrThrow(invoiceId);
    if (invoice.status === 'CANCELLED') throw new BadRequestException('Facture déjà annulée');
    if (presentInvoice(invoice).paid > 0)
      throw new BadRequestException('Corrigez d’abord les règlements de cette facture');
    return runAsSystem(
      'billing-cancel',
      () =>
        this.db.$transaction(async (tx) => {
          // Même verrou que l'enregistrement d'un règlement : pas d'annulation pendant qu'un
          // règlement est saisi, ni de règlement sur une facture en cours d'annulation.
          await tx.$queryRaw`SELECT "id" FROM "SubscriptionInvoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
          const fresh = presentInvoice(
            await tx.subscriptionInvoice.findUniqueOrThrow({
              where: { id: invoiceId },
              include: { payments: true, reminders: true },
            }),
          );
          if (fresh.state === 'CANCELLED') throw new BadRequestException('Facture déjà annulée');
          if (fresh.paid > 0)
            throw new BadRequestException('Corrigez d’abord les règlements de cette facture');
          const updated = await tx.subscriptionInvoice.update({
            where: { id: invoiceId },
            data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason },
            include: { payments: true, reminders: true },
          });
          await this.audit.log(
            {
              action: 'platform.subscription_invoice_cancelled',
              entity: 'SubscriptionInvoice',
              entityId: invoiceId,
              reason,
            },
            tx,
          );
          return presentInvoice(updated);
        }),
      invoice.schoolId,
    );
  }

  /** Relance : SMS au numéro de l'établissement (table d'envoi), et trace visible de la direction. */
  async remind(invoiceId: string) {
    const invoice = await this.invoiceOrThrow(invoiceId);
    const current = presentInvoice(invoice);
    if (current.state === 'CANCELLED' || current.due === 0)
      throw new BadRequestException('Rien à relancer sur cette facture');
    const school = await this.schoolOrThrow(invoice.schoolId);
    const recipient = school.phone || (await this.directorPhone(invoice.schoolId));
    return runAsSystem(
      'billing-remind',
      () =>
        this.db.$transaction(async (tx) => {
          await tx.subscriptionReminder.create({
            data: {
              schoolId: invoice.schoolId,
              invoiceId,
              sentById: currentActorId() ?? null,
              recipient,
            },
          });
          if (recipient)
            await this.notifications.enqueue(
              {
                schoolId: invoice.schoolId,
                recipient,
                template: 'subscriptionReminder',
                body: templates.subscriptionReminder({
                  school: school.name,
                  number: invoice.number,
                  due: current.due,
                  dueDate: current.dueDate.split('-').reverse().join('/'),
                }),
                payload: { invoiceId },
              },
              tx,
            );
          await this.audit.log(
            {
              action: 'platform.subscription_reminder_sent',
              entity: 'SubscriptionInvoice',
              entityId: invoiceId,
              after: { due: current.due, sms: !!recipient },
            },
            tx,
          );
          return presentInvoice(
            await tx.subscriptionInvoice.findUniqueOrThrow({
              where: { id: invoiceId },
              include: { payments: true, reminders: true },
            }),
          );
        }),
      invoice.schoolId,
    );
  }

  private async directorPhone(schoolId: string): Promise<string | null> {
    const m = await this.db.membership.findFirst({
      where: { schoolId, active: true, roles: { has: 'DIRECTOR' }, user: { phone: { not: null } } },
      select: { user: { select: { phone: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return m?.user.phone ?? null;
  }

  // ——— Vue de la direction (périmètre de son établissement) ———

  async forCurrentSchool() {
    const schoolId = currentSchoolId();
    const [subscription, rows] = await Promise.all([
      this.db.schoolSubscription.findFirst({ include: { plan: true } }),
      this.db.subscriptionInvoice.findMany({
        include: { payments: true, reminders: true },
        orderBy: { issuedAt: 'desc' },
      }),
    ]);
    const invoices = rows.map((r) => presentInvoice(r));
    return {
      schoolId,
      plan: subscription ? presentPlan(subscription.plan) : null,
      invoices,
      warning: warningFor(invoices),
    };
  }
}
