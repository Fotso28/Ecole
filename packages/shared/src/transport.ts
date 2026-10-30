import { z } from 'zod';
import { id, isoDate, timeOfDay } from './schemas';

/** Transport scolaire : lignes, arrêts, véhicules, abonnements et appel dans le car. */

/** Sens couverts par un abonnement : aller (matin), retour (soir) ou les deux. */
export const TRANSPORT_DIRECTIONS = ['OUTBOUND', 'RETURN', 'BOTH'] as const;
export type TransportDirection = (typeof TRANSPORT_DIRECTIONS)[number];

export const TRANSPORT_DIRECTION_LABELS: Record<TransportDirection, string> = {
  OUTBOUND: 'Aller seulement',
  RETURN: 'Retour seulement',
  BOTH: 'Aller et retour',
};

/** Sens d'un trajet : aller (domicile vers école) ou retour (école vers domicile). */
export const TRIP_DIRECTIONS = ['OUTBOUND', 'RETURN'] as const;
export type TripDirection = (typeof TRIP_DIRECTIONS)[number];

export const TRIP_DIRECTION_LABELS: Record<TripDirection, string> = {
  OUTBOUND: 'Aller (matin)',
  RETURN: 'Retour (soir)',
};

/** Vrai si un abonnement couvre le trajet donné. */
export function coversTrip(direction: TransportDirection, trip: TripDirection): boolean {
  return direction === 'BOTH' || direction === trip;
}

/** Places occupées dans le véhicule, pour chaque sens, par les abonnements actifs d'une ligne. */
export function occupancy(
  directions: readonly TransportDirection[],
): Record<TripDirection, number> {
  return {
    OUTBOUND: directions.filter((d) => coversTrip(d, 'OUTBOUND')).length,
    RETURN: directions.filter((d) => coversTrip(d, 'RETURN')).length,
  };
}

/**
 * Vrai si un nouvel abonné tient dans le véhicule : chaque trajet qu'il emprunte doit garder au
 * moins une place libre. Sans véhicule affecté (capacité inconnue), l'inscription est refusée.
 */
export function fitsCapacity(
  capacity: number | null | undefined,
  current: readonly TransportDirection[],
  wanted: TransportDirection,
): boolean {
  if (!capacity || capacity <= 0) return false;
  const used = occupancy(current);
  return TRIP_DIRECTIONS.every((t) => !coversTrip(wanted, t) || used[t] < capacity);
}

/** Tarif annuel d'un abonnement selon le sens (aller-retour ou un seul sens). */
export function subscriptionFee(
  line: { fee: number; oneWayFee: number },
  direction: TransportDirection,
): number {
  return direction === 'BOTH' ? line.fee : line.oneWayFee;
}

export type VehicleDocument = 'INSURANCE' | 'INSPECTION';
export type DocumentState = 'EXPIRED' | 'SOON' | 'OK' | 'MISSING';

export const VEHICLE_DOCUMENT_LABELS: Record<VehicleDocument, string> = {
  INSURANCE: 'Assurance',
  INSPECTION: 'Visite technique',
};

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/**
 * État des documents d'un véhicule (assurance, visite technique) : expiré, bientôt expiré
 * (`warnDays` jours avant l'échéance, échéance comprise) ou à jour.
 */
export function vehicleDocumentAlerts(
  vehicle: { insuranceExpiresOn: string | null; inspectionExpiresOn: string | null },
  today: string,
  warnDays = 30,
): { document: VehicleDocument; state: DocumentState; daysLeft: number | null }[] {
  const entries: [VehicleDocument, string | null][] = [
    ['INSURANCE', vehicle.insuranceExpiresOn],
    ['INSPECTION', vehicle.inspectionExpiresOn],
  ];
  return entries.map(([document, date]) => {
    if (!date) return { document, state: 'MISSING' as const, daysLeft: null };
    const daysLeft = daysBetween(today, date);
    const state: DocumentState = daysLeft < 0 ? 'EXPIRED' : daysLeft <= warnDays ? 'SOON' : 'OK';
    return { document, state, daysLeft };
  });
}

/** Élèves attendus dans le car et non montés (appel enregistré « absent »). */
export function missedBoarding(
  records: readonly { studentId: string; boarded: boolean | null }[],
): string[] {
  return records.filter((r) => r.boarded === false).map((r) => r.studentId);
}

// Schémas
const label = z.string().trim().min(1, 'Champ obligatoire').max(80);
const fcfa = z.number().int('Montant entier en FCFA').nonnegative();

export const transportLineSchema = z.object({
  name: label,
  vehicleId: id.nullable().optional(),
  fee: fcfa,
  oneWayFee: fcfa,
  staffUserIds: z.array(id).max(10).default([]),
  active: z.boolean().default(true),
});

export const transportStopSchema = z.object({
  name: label,
  order: z.number().int().min(1).max(100),
  morningTime: timeOfDay.nullable().optional(),
  eveningTime: timeOfDay.nullable().optional(),
});

export const transportVehicleSchema = z.object({
  plate: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9 -]{4,15}$/, 'Immatriculation invalide'),
  capacity: z.number().int().min(1, 'Capacité d’au moins une place').max(100),
  driverName: z.string().trim().max(80).nullable().optional(),
  driverPhone: z.string().trim().max(20).nullable().optional(),
  insuranceExpiresOn: isoDate.nullable().optional(),
  inspectionExpiresOn: isoDate.nullable().optional(),
});

export const transportSubscriptionSchema = z.object({
  studentId: id,
  lineId: id,
  stopId: id,
  direction: z.enum(TRANSPORT_DIRECTIONS),
  /** Échéance de la ligne facturée ; par défaut, aujourd'hui. */
  dueDate: isoDate.optional(),
});

/** Appel dans le car : envoyé tel quel plusieurs fois sans effet de bord (réseau lent). */
export const transportRollCallSchema = z.object({
  lineId: id,
  date: isoDate,
  direction: z.enum(TRIP_DIRECTIONS),
  records: z
    .array(
      z.object({
        studentId: id,
        boarded: z.boolean().nullable(),
        alighted: z.boolean().nullable().default(null),
      }),
    )
    .max(200),
});

export const transportSettingsSchema = z.object({
  /** SMS au parent quand l'enfant attendu n'est pas monté. */
  missedBoardingSms: z.boolean(),
});
