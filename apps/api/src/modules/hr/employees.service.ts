import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CDD_ALERT_DAYS,
  daysUntil,
  employeeCreateSchema,
  employeeSensitiveSchema,
  employeeUpdateSchema,
  isContractEndingSoon,
  type contractCreateSchema,
  type EmployeeSensitive,
} from '@ecole/shared';
import type { EmploymentContract, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { decrypt, encrypt } from '../../common/crypto';
import { addDays, fromDbDate, toDbDate, todayInCameroon } from '../../common/dates';
import { Db, InjectDb } from '../../common/prisma';
import { env } from '../../config/env';

const SENSITIVE_KEYS = Object.keys(employeeSensitiveSchema.shape) as (keyof EmployeeSensitive)[];

/** Valeur masquée : seuls les 4 derniers caractères restent visibles. */
export function maskValue(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/\s/g, '');
  return clean.length <= 4 ? '••••' : `•••• ${clean.slice(-4)}`;
}

export function decryptSensitive(payload: string | null): EmployeeSensitive {
  if (!payload) return {};
  return JSON.parse(decrypt(payload, env().DATA_ENCRYPTION_KEY)) as EmployeeSensitive;
}

function encryptSensitive(data: EmployeeSensitive): string | null {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined && v !== ''),
  );
  return Object.keys(clean).length
    ? encrypt(JSON.stringify(clean), env().DATA_ENCRYPTION_KEY)
    : null;
}

/** Vue masquée des données sensibles : présence de chaque champ, jamais la valeur complète. */
function maskedSensitive(payload: string | null) {
  const data = decryptSensitive(payload);
  return {
    filled: SENSITIVE_KEYS.filter((k) => !!data[k]),
    cnpsNumber: maskValue(data.cnpsNumber),
    bankAccount: maskValue(data.bankAccount),
    mobileMoneyNumber: maskValue(data.mobileMoneyNumber),
  };
}

export function contractView(c: EmploymentContract | undefined, today = todayInCameroon()) {
  if (!c) return null;
  const endDate = c.endDate ? fromDbDate(c.endDate) : null;
  return {
    id: c.id,
    type: c.type,
    startDate: fromDbDate(c.startDate),
    endDate,
    baseSalary: c.baseSalary,
    hourlyRate: c.hourlyRate,
    overtimeRate: c.overtimeRate,
    endedAt: c.endedAt,
    endReason: c.endReason,
    daysLeft: endDate ? daysUntil(endDate, today) : null,
    endingSoon: !c.endedAt && isContractEndingSoon({ type: c.type, endDate }, today),
  };
}

@Injectable()
export class EmployeesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async users(ids: string[]) {
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    return new Map(users.map((u) => [u.id, u]));
  }

  async list() {
    const files = await this.db.employeeFile.findMany({
      include: { contracts: { where: { endedAt: null }, orderBy: { startDate: 'desc' }, take: 1 } },
    });
    const users = await this.users(files.map((f) => f.userId));
    const memberships = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId(), userId: { in: files.map((f) => f.userId) } },
      select: { userId: true, roles: true, active: true },
    });
    const byUser = new Map(memberships.map((m) => [m.userId, m]));
    return files
      .map((f) => {
        const u = users.get(f.userId);
        return {
          id: f.id,
          userId: f.userId,
          firstName: u?.firstName ?? '',
          lastName: u?.lastName ?? '',
          roles: byUser.get(f.userId)?.roles ?? [],
          active: byUser.get(f.userId)?.active ?? false,
          position: f.position,
          hireDate: fromDbDate(f.hireDate),
          payoutMethod: f.payoutMethod,
          contract: contractView(f.contracts[0]),
        };
      })
      .sort((a, b) => a.lastName.localeCompare(b.lastName, 'fr'));
  }

  /** Membres du personnel sans dossier RH. */
  async candidates() {
    const [memberships, files] = await Promise.all([
      this.db.membership.findMany({
        where: { schoolId: currentSchoolId(), active: true },
        include: { user: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { user: { lastName: 'asc' } },
      }),
      this.db.employeeFile.findMany({ select: { userId: true } }),
    ]);
    const taken = new Set(files.map((f) => f.userId));
    return memberships
      .filter((m) => !taken.has(m.userId))
      .map((m) => ({ ...m.user, roles: m.roles }));
  }

  async create(input: z.infer<typeof employeeCreateSchema>) {
    const schoolId = currentSchoolId();
    const membership = await this.db.membership.findUnique({
      where: { userId_schoolId: { userId: input.userId, schoolId } },
    });
    if (!membership) throw new BadRequestException('Membre du personnel inconnu');
    const existing = await this.db.employeeFile.findUnique({
      where: { schoolId_userId: { schoolId, userId: input.userId } },
    });
    if (existing) throw new ConflictException('Ce membre du personnel a déjà un dossier');
    const file = await this.db.employeeFile.create({
      data: {
        schoolId,
        userId: input.userId,
        position: input.position,
        hireDate: toDbDate(input.hireDate),
        diplomas: input.diplomas as Prisma.InputJsonValue,
        payoutMethod: input.payoutMethod,
        encryptedSensitive: encryptSensitive(input.sensitive),
      },
    });
    await this.audit.log({
      action: 'hr.employee_created',
      entity: 'EmployeeFile',
      entityId: file.id,
      // Jamais de donnée sensible en clair dans le journal : seulement les champs renseignés.
      after: {
        userId: input.userId,
        position: input.position,
        hireDate: input.hireDate,
        sensitiveFields: Object.keys(input.sensitive).filter(
          (k) => !!input.sensitive[k as keyof EmployeeSensitive],
        ),
      },
    });
    return this.get(file.id);
  }

  private async file(id: string) {
    const file = await this.db.employeeFile.findUnique({
      where: { id },
      include: { contracts: { orderBy: { startDate: 'desc' } } },
    });
    if (!file) throw new NotFoundException('Dossier introuvable');
    return file;
  }

  async get(id: string) {
    const file = await this.file(id);
    const user = (await this.users([file.userId])).get(file.userId);
    const membership = await this.db.membership.findUnique({
      where: { userId_schoolId: { userId: file.userId, schoolId: currentSchoolId() } },
      select: { roles: true, active: true },
    });
    const advances = await this.db.salaryAdvance.findMany({
      where: { employeeId: id },
      include: { repayments: true },
      orderBy: { createdAt: 'desc' },
    });
    const current = file.contracts.find((c) => !c.endedAt);
    return {
      id: file.id,
      userId: file.userId,
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
      email: user?.email ?? null,
      phone: user?.phone ?? null,
      roles: membership?.roles ?? [],
      active: membership?.active ?? false,
      position: file.position,
      hireDate: fromDbDate(file.hireDate),
      diplomas: file.diplomas as { title: string; year?: number; institution?: string }[],
      payoutMethod: file.payoutMethod,
      sensitive: maskedSensitive(file.encryptedSensitive),
      contract: contractView(current),
      contracts: file.contracts.map((c) => contractView(c)),
      advances: advances.map((a) => ({
        id: a.id,
        amount: a.amount,
        installments: a.installments,
        firstMonth: a.firstMonth,
        status: a.status,
        reason: a.reason,
        repaid: a.repayments.reduce((s, r) => s + r.amount, 0),
        createdAt: a.createdAt,
      })),
    };
  }

  /** Consultation des données sensibles en clair : motif obligatoire, journalisée. */
  async sensitive(id: string, reason: string) {
    if (staffContext().breakGlass)
      throw new ForbiddenException('Données sensibles inaccessibles en accès exceptionnel');
    const file = await this.file(id);
    await this.audit.log({
      action: 'hr.sensitive_read',
      entity: 'EmployeeFile',
      entityId: id,
      reason,
    });
    return decryptSensitive(file.encryptedSensitive);
  }

  async update(id: string, input: z.infer<typeof employeeUpdateSchema>) {
    const before = await this.file(id);
    const data: Prisma.EmployeeFileUpdateInput = {};
    if (input.position !== undefined) data.position = input.position;
    if (input.hireDate !== undefined) data.hireDate = toDbDate(input.hireDate);
    if (input.diplomas !== undefined) data.diplomas = input.diplomas as Prisma.InputJsonValue;
    if (input.payoutMethod !== undefined) data.payoutMethod = input.payoutMethod;
    const changedSensitive = input.sensitive ? Object.keys(input.sensitive) : [];
    if (input.sensitive) {
      data.encryptedSensitive = encryptSensitive({
        ...decryptSensitive(before.encryptedSensitive),
        ...input.sensitive,
      });
    }
    await this.db.employeeFile.update({ where: { id }, data });
    await this.audit.log({
      action: 'hr.employee_updated',
      entity: 'EmployeeFile',
      entityId: id,
      before: {
        position: before.position,
        hireDate: fromDbDate(before.hireDate),
        payoutMethod: before.payoutMethod,
      },
      after: {
        position: input.position,
        hireDate: input.hireDate,
        payoutMethod: input.payoutMethod,
        diplomas: input.diplomas,
        sensitiveFields: changedSensitive,
      },
    });
    return this.get(id);
  }

  /** Nouveau contrat : le contrat en cours prend fin la veille. */
  async addContract(employeeId: string, input: z.infer<typeof contractCreateSchema>) {
    const file = await this.file(employeeId);
    const current = file.contracts.find((c) => !c.endedAt);
    if (current && fromDbDate(current.startDate) >= input.startDate)
      throw new ConflictException('Le nouveau contrat doit commencer après le contrat en cours');
    const contract = await this.db.$transaction(async (tx) => {
      if (current) {
        const dayBefore = addDays(input.startDate, -1);
        const end =
          current.endDate && fromDbDate(current.endDate) < dayBefore
            ? current.endDate
            : toDbDate(dayBefore);
        await tx.employmentContract.update({
          where: { id: current.id },
          data: { endedAt: new Date(), endDate: end, endReason: 'Remplacé par un nouveau contrat' },
        });
      }
      return tx.employmentContract.create({
        data: {
          schoolId: currentSchoolId(),
          employeeId,
          type: input.type,
          startDate: toDbDate(input.startDate),
          endDate: input.endDate ? toDbDate(input.endDate) : null,
          baseSalary: input.type === 'HOURLY' ? null : (input.baseSalary ?? null),
          hourlyRate: input.type === 'HOURLY' ? (input.hourlyRate ?? null) : null,
          overtimeRate: input.overtimeRate ?? null,
          createdById: staffContext().userId,
        },
      });
    });
    await this.audit.log({
      action: 'hr.contract_created',
      entity: 'EmploymentContract',
      entityId: contract.id,
      before: current ? contractView(current) : undefined,
      after: { employeeId, ...input },
    });
    return contractView(contract);
  }

  async endContract(contractId: string, endDate: string, reason: string) {
    const c = await this.db.employmentContract.findUnique({ where: { id: contractId } });
    if (!c) throw new NotFoundException('Contrat introuvable');
    if (c.endedAt) throw new ConflictException('Ce contrat est déjà terminé');
    if (endDate < fromDbDate(c.startDate))
      throw new BadRequestException('La fin doit suivre le début du contrat');
    const after = await this.db.employmentContract.update({
      where: { id: contractId },
      data: { endedAt: new Date(), endDate: toDbDate(endDate), endReason: reason },
    });
    await this.audit.log({
      action: 'hr.contract_ended',
      entity: 'EmploymentContract',
      entityId: contractId,
      before: contractView(c),
      after: { endDate },
      reason,
    });
    return contractView(after);
  }

  /** CDD arrivant à échéance (ou échus mais non clôturés) dans le délai d'alerte. */
  async alerts() {
    const today = todayInCameroon();
    const contracts = await this.db.employmentContract.findMany({
      where: {
        type: 'CDD',
        endedAt: null,
        endDate: { lte: toDbDate(addDays(today, CDD_ALERT_DAYS)) },
      },
      include: { employee: true },
      orderBy: { endDate: 'asc' },
    });
    const users = await this.users(contracts.map((c) => c.employee.userId));
    return contracts.map((c) => {
      const u = users.get(c.employee.userId);
      return {
        employeeId: c.employeeId,
        firstName: u?.firstName ?? '',
        lastName: u?.lastName ?? '',
        position: c.employee.position,
        contract: contractView(c, today),
      };
    });
  }
}
