import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  absenceDeduction,
  advanceInstallment,
  allocateAdvanceDeduction,
  computePayslip,
  contractDaysInMonth,
  DEFAULT_PAYROLL_SCALE,
  daysInMonth,
  formatPayrollMonth,
  payForMinutes,
  payrollMonthBounds,
  prorateMonthly,
  type advanceCreateSchema,
  type ContractType,
  type PayElement,
  type PayrollScale,
  type payrollScaleSchema,
  type PayslipResult,
} from '@ecole/shared';
import type { EmploymentContract, Payslip, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { fromDbDate, toDbDate } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { NotificationsService } from '../notifications/notifications.service';
import { decryptSensitive } from './employees.service';
import { HoursService, type MonthTotals } from './hours.service';
import type { PayslipBatch, TransferRow } from './payroll.exports';

/** Entrées figées d'un bulletin : tout ce qu'il faut pour le recalculer et l'imprimer. */
export interface PayslipInputs {
  employee: { firstName: string; lastName: string; position: string; hireDate: string };
  contract: {
    id: string;
    type: ContractType;
    startDate: string;
    endDate: string | null;
    baseSalary: number | null;
    hourlyRate: number | null;
    overtimeRate: number | null;
  };
  activeDays: number;
  daysInMonth: number;
  hours: MonthTotals;
  /** Salaire de base du mois avant retenue (proratisé) ou paie des heures faites. */
  baseEarned: number;
  overtimePay: number;
  advances: { id: string; due: number }[];
  /** Retenues effectives par avance (après limite au net). */
  advanceAllocations: { id: string; amount: number }[];
}

const payrollUserSelect = { id: true, firstName: true, lastName: true } as const;

@Injectable()
export class PayrollService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly hours: HoursService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Barèmes
  // -------------------------------------------------------------------------------------------

  async scales() {
    const rows = await this.db.payrollScale.findMany({ orderBy: { effectiveFrom: 'desc' } });
    return {
      default: DEFAULT_PAYROLL_SCALE,
      versions: rows.map((r) => ({
        id: r.id,
        effectiveFrom: fromDbDate(r.effectiveFrom),
        label: r.label,
        config: r.config as unknown as PayrollScale,
        createdAt: r.createdAt,
      })),
    };
  }

  /** Barème applicable au mois : dernière version de l'école en vigueur, sinon le barème par défaut. */
  async scaleFor(month: string, tx?: Tx): Promise<PayrollScale> {
    const row = await (tx ?? this.db).payrollScale.findFirst({
      where: { effectiveFrom: { lte: toDbDate(payrollMonthBounds(month).last) } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return row ? (row.config as unknown as PayrollScale) : DEFAULT_PAYROLL_SCALE;
  }

  /** Nouvelle version datée du barème (les versions précédentes restent inchangées). */
  async addScale(input: z.infer<typeof payrollScaleSchema>) {
    const row = await this.db.payrollScale.create({
      data: {
        schoolId: currentSchoolId(),
        effectiveFrom: toDbDate(input.effectiveFrom),
        label: input.label,
        config: input as unknown as Prisma.InputJsonValue,
        createdById: staffContext().userId,
      },
    });
    await this.audit.log({
      action: 'hr.scale_created',
      entity: 'PayrollScale',
      entityId: row.id,
      after: input,
    });
    return { id: row.id, effectiveFrom: input.effectiveFrom, label: input.label, config: input };
  }

  // -------------------------------------------------------------------------------------------
  // Avances
  // -------------------------------------------------------------------------------------------

  async advances() {
    const rows = await this.db.salaryAdvance.findMany({
      include: { employee: true, repayments: true },
      orderBy: { createdAt: 'desc' },
    });
    const users = await this.db.user.findMany({
      where: { id: { in: rows.map((r) => r.employee.userId) } },
      select: payrollUserSelect,
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((a) => {
      const u = byId.get(a.employee.userId);
      const repaid = a.repayments.reduce((s, r) => s + r.amount, 0);
      return {
        id: a.id,
        employeeId: a.employeeId,
        firstName: u?.firstName ?? '',
        lastName: u?.lastName ?? '',
        amount: a.amount,
        installments: a.installments,
        monthly: advanceInstallment(a.amount, a.installments, 0),
        firstMonth: a.firstMonth,
        reason: a.reason,
        status: a.status,
        repaid,
        remaining: a.amount - repaid,
        requestedById: a.requestedById,
        decidedAt: a.decidedAt,
        decisionNote: a.decisionNote,
        createdAt: a.createdAt,
      };
    });
  }

  async requestAdvance(input: z.infer<typeof advanceCreateSchema>) {
    const file = await this.db.employeeFile.findUnique({ where: { id: input.employeeId } });
    if (!file) throw new NotFoundException('Dossier introuvable');
    const advance = await this.db.salaryAdvance.create({
      data: {
        schoolId: currentSchoolId(),
        employeeId: input.employeeId,
        amount: input.amount,
        installments: input.installments,
        firstMonth: input.firstMonth,
        reason: input.reason,
        requestedById: staffContext().userId,
      },
    });
    await this.audit.log({
      action: 'hr.advance_requested',
      entity: 'SalaryAdvance',
      entityId: advance.id,
      after: input,
    });
    return advance;
  }

  /** Accord ou refus d'une avance par la direction (jamais par la personne qui l'a saisie). */
  async decideAdvance(id: string, approve: boolean, note?: string) {
    const advance = await this.db.salaryAdvance.findUnique({ where: { id } });
    if (!advance) throw new NotFoundException('Avance introuvable');
    if (advance.status !== 'REQUESTED')
      throw new ConflictException('Cette avance a déjà été traitée');
    const actor = staffContext().userId;
    if (advance.requestedById === actor)
      throw new ForbiddenException(
        'L’accord doit venir d’une autre personne que celle qui a saisi la demande',
      );
    const file = await this.db.employeeFile.findUniqueOrThrow({
      where: { id: advance.employeeId },
    });
    if (file.userId === actor)
      throw new ForbiddenException('Vous ne pouvez pas accorder votre propre avance');
    const { count } = await this.db.salaryAdvance.updateMany({
      where: { id, status: 'REQUESTED' },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        decidedById: actor,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    });
    if (count === 0) throw new ConflictException('Cette avance a déjà été traitée');
    await this.audit.log({
      action: approve ? 'hr.advance_approved' : 'hr.advance_rejected',
      entity: 'SalaryAdvance',
      entityId: id,
      after: { amount: advance.amount, installments: advance.installments },
      reason: note,
    });
    return this.db.salaryAdvance.findUniqueOrThrow({ where: { id } });
  }

  // -------------------------------------------------------------------------------------------
  // Paie mensuelle
  // -------------------------------------------------------------------------------------------

  async runs() {
    return this.db.payrollRun.findMany({
      orderBy: { month: 'desc' },
      select: {
        id: true,
        month: true,
        status: true,
        computedAt: true,
        preparedAt: true,
        validatedAt: true,
        _count: { select: { payslips: true } },
      },
    });
  }

  private async findRun(month: string, tx?: Tx) {
    return (tx ?? this.db).payrollRun.findUnique({
      where: { schoolId_month: { schoolId: currentSchoolId(), month } },
      include: { payslips: true },
    });
  }

  private async requireRun(month: string, tx?: Tx) {
    const run = await this.findRun(month, tx);
    if (!run) throw new NotFoundException(`Aucune paie calculée pour ${formatPayrollMonth(month)}`);
    return run;
  }

  async requireValidated(month: string) {
    const run = await this.requireRun(month);
    if (run.status !== 'VALIDATED')
      throw new ConflictException(
        'Bulletins et état des virements disponibles seulement après validation par la direction',
      );
    return run;
  }

  private async names(ids: (string | null | undefined)[]) {
    const users = await this.db.user.findMany({
      where: { id: { in: ids.filter((i): i is string => !!i) } },
      select: payrollUserSelect,
    });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  }

  payslipView(p: Payslip) {
    const inputs = p.inputs as unknown as PayslipInputs;
    return {
      id: p.id,
      employeeId: p.employeeId,
      number: p.number,
      firstName: inputs.employee.firstName,
      lastName: inputs.employee.lastName,
      position: inputs.employee.position,
      contractType: p.contractType,
      elements: p.elements as unknown as PayElement[],
      absenceDays: p.absenceDays,
      inputs,
      result: p.result as unknown as PayslipResult,
      gross: p.gross,
      net: p.net,
      employerCost: p.employerCost,
    };
  }

  async get(month: string) {
    const run = await this.findRun(month);
    if (!run)
      return { month, status: null, payslips: [], totals: null, scale: await this.scaleFor(month) };
    const names = await this.names([
      run.computedById,
      run.preparedById,
      run.validatedById,
      run.rejectedById,
    ]);
    const payslips = run.payslips
      .map((p) => this.payslipView(p))
      .sort((a, b) => a.lastName.localeCompare(b.lastName, 'fr'));
    return {
      month,
      id: run.id,
      status: run.status,
      scale: run.scale as unknown as PayrollScale,
      computedAt: run.computedAt,
      computedBy: names.get(run.computedById) ?? null,
      computedById: run.computedById,
      preparedAt: run.preparedAt,
      preparedBy: run.preparedById ? (names.get(run.preparedById) ?? null) : null,
      preparedById: run.preparedById,
      validatedAt: run.validatedAt,
      validatedBy: run.validatedById ? (names.get(run.validatedById) ?? null) : null,
      rejectedAt: run.rejectedAt,
      rejectedBy: run.rejectedById ? (names.get(run.rejectedById) ?? null) : null,
      rejectReason: run.rejectReason,
      totals: {
        headcount: payslips.length,
        gross: payslips.reduce((s, p) => s + p.gross, 0),
        net: payslips.reduce((s, p) => s + p.net, 0),
        employerCost: payslips.reduce((s, p) => s + p.employerCost, 0),
      },
      payslips,
    };
  }

  /** Contrat retenu pour le mois : le plus récent couvrant au moins un jour du mois. */
  private pickContract(contracts: EmploymentContract[], month: string) {
    return contracts
      .map((c) => ({
        c,
        days: contractDaysInMonth(
          month,
          fromDbDate(c.startDate),
          c.endDate ? fromDbDate(c.endDate) : null,
        ),
      }))
      .filter((x) => x.days > 0)
      .sort((a, b) => b.c.startDate.getTime() - a.c.startDate.getTime())[0];
  }

  /** Calcule un bulletin à partir des entrées figées et des éléments saisis. */
  private compute(
    inputs: Omit<PayslipInputs, 'advanceAllocations'>,
    elements: PayElement[],
    absenceDays: number,
    scale: PayrollScale,
  ) {
    const salaried = inputs.contract.type !== 'HOURLY';
    const deduction = salaried
      ? absenceDeduction({
          base: inputs.baseEarned,
          plannedMinutes: inputs.hours.plannedMinutes,
          unjustifiedMinutes: inputs.hours.absentUnjustifiedMinutes,
          unjustifiedDays: absenceDays,
        })
      : 0;
    const result = computePayslip(
      {
        contractType: inputs.contract.type,
        baseEarned: inputs.baseEarned,
        overtimePay: inputs.overtimePay,
        absenceDeduction: deduction,
        elements,
        advanceDue: inputs.advances.reduce((s, a) => s + a.due, 0),
      },
      scale,
    );
    const advanceAllocations = allocateAdvanceDeduction(result.advanceDeduction, inputs.advances);
    return { result, inputs: { ...inputs, advanceAllocations } satisfies PayslipInputs };
  }

  /** Calcule (ou recalcule) la paie du mois en préparation ; conserve les éléments déjà saisis. */
  async computeMonth(month: string) {
    const actor = staffContext().userId;
    const schoolId = currentSchoolId();
    const existing = await this.findRun(month);
    if (existing && existing.status !== 'DRAFT')
      throw new ConflictException(
        existing.status === 'VALIDATED'
          ? 'Paie validée : elle est figée. Corrigez par un rappel sur le mois suivant.'
          : 'Paie en attente de validation : demandez à la direction de la valider ou de la renvoyer.',
      );
    const scale = await this.scaleFor(month);
    const files = await this.db.employeeFile.findMany({ include: { contracts: true } });
    const users = await this.db.user.findMany({
      where: { id: { in: files.map((f) => f.userId) } },
      select: payrollUserSelect,
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const advances = await this.db.salaryAdvance.findMany({
      where: { status: 'APPROVED', firstMonth: { lte: month } },
      include: { repayments: true },
      orderBy: { createdAt: 'asc' },
    });
    const previous = new Map((existing?.payslips ?? []).map((p) => [p.employeeId, p]));
    const dim = daysInMonth(month);

    const rows: {
      employeeId: string;
      contractType: ContractType;
      elements: PayElement[];
      absenceDays: number;
      inputs: PayslipInputs;
      result: PayslipResult;
    }[] = [];
    for (const f of files) {
      const picked = this.pickContract(f.contracts, month);
      if (!picked) continue;
      const { c, days } = picked;
      const user = userById.get(f.userId);
      const hours = await this.hours.totals(f.userId, month);
      const baseEarned =
        c.type === 'HOURLY'
          ? payForMinutes(c.hourlyRate ?? 0, hours.doneMinutes)
          : prorateMonthly(c.baseSalary ?? 0, days, dim);
      const overtimePay = payForMinutes(
        c.overtimeRate ?? (c.type === 'HOURLY' ? (c.hourlyRate ?? 0) : 0),
        hours.overtimeMinutes,
      );
      const dues = advances
        .filter((a) => a.employeeId === f.id)
        .map((a) => ({
          id: a.id,
          due: advanceInstallment(
            a.amount,
            a.installments,
            a.repayments.reduce((s, r) => s + r.amount, 0),
          ),
        }))
        .filter((d) => d.due > 0);
      const prev = previous.get(f.id);
      const elements = (prev?.elements as unknown as PayElement[] | undefined) ?? [];
      const absenceDays = prev?.absenceDays ?? 0;
      const { result, inputs } = this.compute(
        {
          employee: {
            firstName: user?.firstName ?? '',
            lastName: user?.lastName ?? '',
            position: f.position,
            hireDate: fromDbDate(f.hireDate),
          },
          contract: {
            id: c.id,
            type: c.type,
            startDate: fromDbDate(c.startDate),
            endDate: c.endDate ? fromDbDate(c.endDate) : null,
            baseSalary: c.baseSalary,
            hourlyRate: c.hourlyRate,
            overtimeRate: c.overtimeRate,
          },
          activeDays: days,
          daysInMonth: dim,
          hours,
          baseEarned,
          overtimePay,
          advances: dues,
        },
        elements,
        absenceDays,
        scale,
      );
      rows.push({ employeeId: f.id, contractType: c.type, elements, absenceDays, inputs, result });
    }

    const run = await this.db.$transaction(async (tx) => {
      const r = existing
        ? await tx.payrollRun.update({
            where: { id: existing.id },
            data: {
              scale: scale as unknown as Prisma.InputJsonValue,
              computedById: actor,
              computedAt: new Date(),
            },
          })
        : await tx.payrollRun.create({
            data: {
              schoolId,
              month,
              scale: scale as unknown as Prisma.InputJsonValue,
              computedById: actor,
            },
          });
      await tx.payslip.deleteMany({
        where: { runId: r.id, employeeId: { notIn: rows.map((x) => x.employeeId) } },
      });
      for (const x of rows) {
        const data = {
          contractType: x.contractType,
          elements: x.elements as unknown as Prisma.InputJsonValue,
          absenceDays: x.absenceDays,
          inputs: x.inputs as unknown as Prisma.InputJsonValue,
          result: x.result as unknown as Prisma.InputJsonValue,
          gross: x.result.gross,
          net: x.result.net,
          employerCost: x.result.employerCost,
        };
        await tx.payslip.upsert({
          where: { runId_employeeId: { runId: r.id, employeeId: x.employeeId } },
          create: { schoolId, runId: r.id, employeeId: x.employeeId, ...data },
          update: data,
        });
      }
      return r;
    });
    await this.audit.log({
      action: 'hr.payroll_computed',
      entity: 'PayrollRun',
      entityId: run.id,
      after: {
        month,
        headcount: rows.length,
        gross: rows.reduce((s, x) => s + x.result.gross, 0),
        net: rows.reduce((s, x) => s + x.result.net, 0),
      },
    });
    return this.get(month);
  }

  /** Saisie des primes, indemnités, rappels et jours d'absence d'un bulletin en préparation. */
  async updatePayslip(
    month: string,
    payslipId: string,
    elements: PayElement[],
    absenceDays: number,
  ) {
    const run = await this.requireRun(month);
    if (run.status !== 'DRAFT')
      throw new ConflictException('Seule une paie en préparation peut être modifiée');
    const slip = run.payslips.find((p) => p.id === payslipId);
    if (!slip) throw new NotFoundException('Bulletin introuvable');
    const stored = slip.inputs as unknown as PayslipInputs;
    const { result, inputs } = this.compute(
      stored,
      elements,
      absenceDays,
      run.scale as unknown as PayrollScale,
    );
    const updated = await this.db.payslip.update({
      where: { id: slip.id },
      data: {
        elements: elements as unknown as Prisma.InputJsonValue,
        absenceDays,
        inputs: inputs as unknown as Prisma.InputJsonValue,
        result: result as unknown as Prisma.InputJsonValue,
        gross: result.gross,
        net: result.net,
        employerCost: result.employerCost,
      },
    });
    await this.audit.log({
      action: 'hr.payslip_updated',
      entity: 'Payslip',
      entityId: slip.id,
      before: { elements: slip.elements, absenceDays: slip.absenceDays, net: slip.net },
      after: { elements, absenceDays, net: result.net },
    });
    return this.payslipView(updated);
  }

  private async contacts(userIds: string[]) {
    return this.db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, phone: true },
    });
  }

  /** La comptabilité soumet la paie à la validation de la direction. */
  async submit(month: string) {
    const actor = staffContext().userId;
    const schoolId = currentSchoolId();
    const run = await this.requireRun(month);
    if (run.status !== 'DRAFT') throw new ConflictException('Cette paie a déjà été soumise');
    if (run.payslips.length === 0)
      throw new BadRequestException('Aucun bulletin : vérifiez les dossiers et les contrats');
    const school = await this.db.school.findUniqueOrThrow({ where: { id: schoolId } });
    const directors = await this.db.membership.findMany({
      where: { schoolId, roles: { has: 'DIRECTOR' }, active: true, userId: { not: actor } },
      select: { userId: true },
    });
    const contacts = await this.contacts(directors.map((d) => d.userId));
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.payrollRun.updateMany({
        where: { id: run.id, status: 'DRAFT' },
        data: { status: 'PREPARED', preparedById: actor, preparedAt: new Date() },
      });
      if (count === 0) throw new ConflictException('Cette paie a déjà été soumise');
      const preferred = await this.notifications.preferredChannel(schoolId, tx);
      for (const c of contacts) {
        await this.notifications.notifyContact(
          {
            schoolId,
            contact: c,
            template: 'payrollSubmitted',
            subject: `Paie de ${formatPayrollMonth(month)} à valider`,
            body: `${school.name} : la paie de ${formatPayrollMonth(month)} est prête et attend votre validation dans Ecole.`,
            payload: { month },
          },
          tx,
          preferred,
        );
      }
      await this.audit.log(
        {
          action: 'hr.payroll_submitted',
          entity: 'PayrollRun',
          entityId: run.id,
          after: { month, headcount: run.payslips.length },
        },
        tx,
      );
    });
    return this.get(month);
  }

  /** Validation par la direction : une autre personne que celle qui a préparé. Fige la paie. */
  async validate(month: string) {
    const actor = staffContext().userId;
    const schoolId = currentSchoolId();
    const run = await this.requireRun(month);
    if (run.status === 'VALIDATED') throw new ConflictException('Cette paie est déjà validée');
    if (run.status !== 'PREPARED')
      throw new ConflictException('La comptabilité doit d’abord soumettre la paie');
    if (run.preparedById === actor || run.computedById === actor)
      throw new ForbiddenException(
        'La validation doit être faite par une autre personne que celle qui a préparé la paie',
      );
    const school = await this.db.school.findUniqueOrThrow({ where: { id: schoolId } });
    const preparer = run.preparedById ? await this.contacts([run.preparedById]) : [];
    const slips = [...run.payslips].sort((a, b) => {
      const ia = a.inputs as unknown as PayslipInputs;
      const ib = b.inputs as unknown as PayslipInputs;
      return `${ia.employee.lastName} ${ia.employee.firstName}`.localeCompare(
        `${ib.employee.lastName} ${ib.employee.firstName}`,
        'fr',
      );
    });
    await this.db.$transaction(async (tx) => {
      // Numérotation et remboursements d'avances avant de figer la paie.
      for (const [i, p] of slips.entries()) {
        await tx.payslip.update({
          where: { id: p.id },
          data: { number: `PAIE-${month}-${String(i + 1).padStart(4, '0')}` },
        });
        const inputs = p.inputs as unknown as PayslipInputs;
        for (const a of inputs.advanceAllocations) {
          await tx.advanceRepayment.create({
            data: { schoolId, advanceId: a.id, payslipId: p.id, month, amount: a.amount },
          });
        }
      }
      const touched = [
        ...new Set(
          slips.flatMap((p) =>
            (p.inputs as unknown as PayslipInputs).advanceAllocations.map((a) => a.id),
          ),
        ),
      ];
      for (const id of touched) {
        const a = await tx.salaryAdvance.findUniqueOrThrow({
          where: { id },
          include: { repayments: true },
        });
        if (a.repayments.reduce((s, r) => s + r.amount, 0) >= a.amount)
          await tx.salaryAdvance.update({ where: { id }, data: { status: 'REPAID' } });
      }
      const { count } = await tx.payrollRun.updateMany({
        where: { id: run.id, status: 'PREPARED' },
        data: { status: 'VALIDATED', validatedById: actor, validatedAt: new Date() },
      });
      if (count === 0) throw new ConflictException('Cette paie a changé entre-temps');
      for (const c of preparer) {
        await this.notifications.notifyContact(
          {
            schoolId,
            contact: c,
            template: 'payrollValidated',
            subject: `Paie de ${formatPayrollMonth(month)} validée`,
            body: `${school.name} : la paie de ${formatPayrollMonth(month)} est validée. Bulletins et état des virements sont disponibles dans Ecole.`,
            payload: { month },
          },
          tx,
        );
      }
      await this.audit.log(
        {
          action: 'hr.payroll_validated',
          entity: 'PayrollRun',
          entityId: run.id,
          after: {
            month,
            headcount: slips.length,
            gross: slips.reduce((s, p) => s + p.gross, 0),
            net: slips.reduce((s, p) => s + p.net, 0),
          },
        },
        tx,
      );
    });
    return this.get(month);
  }

  /** Renvoi à la comptabilité avec un motif. */
  async reject(month: string, reason: string) {
    const actor = staffContext().userId;
    const schoolId = currentSchoolId();
    const run = await this.requireRun(month);
    if (run.status !== 'PREPARED')
      throw new ConflictException('Seule une paie soumise peut être renvoyée');
    if (run.preparedById === actor)
      throw new ForbiddenException(
        'Le renvoi doit venir d’une autre personne que celle qui a préparé la paie',
      );
    const school = await this.db.school.findUniqueOrThrow({ where: { id: schoolId } });
    const preparer = run.preparedById ? await this.contacts([run.preparedById]) : [];
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.payrollRun.updateMany({
        where: { id: run.id, status: 'PREPARED' },
        data: {
          status: 'DRAFT',
          rejectedById: actor,
          rejectedAt: new Date(),
          rejectReason: reason,
          preparedById: null,
          preparedAt: null,
        },
      });
      if (count === 0) throw new ConflictException('Cette paie a changé entre-temps');
      for (const c of preparer) {
        await this.notifications.notifyContact(
          {
            schoolId,
            contact: c,
            template: 'payrollRejected',
            subject: `Paie de ${formatPayrollMonth(month)} à revoir`,
            body: `${school.name} : la direction a renvoyé la paie de ${formatPayrollMonth(month)}. Motif : ${reason}`,
            payload: { month },
          },
          tx,
        );
      }
      await this.audit.log(
        { action: 'hr.payroll_rejected', entity: 'PayrollRun', entityId: run.id, reason },
        tx,
      );
    });
    return this.get(month);
  }

  /**
   * Récapitulatif d'une paie validée, destiné à la comptabilité générale : totaux bruts,
   * cotisations par organisme, avances retenues et net à payer. Rien n'est écrit en comptabilité ici.
   */
  async validatedSummary(month: string) {
    const run = await this.requireValidated(month);
    const results = run.payslips.map((p) => p.result as unknown as PayslipResult);
    const sum = (f: (r: PayslipResult) => number) => results.reduce((s, r) => s + f(r), 0);
    return {
      month,
      status: run.status,
      validatedAt: run.validatedAt,
      validatedById: run.validatedById,
      preparedById: run.preparedById,
      headcount: results.length,
      gross: sum((r) => r.gross),
      grossTaxable: sum((r) => r.grossTaxable),
      nonTaxable: sum((r) => r.nonTaxableElements),
      employee: {
        cnps: sum((r) => r.employee.cnps),
        housing: sum((r) => r.employee.housing),
        irpp: sum((r) => r.employee.irpp),
        cac: sum((r) => r.employee.cac),
        audiovisual: sum((r) => r.employee.audiovisual),
        communal: sum((r) => r.employee.communal),
        total: sum((r) => r.employee.total),
      },
      employer: {
        pension: sum((r) => r.employer.pension),
        family: sum((r) => r.employer.family),
        accident: sum((r) => r.employer.accident),
        housing: sum((r) => r.employer.housing),
        employment: sum((r) => r.employer.employment),
        total: sum((r) => r.employer.total),
      },
      advances: sum((r) => r.advanceDeduction),
      net: sum((r) => r.net),
      employerCost: sum((r) => r.employerCost),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Bulletins et état des virements (paie validée uniquement)
  // -------------------------------------------------------------------------------------------

  private async sensitiveByEmployee(employeeIds: string[]) {
    const files = await this.db.employeeFile.findMany({ where: { id: { in: employeeIds } } });
    return new Map(
      files.map((f) => [f.id, { file: f, data: decryptSensitive(f.encryptedSensitive) }]),
    );
  }

  async printable(month: string, payslipId?: string): Promise<PayslipBatch> {
    const run = await this.requireValidated(month);
    const slips = payslipId ? run.payslips.filter((p) => p.id === payslipId) : run.payslips;
    if (payslipId && slips.length === 0) throw new NotFoundException('Bulletin introuvable');
    const school = await this.db.school.findUniqueOrThrow({ where: { id: currentSchoolId() } });
    const sensitive = await this.sensitiveByEmployee(slips.map((p) => p.employeeId));
    const names = await this.names([run.validatedById]);
    return {
      school: { name: school.name, city: school.city },
      month,
      scale: run.scale as unknown as PayrollScale,
      validatedAt: run.validatedAt,
      validatedBy: run.validatedById ? (names.get(run.validatedById) ?? null) : null,
      slips: slips
        .map((p) => ({
          number: p.number,
          inputs: p.inputs as unknown as PayslipInputs,
          elements: p.elements as unknown as PayElement[],
          absenceDays: p.absenceDays,
          result: p.result as unknown as PayslipResult,
          cnpsNumber: sensitive.get(p.employeeId)?.data.cnpsNumber ?? null,
        }))
        .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '')),
    };
  }

  /** Lignes de l'état des virements : coordonnées de paiement déchiffrées, net à payer. */
  async transferRows(month: string): Promise<{ school: string; rows: TransferRow[] }> {
    const run = await this.requireValidated(month);
    const school = await this.db.school.findUniqueOrThrow({ where: { id: currentSchoolId() } });
    const sensitive = await this.sensitiveByEmployee(run.payslips.map((p) => p.employeeId));
    const rows = run.payslips
      .filter((p) => p.net > 0)
      .map((p) => {
        const inputs = p.inputs as unknown as PayslipInputs;
        const s = sensitive.get(p.employeeId);
        const method = s?.file.payoutMethod ?? 'CASH';
        return {
          number: p.number,
          lastName: inputs.employee.lastName,
          firstName: inputs.employee.firstName,
          position: inputs.employee.position,
          method,
          bankName: method === 'BANK' ? (s?.data.bankName ?? null) : null,
          account:
            method === 'BANK'
              ? (s?.data.bankAccount ?? null)
              : method === 'MOBILE_MONEY'
                ? (s?.data.mobileMoneyNumber ?? null)
                : null,
          operator: method === 'MOBILE_MONEY' ? (s?.data.mobileMoneyOperator ?? null) : null,
          net: p.net,
        };
      })
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? ''));
    return { school: school.name, rows };
  }
}
