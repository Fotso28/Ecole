import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  coversTrip,
  fitsCapacity,
  occupancy,
  subscriptionFee,
  TRIP_DIRECTION_LABELS,
  vehicleDocumentAlerts,
  type TransportDirection,
  type TripDirection,
  transportLineSchema,
  transportRollCallSchema,
  transportSettingsSchema,
  transportStopSchema,
  transportSubscriptionSchema,
  transportVehicleSchema,
} from '@ecole/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId, runAsSystem, staffContext } from '../../common/context';
import { addDays, fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';

export const MISSED_BOARDING_TEMPLATE = 'transportMissedBoarding';
/** Délai avant l'envoi du SMS « pas monté » : une erreur de pointage corrigée entre-temps l'annule. */
export const MISSED_BOARDING_DELAY_MS = 3 * 60_000;
/** Un appel peut être envoyé en différé (réseau coupé) jusqu'à 7 jours après le trajet. */
const ROLL_CALL_MAX_AGE_DAYS = 7;

export const transportTemplates = {
  missedBoarding: (p: {
    school: string;
    student: string;
    line: string;
    stop: string;
    date: string;
    direction: TripDirection;
  }) =>
    p.direction === 'OUTBOUND'
      ? `${p.school} : ${p.student} n'est pas monté(e) dans le car ce matin (${p.line}, arrêt ${p.stop}, ${p.date}). Contactez l'école si besoin.`
      : `${p.school} : ${p.student} n'est pas monté(e) dans le car du retour (${p.line}, ${p.date}). Contactez l'école si besoin.`,
};

type LineInput = z.infer<typeof transportLineSchema>;
type StopInput = z.infer<typeof transportStopSchema>;
type VehicleInput = z.infer<typeof transportVehicleSchema>;
type SubscriptionInput = z.infer<typeof transportSubscriptionSchema>;
type RollCallInput = z.infer<typeof transportRollCallSchema>;
export type TransportSettings = z.infer<typeof transportSettingsSchema>;

const DEFAULT_SETTINGS: TransportSettings = { missedBoardingSms: false };

const lineInclude = {
  vehicle: true,
  stops: { orderBy: { order: 'asc' } },
  subscriptions: { where: { status: 'ACTIVE' }, select: { direction: true } },
} satisfies Prisma.TransportLineInclude;

type LineWithRelations = Prisma.TransportLineGetPayload<{ include: typeof lineInclude }>;

function presentVehicle(v: Prisma.TransportVehicleGetPayload<object>, today: string) {
  const dates = {
    insuranceExpiresOn: v.insuranceExpiresOn ? fromDbDate(v.insuranceExpiresOn) : null,
    inspectionExpiresOn: v.inspectionExpiresOn ? fromDbDate(v.inspectionExpiresOn) : null,
  };
  return {
    id: v.id,
    plate: v.plate,
    capacity: v.capacity,
    driverName: v.driverName,
    driverPhone: v.driverPhone,
    active: v.active,
    ...dates,
    alerts: vehicleDocumentAlerts(dates, today).filter((a) => a.state !== 'OK'),
  };
}

/** Transport scolaire : lignes, véhicules, abonnements facturés par la scolarité, appel dans le car. */
@Injectable()
export class TransportService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    // Pointage corrigé (élève finalement monté) : le SMS en attente est annulé.
    this.notifications.registerGuard(MISSED_BOARDING_TEMPLATE, (n) => {
      const recordId = (n.payload as { recordId?: string }).recordId;
      if (!recordId) return Promise.resolve(true);
      return runAsSystem(
        'transport-notification-guard',
        async () => {
          const r = await this.db.transportTripRecord.findUnique({ where: { id: recordId } });
          return r?.boarded === false;
        },
        n.schoolId ?? undefined,
      );
    });
  }

  // ---------------------------------------------------------------- Réglages

  async settings(): Promise<TransportSettings> {
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { settings: true },
    });
    const raw = (school.settings as { transport?: Partial<TransportSettings> }).transport;
    return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  }

  async updateSettings(input: TransportSettings) {
    const schoolId = currentSchoolId();
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { settings: true },
    });
    const before = (school.settings ?? {}) as Record<string, unknown>;
    await this.db.school.update({
      where: { id: schoolId },
      data: { settings: { ...before, transport: input } as Prisma.InputJsonValue },
    });
    await this.audit.log({
      action: 'transport.settings_updated',
      entity: 'School',
      entityId: schoolId,
      before: before.transport ?? null,
      after: input,
    });
    return input;
  }

  // ---------------------------------------------------------------- Véhicules

  async vehicles() {
    const today = todayInCameroon();
    const rows = await this.db.transportVehicle.findMany({ orderBy: { plate: 'asc' } });
    return rows.map((v) => presentVehicle(v, today));
  }

  private vehicleData(input: VehicleInput) {
    return {
      plate: input.plate,
      capacity: input.capacity,
      driverName: input.driverName || null,
      driverPhone: input.driverPhone || null,
      insuranceExpiresOn: input.insuranceExpiresOn ? toDbDate(input.insuranceExpiresOn) : null,
      inspectionExpiresOn: input.inspectionExpiresOn ? toDbDate(input.inspectionExpiresOn) : null,
    };
  }

  async createVehicle(input: VehicleInput) {
    const exists = await this.db.transportVehicle.findFirst({ where: { plate: input.plate } });
    if (exists) throw new ConflictException('Un véhicule porte déjà cette immatriculation');
    const v = await this.db.transportVehicle.create({
      data: { schoolId: currentSchoolId(), ...this.vehicleData(input) },
    });
    await this.audit.log({
      action: 'transport.vehicle_created',
      entity: 'TransportVehicle',
      entityId: v.id,
      after: input,
    });
    return presentVehicle(v, todayInCameroon());
  }

  async updateVehicle(id: string, input: VehicleInput) {
    const before = await this.db.transportVehicle.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Véhicule introuvable');
    const duplicate = await this.db.transportVehicle.findFirst({
      where: { plate: input.plate, id: { not: id } },
    });
    if (duplicate) throw new ConflictException('Un véhicule porte déjà cette immatriculation');
    const lines = await this.db.transportLine.findMany({
      where: { vehicleId: id },
      include: { subscriptions: { where: { status: 'ACTIVE' }, select: { direction: true } } },
    });
    for (const l of lines) {
      const used = occupancy(l.subscriptions.map((s) => s.direction));
      if (Math.max(used.OUTBOUND, used.RETURN) > input.capacity)
        throw new ConflictException(
          `La ligne « ${l.name} » compte déjà plus d’abonnés que cette capacité`,
        );
    }
    const v = await this.db.transportVehicle.update({
      where: { id },
      data: this.vehicleData(input),
    });
    await this.audit.log({
      action: 'transport.vehicle_updated',
      entity: 'TransportVehicle',
      entityId: id,
      before: { ...before },
      after: input,
    });
    return presentVehicle(v, todayInCameroon());
  }

  // ---------------------------------------------------------------- Lignes et arrêts

  /** Personnel affectable aux lignes : comptes de l'école ayant le rôle chauffeur ou accompagnateur. */
  async transportStaff() {
    const memberships = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId(), active: true, roles: { has: 'TRANSPORT' } },
      include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } },
    });
    return memberships
      .map((m) => m.user)
      .sort((a, b) => a.lastName.localeCompare(b.lastName, 'fr'));
  }

  private async staffNames(ids: string[]) {
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  }

  private presentLine(l: LineWithRelations, names: Map<string, string>, today: string) {
    const used = occupancy(l.subscriptions.map((s) => s.direction));
    return {
      id: l.id,
      name: l.name,
      fee: l.fee,
      oneWayFee: l.oneWayFee,
      active: l.active,
      vehicle: l.vehicle ? presentVehicle(l.vehicle, today) : null,
      stops: l.stops.map((s) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        morningTime: s.morningTime,
        eveningTime: s.eveningTime,
      })),
      staff: l.staffUserIds.map((id) => ({ id, name: names.get(id) ?? '—' })),
      occupancy: used,
      capacity: l.vehicle?.capacity ?? null,
    };
  }

  async lines() {
    const rows = await this.db.transportLine.findMany({
      include: lineInclude,
      orderBy: { name: 'asc' },
    });
    const names = await this.staffNames([...new Set(rows.flatMap((r) => r.staffUserIds))]);
    const today = todayInCameroon();
    return rows.map((r) => this.presentLine(r, names, today));
  }

  private async assertLineRefs(input: LineInput) {
    if (input.vehicleId) {
      const v = await this.db.transportVehicle.findUnique({ where: { id: input.vehicleId } });
      if (!v) throw new BadRequestException('Véhicule inconnu');
    }
    if (input.staffUserIds.length > 0) {
      const allowed = new Set((await this.transportStaff()).map((u) => u.id));
      if (input.staffUserIds.some((id) => !allowed.has(id)))
        throw new BadRequestException(
          'Seuls les comptes « chauffeur ou accompagnateur » de l’école peuvent être affectés',
        );
    }
  }

  async createLine(input: LineInput) {
    await this.assertLineRefs(input);
    if (await this.db.transportLine.findFirst({ where: { name: input.name } }))
      throw new ConflictException('Une ligne porte déjà ce nom');
    const line = await this.db.transportLine.create({
      data: {
        schoolId: currentSchoolId(),
        name: input.name,
        vehicleId: input.vehicleId ?? null,
        fee: input.fee,
        oneWayFee: input.oneWayFee,
        staffUserIds: [...new Set(input.staffUserIds)],
        active: input.active,
      },
    });
    await this.audit.log({
      action: 'transport.line_created',
      entity: 'TransportLine',
      entityId: line.id,
      after: input,
    });
    return line;
  }

  async updateLine(id: string, input: LineInput) {
    const before = await this.db.transportLine.findUnique({
      where: { id },
      include: { subscriptions: { where: { status: 'ACTIVE' }, select: { direction: true } } },
    });
    if (!before) throw new NotFoundException('Ligne introuvable');
    await this.assertLineRefs(input);
    if (await this.db.transportLine.findFirst({ where: { name: input.name, id: { not: id } } }))
      throw new ConflictException('Une ligne porte déjà ce nom');
    if (before.subscriptions.length > 0) {
      const vehicle = input.vehicleId
        ? await this.db.transportVehicle.findUnique({ where: { id: input.vehicleId } })
        : null;
      const used = occupancy(before.subscriptions.map((s) => s.direction));
      if (!vehicle || Math.max(used.OUTBOUND, used.RETURN) > vehicle.capacity)
        throw new ConflictException(
          'Le véhicule choisi n’a pas assez de places pour les abonnés de la ligne',
        );
    }
    const line = await this.db.transportLine.update({
      where: { id },
      data: {
        name: input.name,
        vehicleId: input.vehicleId ?? null,
        fee: input.fee,
        oneWayFee: input.oneWayFee,
        staffUserIds: [...new Set(input.staffUserIds)],
        active: input.active,
      },
    });
    await this.audit.log({
      action: 'transport.line_updated',
      entity: 'TransportLine',
      entityId: id,
      before: { ...before, subscriptions: undefined },
      after: input,
    });
    return line;
  }

  async addStop(lineId: string, input: StopInput) {
    const line = await this.db.transportLine.findUnique({ where: { id: lineId } });
    if (!line) throw new NotFoundException('Ligne introuvable');
    if (await this.db.transportStop.findFirst({ where: { lineId, order: input.order } }))
      throw new ConflictException('Un arrêt occupe déjà ce rang sur la ligne');
    const stop = await this.db.transportStop.create({
      data: {
        schoolId: currentSchoolId(),
        lineId,
        name: input.name,
        order: input.order,
        morningTime: input.morningTime ?? null,
        eveningTime: input.eveningTime ?? null,
      },
    });
    await this.audit.log({
      action: 'transport.stop_created',
      entity: 'TransportStop',
      entityId: stop.id,
      after: input,
    });
    return stop;
  }

  async updateStop(id: string, input: StopInput) {
    const before = await this.db.transportStop.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Arrêt introuvable');
    if (
      await this.db.transportStop.findFirst({
        where: { lineId: before.lineId, order: input.order, id: { not: id } },
      })
    )
      throw new ConflictException('Un arrêt occupe déjà ce rang sur la ligne');
    const stop = await this.db.transportStop.update({
      where: { id },
      data: {
        name: input.name,
        order: input.order,
        morningTime: input.morningTime ?? null,
        eveningTime: input.eveningTime ?? null,
      },
    });
    await this.audit.log({
      action: 'transport.stop_updated',
      entity: 'TransportStop',
      entityId: id,
      before: { ...before },
      after: input,
    });
    return stop;
  }

  async deleteStop(id: string) {
    const stop = await this.db.transportStop.findUnique({ where: { id } });
    if (!stop) throw new NotFoundException('Arrêt introuvable');
    const used = await this.db.transportSubscription.count({ where: { stopId: id } });
    if (used > 0)
      throw new ConflictException('Des élèves sont ou ont été abonnés à cet arrêt : modifiez-le');
    await this.db.transportStop.delete({ where: { id } });
    await this.audit.log({
      action: 'transport.stop_deleted',
      entity: 'TransportStop',
      entityId: id,
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------- Abonnements

  async subscriptions(filters: { lineId?: string; studentId?: string }) {
    const year = await this.scope.currentYear();
    const rows = await this.db.transportSubscription.findMany({
      where: {
        academicYearId: year.id,
        ...(filters.lineId ? { lineId: filters.lineId } : {}),
        ...(filters.studentId ? { studentId: filters.studentId } : {}),
      },
      include: {
        line: { select: { id: true, name: true } },
        stop: { select: { id: true, name: true, morningTime: true, eveningTime: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    const students = await this.db.student.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.studentId))] } },
      select: { id: true, firstName: true, lastName: true, matricule: true },
    });
    const byId = new Map(students.map((s) => [s.id, s]));
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      direction: r.direction,
      fee: r.fee,
      invoiced: r.invoiceLineId !== null,
      line: r.line,
      stop: r.stop,
      student: byId.get(r.studentId) ?? null,
      createdAt: r.createdAt,
      cancelledAt: r.cancelledAt,
      cancelReason: r.cancelReason,
    }));
  }

  /**
   * Abonne un élève : capacité du véhicule vérifiée sous verrou, une seule inscription active par
   * élève et par année, ligne de facture ajoutée à l'échéancier dans la même transaction.
   */
  async subscribe(input: SubscriptionInput) {
    const year = await this.scope.currentYear();
    const schoolId = currentSchoolId();
    const student = await this.db.student.findUnique({ where: { id: input.studentId } });
    if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    const enrolled = await this.db.enrollment.count({
      where: { studentId: input.studentId, academicYearId: year.id },
    });
    if (enrolled === 0) throw new ConflictException('L’élève n’est pas inscrit cette année');
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TransportLine" WHERE "id" = ${input.lineId} AND "schoolId" = ${schoolId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Student" WHERE "id" = ${input.studentId} AND "schoolId" = ${schoolId} FOR UPDATE`;
      const line = await tx.transportLine.findUnique({
        where: { id: input.lineId },
        include: {
          vehicle: true,
          subscriptions: { where: { status: 'ACTIVE' }, select: { direction: true } },
        },
      });
      if (!line || !line.active) throw new NotFoundException('Ligne introuvable');
      const stop = await tx.transportStop.findFirst({
        where: { id: input.stopId, lineId: line.id },
      });
      if (!stop) throw new BadRequestException('Cet arrêt n’appartient pas à la ligne');
      const existing = await tx.transportSubscription.findFirst({
        where: { studentId: input.studentId, academicYearId: year.id, status: 'ACTIVE' },
      });
      if (existing) throw new ConflictException('L’élève est déjà abonné au transport cette année');
      if (!line.vehicle) throw new ConflictException('Affectez d’abord un véhicule à cette ligne');
      if (
        !fitsCapacity(
          line.vehicle.capacity,
          line.subscriptions.map((s) => s.direction),
          input.direction,
        )
      )
        throw new ConflictException(
          `Le véhicule ${line.vehicle.plate} est complet (${line.vehicle.capacity} places)`,
        );
      const fee = subscriptionFee(line, input.direction);
      const created = await tx.transportSubscription.create({
        data: {
          schoolId,
          studentId: input.studentId,
          academicYearId: year.id,
          lineId: line.id,
          stopId: stop.id,
          direction: input.direction,
          fee,
          createdById: currentActorId() ?? null,
        },
      });
      let invoiceLineId: string | null = null;
      if (fee > 0) {
        const invoiceLine = await this.finance.addExtraCharge(
          {
            studentId: input.studentId,
            academicYearId: year.id,
            label: `Transport scolaire – ${line.name}`,
            amount: fee,
            dueDate: input.dueDate ?? todayInCameroon(),
          },
          tx,
        );
        invoiceLineId = invoiceLine.id;
        await tx.transportSubscription.update({
          where: { id: created.id },
          data: { invoiceLineId },
        });
      }
      await this.audit.log(
        {
          action: 'transport.subscribed',
          entity: 'TransportSubscription',
          entityId: created.id,
          after: { ...input, fee, invoiceLineId },
        },
        tx,
      );
      return { ...created, invoiceLineId };
    });
  }

  /** Changement d'arrêt sur la même ligne (sans incidence sur la facture). */
  async changeStop(id: string, stopId: string) {
    const sub = await this.db.transportSubscription.findUnique({ where: { id } });
    if (!sub || sub.status !== 'ACTIVE') throw new NotFoundException('Abonnement introuvable');
    const stop = await this.db.transportStop.findFirst({
      where: { id: stopId, lineId: sub.lineId },
    });
    if (!stop) throw new BadRequestException('Cet arrêt n’appartient pas à la ligne');
    await this.db.transportSubscription.update({ where: { id }, data: { stopId } });
    await this.audit.log({
      action: 'transport.stop_changed',
      entity: 'TransportSubscription',
      entityId: id,
      before: { stopId: sub.stopId },
      after: { stopId },
    });
    return { ok: true };
  }

  /**
   * Résiliation : l'élève quitte la liste d'appel. La ligne de facture reste (écritures en ajout
   * seul) ; un éventuel geste commercial passe par une remise dans la scolarité.
   */
  async cancel(id: string, reason: string) {
    const sub = await this.db.transportSubscription.findUnique({ where: { id } });
    if (!sub || sub.status !== 'ACTIVE') throw new NotFoundException('Abonnement introuvable');
    await this.db.transportSubscription.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: currentActorId() ?? null,
        cancelReason: reason,
      },
    });
    await this.audit.log({
      action: 'transport.cancelled',
      entity: 'TransportSubscription',
      entityId: id,
      reason,
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------- Appel dans le car

  /** Personnel limité à ses lignes (chauffeur, accompagnateur ou rôle propre limité) : son identifiant. */
  private scopedUserId(): string | null {
    const ctx = staffContext();
    return this.scope.isLineScoped() ? ctx.userId : null;
  }

  private async rollCallLine(lineId: string) {
    const line = await this.db.transportLine.findUnique({
      where: { id: lineId },
      include: { stops: { orderBy: { order: 'asc' } }, vehicle: true },
    });
    if (!line) throw new NotFoundException('Ligne introuvable');
    const userId = this.scopedUserId();
    if (userId && !line.staffUserIds.includes(userId))
      throw new ForbiddenException('Vous n’êtes pas affecté(e) à cette ligne');
    return line;
  }

  /** Lignes où l'utilisateur peut faire l'appel. */
  async myLines() {
    const userId = this.scopedUserId();
    const rows = await this.db.transportLine.findMany({
      where: { active: true, ...(userId ? { staffUserIds: { has: userId } } : {}) },
      include: { vehicle: true, stops: { orderBy: { order: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((l) => ({
      id: l.id,
      name: l.name,
      vehicle: l.vehicle ? { plate: l.vehicle.plate, capacity: l.vehicle.capacity } : null,
      stops: l.stops.length,
      firstMorningTime: l.stops.find((s) => s.morningTime)?.morningTime ?? null,
    }));
  }

  private checkDate(date: string) {
    const today = todayInCameroon();
    if (date > today) throw new BadRequestException('Impossible de faire l’appel d’un jour futur');
    if (date < addDays(today, -ROLL_CALL_MAX_AGE_DAYS))
      throw new BadRequestException('Cet appel est trop ancien pour être modifié');
  }

  /** Feuille d'appel : élèves abonnés couvrant ce sens, rangés par arrêt, et pointages existants. */
  async trip(lineId: string, date: string, direction: TripDirection) {
    const line = await this.rollCallLine(lineId);
    const year = await this.scope.currentYear();
    const subs = await this.db.transportSubscription.findMany({
      where: { lineId, academicYearId: year.id, status: 'ACTIVE' },
    });
    const expected = subs.filter((s) => coversTrip(s.direction, direction));
    const students = await this.db.student.findMany({
      where: { id: { in: expected.map((s) => s.studentId) }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    const trip = await this.db.transportTrip.findFirst({
      where: { lineId, date: toDbDate(date), direction },
      include: { records: true },
    });
    const stopOrder = new Map(line.stops.map((s, i) => [s.id, i]));
    const rows = expected
      .map((s) => {
        const student = students.find((x) => x.id === s.studentId);
        const stop = line.stops.find((x) => x.id === s.stopId);
        const record = trip?.records.find((r) => r.studentId === s.studentId);
        return student && stop
          ? {
              studentId: student.id,
              firstName: student.firstName,
              lastName: student.lastName,
              stop: {
                id: stop.id,
                name: stop.name,
                time: direction === 'OUTBOUND' ? stop.morningTime : stop.eveningTime,
              },
              boarded: record?.boarded ?? null,
              alighted: record?.alighted ?? null,
            }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    // Aller : dans l'ordre des arrêts ; retour : ordre inverse (dépose).
    const sign = direction === 'OUTBOUND' ? 1 : -1;
    rows.sort(
      (a, b) =>
        sign * ((stopOrder.get(a.stop.id) ?? 0) - (stopOrder.get(b.stop.id) ?? 0)) ||
        a.lastName.localeCompare(b.lastName, 'fr') ||
        a.firstName.localeCompare(b.firstName, 'fr'),
    );
    return {
      line: { id: line.id, name: line.name, plate: line.vehicle?.plate ?? null },
      date,
      direction,
      directionLabel: TRIP_DIRECTION_LABELS[direction],
      takenAt: trip?.updatedAt ?? null,
      students: rows,
    };
  }

  /**
   * Enregistre l'appel (montée et descente). Idempotent : l'application le renvoie tel quel après
   * une coupure réseau. Un élève non monté déclenche, si l'école l'a choisi, un SMS différé à son
   * parent, annulé si le pointage est corrigé avant l'envoi.
   */
  async saveTrip(input: RollCallInput) {
    this.checkDate(input.date);
    const line = await this.rollCallLine(input.lineId);
    const year = await this.scope.currentYear();
    const subs = await this.db.transportSubscription.findMany({
      where: { lineId: line.id, academicYearId: year.id, status: 'ACTIVE' },
    });
    const expected = new Map(
      subs.filter((s) => coversTrip(s.direction, input.direction)).map((s) => [s.studentId, s]),
    );
    const unknown = input.records.filter((r) => !expected.has(r.studentId));
    if (unknown.length > 0)
      throw new BadRequestException('Un élève de l’appel n’est pas abonné à ce trajet');
    const settings = await this.settings();
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { id: true, name: true },
    });
    const notify = settings.missedBoardingSms && input.date === todayInCameroon();
    const userId = staffContext().userId;
    const now = new Date();
    return this.db.$transaction(async (tx) => {
      const trip = await tx.transportTrip.upsert({
        where: {
          lineId_date_direction: {
            lineId: line.id,
            date: toDbDate(input.date),
            direction: input.direction,
          },
        },
        create: {
          schoolId: school.id,
          lineId: line.id,
          date: toDbDate(input.date),
          direction: input.direction,
          takenById: userId,
        },
        update: { takenById: userId },
      });
      const existing = await tx.transportTripRecord.findMany({ where: { tripId: trip.id } });
      let missed = 0;
      for (const r of input.records) {
        const prev = existing.find((e) => e.studentId === r.studentId);
        const data = {
          boarded: r.boarded,
          alighted: r.alighted,
          boardedAt: r.boarded ? (prev?.boardedAt ?? now) : null,
          alightedAt: r.alighted ? (prev?.alightedAt ?? now) : null,
        };
        const record = prev
          ? await tx.transportTripRecord.update({ where: { id: prev.id }, data })
          : await tx.transportTripRecord.create({
              data: { schoolId: school.id, tripId: trip.id, studentId: r.studentId, ...data },
            });
        if (r.boarded !== false || record.notifiedAt || !notify) continue;
        missed++;
        const phone = await this.finance.guardianPhone(r.studentId, tx);
        if (!phone) continue;
        const student = await tx.student.findUniqueOrThrow({
          where: { id: r.studentId },
          select: { firstName: true, lastName: true },
        });
        const stop = line.stops.find((s) => s.id === expected.get(r.studentId)?.stopId);
        await this.notifications.enqueue(
          {
            schoolId: school.id,
            recipient: phone,
            template: MISSED_BOARDING_TEMPLATE,
            body: transportTemplates.missedBoarding({
              school: school.name,
              student: `${student.firstName} ${student.lastName}`,
              line: line.name,
              stop: stop?.name ?? '—',
              date: input.date.split('-').reverse().join('/'),
              direction: input.direction,
            }),
            payload: { recordId: record.id, tripId: trip.id },
            availableAt: new Date(now.getTime() + MISSED_BOARDING_DELAY_MS),
          },
          tx,
        );
        await tx.transportTripRecord.update({
          where: { id: record.id },
          data: { notifiedAt: now },
        });
      }
      await this.audit.log(
        {
          action: 'transport.roll_call',
          entity: 'TransportTrip',
          entityId: trip.id,
          after: {
            lineId: line.id,
            date: input.date,
            direction: input.direction,
            boarded: input.records.filter((r) => r.boarded === true).length,
            missed: input.records.filter((r) => r.boarded === false).length,
          },
        },
        tx,
      );
      return { tripId: trip.id, saved: input.records.length, notified: missed };
    });
  }

  // ---------------------------------------------------------------- Portail des parents

  /** Ligne, arrêt et horaires de l'enfant ; pointages du jour. Appelé avec les droits système. */
  async forParent(studentId: string) {
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) return { subscription: null, today: [] };
    const sub = await this.db.transportSubscription.findFirst({
      where: { studentId, academicYearId: year.id, status: 'ACTIVE' },
      include: { line: { include: { vehicle: true } }, stop: true },
    });
    if (!sub) return { subscription: null, today: [] };
    const today = todayInCameroon();
    const records = await this.db.transportTripRecord.findMany({
      where: { studentId, trip: { lineId: sub.lineId, date: toDbDate(today) } },
      include: { trip: { select: { direction: true } } },
    });
    return {
      subscription: {
        line: sub.line.name,
        stop: sub.stop.name,
        direction: sub.direction as TransportDirection,
        morningTime: coversTrip(sub.direction, 'OUTBOUND') ? sub.stop.morningTime : null,
        eveningTime: coversTrip(sub.direction, 'RETURN') ? sub.stop.eveningTime : null,
        vehicle: sub.line.vehicle?.plate ?? null,
      },
      today: records
        .map((r) => ({
          direction: r.trip.direction,
          boarded: r.boarded,
          boardedAt: r.boardedAt,
          alighted: r.alighted,
          alightedAt: r.alightedAt,
        }))
        .sort((a, b) => a.direction.localeCompare(b.direction)),
    };
  }
}
