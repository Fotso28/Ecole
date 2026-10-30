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
  type PayoutMethod,
} from '@ecole/shared';
import { Prisma, type EmploymentContract } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { decrypt, encrypt, hmacSha256 } from '../../common/crypto';
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

/** Coordonnées de paiement : un changement ne prend effet qu'après l'accord d'une autre personne. */
export const PAYOUT_FIELDS = [
  'bankName',
  'bankAccount',
  'mobileMoneyNumber',
  'mobileMoneyOperator',
] as const satisfies readonly (keyof EmployeeSensitive)[];

export interface PayoutDetails {
  method: PayoutMethod;
  bankName?: string;
  bankAccount?: string;
  mobileMoneyNumber?: string;
  mobileMoneyOperator?: 'MTN' | 'ORANGE';
}

export function payoutDetails(method: PayoutMethod, sensitive: EmployeeSensitive): PayoutDetails {
  const out: PayoutDetails = { method };
  for (const k of PAYOUT_FIELDS) if (sensitive[k]) Object.assign(out, { [k]: sensitive[k] });
  return out;
}

/** Empreinte (HMAC) des coordonnées : comparable dans le journal, sans valeur lisible. */
export function payoutFingerprint(d: PayoutDetails): string {
  const canonical = JSON.stringify([
    d.method,
    d.bankName ?? '',
    (d.bankAccount ?? '').replace(/\s/g, ''),
    (d.mobileMoneyNumber ?? '').replace(/\s/g, ''),
    d.mobileMoneyOperator ?? '',
  ]);
  return hmacSha256(env().DATA_ENCRYPTION_KEY, `payout:${canonical}`);
}

/** Vue masquée des coordonnées pour le journal et l'écran (4 derniers caractères). */
export function maskedPayout(d: PayoutDetails) {
  return {
    method: d.method,
    bankName: d.bankName ?? null,
    bankAccount: maskValue(d.bankAccount),
    mobileMoneyNumber: maskValue(d.mobileMoneyNumber),
    mobileMoneyOperator: d.mobileMoneyOperator ?? null,
  };
}

export function encryptPayout(d: PayoutDetails): string {
  return encrypt(JSON.stringify(d), env().DATA_ENCRYPTION_KEY);
}

export function decryptPayout(payload: string): PayoutDetails {
  return JSON.parse(decrypt(payload, env().DATA_ENCRYPTION_KEY)) as PayoutDetails;
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
        payout: maskedPayout(payoutDetails(input.payoutMethod, input.sensitive)),
        payoutFingerprint: payoutFingerprint(payoutDetails(input.payoutMethod, input.sensitive)),
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
      pendingPayoutChange: await this.pendingPayoutView(file),
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

  /**
   * Mise à jour d'un dossier. Les coordonnées de paiement (mode, banque, Mobile Money) ne sont pas
   * modifiées ici : leur changement est enregistré comme une demande, appliquée seulement après
   * l'accord d'une autre personne. Les autres champs prennent effet aussitôt.
   */
  async update(id: string, input: z.infer<typeof employeeUpdateSchema>) {
    const before = await this.file(id);
    const data: Prisma.EmployeeFileUpdateInput = {};
    if (input.position !== undefined) data.position = input.position;
    if (input.hireDate !== undefined) data.hireDate = toDbDate(input.hireDate);
    if (input.diplomas !== undefined) data.diplomas = input.diplomas as Prisma.InputJsonValue;
    const current = decryptSensitive(before.encryptedSensitive);
    const sensitiveInput = { ...(input.sensitive ?? {}) } as Record<string, string | undefined>;
    const payoutInput: Partial<EmployeeSensitive> & { payoutMethod?: PayoutMethod } = {};
    for (const k of PAYOUT_FIELDS) {
      if (!(k in sensitiveInput)) continue;
      const value = sensitiveInput[k];
      delete sensitiveInput[k];
      if ((value ?? '') !== (current[k] ?? '')) Object.assign(payoutInput, { [k]: value ?? '' });
    }
    if (input.payoutMethod !== undefined && input.payoutMethod !== before.payoutMethod)
      payoutInput.payoutMethod = input.payoutMethod;
    const changedSensitive = Object.keys(sensitiveInput);
    if (changedSensitive.length) {
      data.encryptedSensitive = encryptSensitive({
        ...current,
        ...(sensitiveInput as Partial<EmployeeSensitive>),
      });
    }
    if (Object.keys(payoutInput).length) await this.requestPayoutChange(before, payoutInput);
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
        diplomas: input.diplomas,
        sensitiveFields: changedSensitive,
      },
    });
    return this.get(id);
  }

  private async pendingPayoutView(file: {
    id: string;
    payoutMethod: PayoutMethod;
    encryptedSensitive: string | null;
  }) {
    const change = await this.db.payoutDetailsChange.findFirst({
      where: { employeeId: file.id, status: 'PENDING' },
    });
    if (!change) return null;
    const requested = JSON.parse(
      decrypt(change.encryptedChange, env().DATA_ENCRYPTION_KEY),
    ) as Partial<EmployeeSensitive & { payoutMethod: PayoutMethod }>;
    const users = await this.users([change.requestedById]);
    const u = users.get(change.requestedById);
    const before = payoutDetails(file.payoutMethod, decryptSensitive(file.encryptedSensitive));
    return {
      id: change.id,
      requestedById: change.requestedById,
      requestedBy: u ? `${u.firstName} ${u.lastName}` : null,
      requestedAt: change.createdAt,
      before: maskedPayout(before),
      after: maskedPayout(
        this.applyPayout(file.payoutMethod, decryptSensitive(file.encryptedSensitive), requested)
          .details,
      ),
    };
  }

  /** Coordonnées après application d'un changement demandé (chaîne vide : effacement). */
  private applyPayout(
    method: PayoutMethod,
    sensitive: EmployeeSensitive,
    change: Partial<EmployeeSensitive & { payoutMethod: PayoutMethod }>,
  ) {
    const { payoutMethod, ...fields } = change;
    const merged = { ...sensitive, ...fields } as EmployeeSensitive;
    const nextMethod = payoutMethod ?? method;
    return { method: nextMethod, sensitive: merged, details: payoutDetails(nextMethod, merged) };
  }

  /** Demande de changement des coordonnées : une seule en attente par dossier, journalisée. */
  private async requestPayoutChange(
    file: { id: string; payoutMethod: PayoutMethod; encryptedSensitive: string | null },
    change: Partial<EmployeeSensitive> & { payoutMethod?: PayoutMethod },
  ) {
    const sensitive = decryptSensitive(file.encryptedSensitive);
    const before = payoutDetails(file.payoutMethod, sensitive);
    const after = this.applyPayout(file.payoutMethod, sensitive, change).details;
    try {
      const created = await this.db.payoutDetailsChange.create({
        data: {
          schoolId: currentSchoolId(),
          employeeId: file.id,
          encryptedChange: encrypt(JSON.stringify(change), env().DATA_ENCRYPTION_KEY),
          beforeFingerprint: payoutFingerprint(before),
          afterFingerprint: payoutFingerprint(after),
          requestedById: staffContext().userId,
        },
      });
      await this.audit.log({
        action: 'hr.payout_details_requested',
        entity: 'EmployeeFile',
        entityId: file.id,
        before: { ...maskedPayout(before), fingerprint: created.beforeFingerprint },
        after: {
          ...maskedPayout(after),
          fingerprint: created.afterFingerprint,
          changeId: created.id,
          fields: Object.keys(change),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException(
          'Un changement de coordonnées de paiement attend déjà son approbation pour ce dossier',
        );
      throw e;
    }
  }

  /**
   * Approbation ou refus d'un changement de coordonnées par une autre personne que celle qui l'a
   * demandé, et jamais par la personne concernée. L'approbation applique les nouvelles valeurs.
   */
  async decidePayoutChange(employeeId: string, approve: boolean, reason?: string) {
    const file = await this.file(employeeId);
    const change = await this.db.payoutDetailsChange.findFirst({
      where: { employeeId, status: 'PENDING' },
    });
    if (!change) throw new NotFoundException('Aucun changement de coordonnées en attente');
    const actor = staffContext().userId;
    if (change.requestedById === actor)
      throw new ForbiddenException(
        'Le changement doit être approuvé par une autre personne que celle qui l’a demandé',
      );
    if (file.userId === actor)
      throw new ForbiddenException('Vous ne pouvez pas approuver vos propres coordonnées');
    const sensitive = decryptSensitive(file.encryptedSensitive);
    const requested = JSON.parse(
      decrypt(change.encryptedChange, env().DATA_ENCRYPTION_KEY),
    ) as Partial<EmployeeSensitive & { payoutMethod: PayoutMethod }>;
    const before = payoutDetails(file.payoutMethod, sensitive);
    const next = this.applyPayout(file.payoutMethod, sensitive, requested);
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.payoutDetailsChange.updateMany({
        where: { id: change.id, status: 'PENDING' },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          decidedById: actor,
          decidedAt: new Date(),
          decisionNote: reason ?? null,
        },
      });
      if (count === 0) throw new ConflictException('Ce changement a déjà été traité');
      if (approve) {
        // Les coordonnées n'ont pas changé depuis la demande (sinon l'empreinte diffère).
        if (payoutFingerprint(before) !== change.beforeFingerprint)
          throw new ConflictException(
            'Les coordonnées ont changé depuis la demande : refusez-la et faites-en une nouvelle',
          );
        await tx.employeeFile.update({
          where: { id: employeeId },
          data: {
            payoutMethod: next.method,
            encryptedSensitive: encryptSensitive(next.sensitive),
          },
        });
      }
      await this.audit.log(
        {
          action: approve ? 'hr.payout_details_approved' : 'hr.payout_details_rejected',
          entity: 'EmployeeFile',
          entityId: employeeId,
          before: { ...maskedPayout(before), fingerprint: change.beforeFingerprint },
          after: {
            ...maskedPayout(next.details),
            fingerprint: change.afterFingerprint,
            changeId: change.id,
            requestedById: change.requestedById,
          },
          reason,
        },
        tx,
      );
    });
    return this.get(employeeId);
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
