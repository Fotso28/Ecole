import { describe, expect, it } from 'vitest';
import { hasPermission, isLineScoped } from './permissions';
import {
  coversTrip,
  fitsCapacity,
  missedBoarding,
  occupancy,
  rollCallTimestamp,
  subscriptionFee,
  transportRollCallSchema,
  transportVehicleSchema,
  vehicleDocumentAlerts,
} from './transport';

describe('capacité des véhicules', () => {
  it('compte les places par sens', () => {
    expect(occupancy(['BOTH', 'OUTBOUND', 'RETURN', 'BOTH'])).toEqual({ OUTBOUND: 3, RETURN: 3 });
    expect(occupancy([])).toEqual({ OUTBOUND: 0, RETURN: 0 });
  });

  it('refuse un abonné de trop sur un trajet plein', () => {
    expect(fitsCapacity(2, ['BOTH'], 'BOTH')).toBe(true);
    expect(fitsCapacity(2, ['BOTH', 'OUTBOUND'], 'BOTH')).toBe(false);
    expect(fitsCapacity(2, ['BOTH', 'OUTBOUND'], 'OUTBOUND')).toBe(false);
  });

  it('accepte un abonné sur le sens encore libre', () => {
    expect(fitsCapacity(2, ['BOTH', 'OUTBOUND'], 'RETURN')).toBe(true);
    expect(fitsCapacity(1, ['RETURN'], 'OUTBOUND')).toBe(true);
  });

  it('refuse sans véhicule ni capacité', () => {
    expect(fitsCapacity(null, [], 'BOTH')).toBe(false);
    expect(fitsCapacity(0, [], 'OUTBOUND')).toBe(false);
  });

  it('associe les abonnements aux trajets', () => {
    expect(coversTrip('BOTH', 'RETURN')).toBe(true);
    expect(coversTrip('OUTBOUND', 'RETURN')).toBe(false);
  });
});

describe('tarif', () => {
  it('distingue aller-retour et un seul sens', () => {
    const line = { fee: 90000, oneWayFee: 55000 };
    expect(subscriptionFee(line, 'BOTH')).toBe(90000);
    expect(subscriptionFee(line, 'RETURN')).toBe(55000);
  });
});

describe('documents des véhicules', () => {
  it('signale expiration et échéance proche', () => {
    const alerts = vehicleDocumentAlerts(
      { insuranceExpiresOn: '2026-10-29', inspectionExpiresOn: '2026-11-28' },
      '2026-10-30',
    );
    expect(alerts).toEqual([
      { document: 'INSURANCE', state: 'EXPIRED', daysLeft: -1 },
      { document: 'INSPECTION', state: 'SOON', daysLeft: 29 },
    ]);
  });

  it('considère le jour même comme proche et signale les dates manquantes', () => {
    const alerts = vehicleDocumentAlerts(
      { insuranceExpiresOn: '2026-10-30', inspectionExpiresOn: null },
      '2026-10-30',
      15,
    );
    expect(alerts[0]).toMatchObject({ state: 'SOON', daysLeft: 0 });
    expect(alerts[1]).toMatchObject({ state: 'MISSING', daysLeft: null });
    expect(
      vehicleDocumentAlerts(
        { insuranceExpiresOn: '2027-06-30', inspectionExpiresOn: '2027-01-01' },
        '2026-10-30',
      ).every((a) => a.state === 'OK'),
    ).toBe(true);
  });
});

describe('appel dans le car', () => {
  it('liste les élèves non montés, pas ceux non encore pointés', () => {
    expect(
      missedBoarding([
        { studentId: 'a', boarded: true },
        { studentId: 'b', boarded: false },
        { studentId: 'c', boarded: null },
      ]),
    ).toEqual(['b']);
  });

  it('valide l’appel', () => {
    const ok = transportRollCallSchema.safeParse({
      lineId: 'l',
      date: '2026-10-30',
      direction: 'OUTBOUND',
      records: [{ studentId: 's', boarded: true }],
    });
    expect(ok.success && ok.data.records[0]?.alighted).toBe(null);
    expect(
      transportRollCallSchema.safeParse({
        lineId: 'l',
        date: '2026-10-30',
        direction: 'BOTH',
        records: [],
      }).success,
    ).toBe(false);
  });

  it('garde l’heure du pointage sur le téléphone, bornée aux valeurs plausibles', () => {
    // Pointé à 6 h 44 (Douala) sans réseau, reçu à 11 h 44 au retour du réseau.
    const received = new Date('2026-10-31T10:44:00Z');
    expect(rollCallTimestamp('2026-10-31T05:44:00Z', received, '2026-10-31')).toEqual(
      new Date('2026-10-31T05:44:00Z'),
    );
    // Absente ou illisible : heure de réception.
    expect(rollCallTimestamp(undefined, received, '2026-10-31')).toBe(received);
    expect(rollCallTimestamp('hier matin', received, '2026-10-31')).toBe(received);
    // Horloge du téléphone en avance : tolérance de 5 minutes, ramenée à la réception.
    expect(rollCallTimestamp('2026-10-31T10:47:00Z', received, '2026-10-31')).toBe(received);
    expect(rollCallTimestamp('2026-10-31T12:00:00Z', received, '2026-10-31')).toBe(received);
    // Hors du jour du trajet (heure de Douala) : téléphone mal réglé.
    expect(rollCallTimestamp('2020-01-01T07:00:00Z', received, '2026-10-31')).toBe(received);
    expect(rollCallTimestamp('2026-10-30T22:30:00Z', received, '2026-10-31')).toBe(received);
    // 23 h 30 UTC le 30 = 0 h 30 le 31 à Douala : même jour de trajet.
    expect(rollCallTimestamp('2026-10-30T23:30:00Z', received, '2026-10-31')).toEqual(
      new Date('2026-10-30T23:30:00Z'),
    );
  });

  it('normalise l’immatriculation', () => {
    const v = transportVehicleSchema.parse({ plate: ' ce 123 ab ', capacity: 30 });
    expect(v.plate).toBe('CE 123 AB');
    expect(transportVehicleSchema.safeParse({ plate: 'CE-1', capacity: 0 }).success).toBe(false);
  });
});

describe('rôle chauffeur ou accompagnateur', () => {
  it('ne fait que l’appel, limité à ses lignes', () => {
    expect(hasPermission(['TRANSPORT'], 'transport.rollcall')).toBe(true);
    expect(hasPermission(['TRANSPORT'], 'transport.read')).toBe(false);
    expect(hasPermission(['TRANSPORT'], 'students.read')).toBe(false);
    expect(isLineScoped(['TRANSPORT'])).toBe(true);
    expect(isLineScoped(['TRANSPORT', 'SUPERVISOR'])).toBe(false);
    expect(isLineScoped(['TRANSPORT', 'TEACHER'])).toBe(true);
    expect(isLineScoped(['SUPERVISOR'])).toBe(false);
  });
});
