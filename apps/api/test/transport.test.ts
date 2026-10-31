import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAsSystem } from '../src/common/context';
import { todayInCameroon } from '../src/common/dates';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import {
  createStaff,
  createTestApp,
  login,
  prisma,
  requestOtp,
  resetDb,
  toSession,
  type Session,
} from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let driver: Session;
let driver2: Session;
let driverId: string;
let driver2Id: string;
let a: { id: string };
let b: { id: string };
let c: { id: string };
const http = () => request(app.getHttpServer());
const today = todayInCameroon();

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

async function enableModules(schoolId: string) {
  const school = await prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
  await prisma.school.update({
    where: { id: schoolId },
    data: { modules: [...school.modules, 'transport', 'library'] },
  });
}

beforeEach(async () => {
  await resetDb();
  f = await seedSchool();
  await enableModules(f.schoolId);
  s = await sessions(app);
  driverId = (await createStaff(f.schoolId, 'chauffeur@demo.cm', ['TRANSPORT'])).id;
  driver2Id = (await createStaff(f.schoolId, 'chauffeur2@demo.cm', ['TRANSPORT'])).id;
  driver = await login(app, 'chauffeur@demo.cm');
  driver2 = await login(app, 'chauffeur2@demo.cm');
  a = await enrollStudent(app, s.secretariat, {
    firstName: 'Awa',
    lastName: 'Bello',
    classId: f.class4AId,
    phone: '677000111',
  });
  b = await enrollStudent(app, s.secretariat, {
    firstName: 'Jean',
    lastName: 'Mvondo',
    classId: f.class4AId,
    phone: '677000222',
  });
  c = await enrollStudent(app, s.secretariat, {
    firstName: 'Paul',
    lastName: 'Ondoa',
    classId: f.class6AId,
    phone: '677000333',
  });
});

/** Véhicule de 2 places, ligne A (chauffeur 1) avec deux arrêts, ligne B (chauffeur 2). */
async function network() {
  const vehicle = await http()
    .post('/transport/vehicles')
    .set(s.secretariat.auth)
    .send({
      plate: 'ce 123 ab',
      capacity: 2,
      driverName: 'Ndzana',
      insuranceExpiresOn: '2026-11-15',
      inspectionExpiresOn: '2027-06-01',
    })
    .expect(201);
  const bus2 = await http()
    .post('/transport/vehicles')
    .set(s.secretariat.auth)
    .send({ plate: 'LT 777 CC', capacity: 30 })
    .expect(201);
  const lineA = await http()
    .post('/transport/lines')
    .set(s.secretariat.auth)
    .send({
      name: 'Ligne A – Bastos',
      vehicleId: vehicle.body.id,
      fee: 90000,
      oneWayFee: 50000,
      staffUserIds: [driverId],
    })
    .expect(201);
  const lineB = await http()
    .post('/transport/lines')
    .set(s.secretariat.auth)
    .send({
      name: 'Ligne B – Mvog-Mbi',
      vehicleId: bus2.body.id,
      fee: 80000,
      oneWayFee: 45000,
      staffUserIds: [driver2Id],
    })
    .expect(201);
  const stop1 = await http()
    .post(`/transport/lines/${lineA.body.id}/stops`)
    .set(s.secretariat.auth)
    .send({ name: 'Carrefour Bastos', order: 1, morningTime: '06:45', eveningTime: '17:15' })
    .expect(201);
  const stop2 = await http()
    .post(`/transport/lines/${lineA.body.id}/stops`)
    .set(s.secretariat.auth)
    .send({ name: 'Ambassade', order: 2, morningTime: '06:55', eveningTime: '17:05' })
    .expect(201);
  const stopB = await http()
    .post(`/transport/lines/${lineB.body.id}/stops`)
    .set(s.secretariat.auth)
    .send({ name: 'Marché Mvog-Mbi', order: 1, morningTime: '06:30' })
    .expect(201);
  return {
    vehicleId: vehicle.body.id as string,
    lineA: lineA.body.id as string,
    lineB: lineB.body.id as string,
    stop1: stop1.body.id as string,
    stop2: stop2.body.id as string,
    stopB: stopB.body.id as string,
  };
}

const subscribe = (studentId: string, lineId: string, stopId: string, direction: string) =>
  http()
    .post('/transport/subscriptions')
    .set(s.secretariat.auth)
    .send({ studentId, lineId, stopId, direction });

describe('lignes, véhicules et abonnements', () => {
  it('signale les documents du véhicule bientôt expirés', async () => {
    await network();
    const vehicles = await http().get('/transport/vehicles').set(s.direction.auth).expect(200);
    const bus = vehicles.body.find((v: { plate: string }) => v.plate === 'CE 123 AB');
    expect(bus.alerts.map((x: { document: string }) => x.document)).toContain('INSURANCE');
    const other = vehicles.body.find((v: { plate: string }) => v.plate === 'LT 777 CC');
    expect(other.alerts.every((x: { state: string }) => x.state === 'MISSING')).toBe(true);
  });

  it('respecte la capacité du véhicule, sens par sens', async () => {
    const n = await network();
    await subscribe(a.id, n.lineA, n.stop1, 'BOTH').expect(201);
    await subscribe(b.id, n.lineA, n.stop2, 'OUTBOUND').expect(201);
    const full = await subscribe(c.id, n.lineA, n.stop1, 'OUTBOUND').expect(409);
    expect(full.body.message).toMatch(/complet/);
    await subscribe(c.id, n.lineA, n.stop1, 'RETURN').expect(201);
    const lines = await http().get('/transport/lines').set(s.secretariat.auth).expect(200);
    const lineA = lines.body.find((l: { id: string }) => l.id === n.lineA);
    expect(lineA.occupancy).toEqual({ OUTBOUND: 2, RETURN: 2 });
    // Réduire la capacité sous le nombre d'abonnés est refusé.
    await http()
      .put(`/transport/vehicles/${n.vehicleId}`)
      .set(s.secretariat.auth)
      .send({ plate: 'CE 123 AB', capacity: 1 })
      .expect(409);
  });

  it('facture l’abonnement une seule fois dans la scolarité', async () => {
    const n = await network();
    const sub = await subscribe(a.id, n.lineA, n.stop1, 'BOTH').expect(201);
    expect(sub.body.invoiceLineId).toBeTruthy();
    await subscribe(a.id, n.lineB, n.stopB, 'BOTH').expect(409);
    const lines = await prisma.invoiceLine.findMany({
      where: { invoice: { studentId: a.id }, label: { startsWith: 'Transport scolaire' } },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: 90000, discount: 0, feeItemId: null });
    const ledger = await prisma.ledgerEntry.findMany({
      where: { studentId: a.id, invoiceLineId: lines[0]!.id },
    });
    expect(ledger).toEqual([expect.objectContaining({ type: 'CHARGE', amount: 90000 })]);
    // Le relevé de la scolarité inclut la ligne, avec les règles habituelles.
    const account = await http()
      .get(`/finance/students/${a.id}/account`)
      .set(s.compta.auth)
      .expect(200);
    const line = account.body.lines.find((l: { label: string }) => l.label.startsWith('Transport'));
    expect(line).toMatchObject({ amount: 90000, outstanding: 90000, status: 'UNPAID' });
    // Un seul sens : tarif réduit.
    const one = await subscribe(b.id, n.lineA, n.stop2, 'RETURN').expect(201);
    expect(one.body.fee).toBe(50000);
    expect(await prisma.auditLog.count({ where: { action: 'transport.subscribed' } })).toBe(2);
  });

  it('ne crée qu’un abonnement et une facture sous envois simultanés', async () => {
    const n = await network();
    const results = await Promise.all([
      subscribe(a.id, n.lineA, n.stop1, 'BOTH'),
      subscribe(a.id, n.lineA, n.stop1, 'BOTH'),
      subscribe(a.id, n.lineB, n.stopB, 'BOTH'),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      await prisma.transportSubscription.count({ where: { studentId: a.id, status: 'ACTIVE' } }),
    ).toBe(1);
    expect(
      await prisma.invoiceLine.count({
        where: { invoice: { studentId: a.id }, label: { startsWith: 'Transport scolaire' } },
      }),
    ).toBe(1);
  });

  it('résilie sans toucher à la facture et refuse un arrêt d’une autre ligne', async () => {
    const n = await network();
    const sub = await subscribe(a.id, n.lineA, n.stop1, 'BOTH').expect(201);
    await subscribe(b.id, n.lineA, n.stopB, 'BOTH').expect(400);
    await http()
      .patch(`/transport/subscriptions/${sub.body.id}`)
      .set(s.secretariat.auth)
      .send({ stopId: n.stop2 })
      .expect(200);
    await http()
      .post(`/transport/subscriptions/${sub.body.id}/cancel`)
      .set(s.secretariat.auth)
      .send({ reason: 'Déménagement' })
      .expect(201);
    expect(await prisma.invoiceLine.count({ where: { id: sub.body.invoiceLineId } })).toBe(1);
    const list = await http().get('/transport/subscriptions').set(s.secretariat.auth).expect(200);
    expect(list.body[0]).toMatchObject({ status: 'CANCELLED', cancelReason: 'Déménagement' });
  });

  it('crédite l’ancien abonnement lors d’un réabonnement, sans double facturation', async () => {
    const n = await network();
    const first = await subscribe(a.id, n.lineA, n.stop1, 'BOTH').expect(201);
    // 30 000 FCFA déjà payés sur l'abonnement de la ligne A.
    await http()
      .post('/finance/payments')
      .set(s.compta.auth)
      .send({
        studentId: a.id,
        idempotencyKey: randomUUID(),
        amount: 30000,
        method: 'BANK',
        bankName: 'Banque',
        bankReference: 'VIR-TRANSPORT-1',
        lineIds: [first.body.invoiceLineId],
      })
      .expect(201);
    await http()
      .post(`/transport/subscriptions/${first.body.id}/cancel`)
      .set(s.secretariat.auth)
      .send({ reason: 'Changement de ligne' })
      .expect(201);
    const second = await subscribe(a.id, n.lineB, n.stopB, 'BOTH').expect(201);
    const old = await prisma.invoiceLine.findUniqueOrThrow({
      where: { id: first.body.invoiceLineId },
    });
    const next = await prisma.invoiceLine.findUniqueOrThrow({
      where: { id: second.body.invoiceLineId },
    });
    // Ancienne ligne : avoir du reste dû ; nouvelle ligne : le déjà-payé vient en déduction.
    expect([old.amount, old.discount]).toEqual([90000, 60000]);
    expect([next.amount, next.discount]).toEqual([80000, 30000]);
    const account = await http()
      .get(`/finance/students/${a.id}/account`)
      .set(s.compta.auth)
      .expect(200);
    const transport = account.body.lines.filter((l: { label: string }) =>
      l.label.startsWith('Transport'),
    );
    expect(transport.reduce((t: number, l: { outstanding: number }) => t + l.outstanding, 0)).toBe(
      50000,
    );
    expect(await prisma.auditLog.count({ where: { action: 'finance.credit_note' } })).toBe(2);

    // Geste commercial par le gestionnaire du transport, limité à la ligne de l'abonnement.
    await http()
      .post(`/transport/subscriptions/${second.body.id}/credit`)
      .set(s.secretariat.auth)
      .send({ amount: 60000, reason: 'Résiliation au deuxième trimestre' })
      .expect(409);
    const credit = await http()
      .post(`/transport/subscriptions/${second.body.id}/credit`)
      .set(s.secretariat.auth)
      .send({ amount: 10000, reason: 'Ligne interrompue deux semaines' })
      .expect(201);
    expect(credit.body).toEqual({ credited: 10000 });
    // Aucun droit de remise sur la scolarité pour autant.
    const tuition = await prisma.invoiceLine.findFirstOrThrow({
      where: { invoice: { studentId: a.id }, label: 'Tranche 1' },
    });
    await http()
      .post(`/finance/invoice-lines/${tuition.id}/discounts`)
      .set(s.secretariat.auth)
      .send({ amount: 10000, reason: 'Geste' })
      .expect(403);
    await http()
      .post(`/transport/subscriptions/${second.body.id}/credit`)
      .set(s.prof.auth)
      .send({ amount: 1000, reason: 'Geste commercial' })
      .expect(403);
  });

  it('réserve la gestion au secrétariat et à la direction', async () => {
    await http().get('/transport/lines').set(s.prof.auth).expect(403);
    await http()
      .post('/transport/vehicles')
      .set(s.compta.auth)
      .send({ plate: 'CE 999 ZZ', capacity: 10 })
      .expect(403);
    await http().get('/transport/lines').set(driver.auth).expect(403);
    // Module désactivé : routes fermées.
    await prisma.school.update({
      where: { id: f.schoolId },
      data: { modules: ['students', 'finance'] },
    });
    await http().get('/transport/lines').set(s.direction.auth).expect(403);
  });
});

describe('appel dans le car', () => {
  async function prepared() {
    const n = await network();
    await subscribe(a.id, n.lineA, n.stop1, 'BOTH').expect(201);
    await subscribe(b.id, n.lineA, n.stop2, 'OUTBOUND').expect(201);
    await subscribe(c.id, n.lineA, n.stop1, 'RETURN').expect(201);
    return n;
  }

  it('limite le chauffeur ou l’accompagnateur à ses lignes', async () => {
    const n = await prepared();
    const mine = await http().get('/transport/my-lines').set(driver.auth).expect(200);
    expect(mine.body.map((l: { id: string }) => l.id)).toEqual([n.lineA]);
    const q = `lineId=${n.lineA}&date=${today}&direction=OUTBOUND`;
    await http().get(`/transport/trips?${q}`).set(driver2.auth).expect(403);
    await http()
      .put('/transport/trips')
      .set(driver2.auth)
      .send({ lineId: n.lineA, date: today, direction: 'OUTBOUND', records: [] })
      .expect(403);
    // Aucun accès aux dossiers des élèves.
    await http().get(`/students/${a.id}`).set(driver.auth).expect(403);
    await http().get('/students').set(driver.auth).expect(403);
    // Le surveillant fait l'appel sur toutes les lignes ; un enseignant non.
    await http().get(`/transport/trips?${q}`).set(s.surveillant.auth).expect(200);
    await http().get('/transport/my-lines').set(s.prof.auth).expect(403);
  });

  it('applique la limite de lignes d’un rôle propre à l’école', async () => {
    const n = await prepared();
    const role = await http()
      .post('/roles/custom')
      .set(s.direction.auth)
      .send({ name: 'Accompagnatrice', permissions: ['transport.rollcall'], lineScoped: true })
      .expect(201);
    await prisma.membership.updateMany({
      where: { userId: driver2Id, schoolId: f.schoolId },
      data: { roles: [], customRoleIds: [role.body.id] },
    });
    const q = `lineId=${n.lineA}&date=${today}&direction=OUTBOUND`;
    await http().get(`/transport/trips?${q}`).set(driver2.auth).expect(403);
    const mine = await http().get('/transport/my-lines').set(driver2.auth).expect(200);
    expect(mine.body.map((l: { id: string }) => l.id)).toEqual([n.lineB]);
    // Sans la limite, le rôle fait l'appel sur toutes les lignes.
    await http()
      .put(`/roles/custom/${role.body.id}`)
      .set(s.direction.auth)
      .send({ name: 'Accompagnatrice', permissions: ['transport.rollcall'] })
      .expect(200);
    await http().get(`/transport/trips?${q}`).set(driver2.auth).expect(200);
  });

  it('liste les élèves attendus par sens, dans l’ordre des arrêts', async () => {
    const n = await prepared();
    const morning = await http()
      .get(`/transport/trips?lineId=${n.lineA}&date=${today}&direction=OUTBOUND`)
      .set(driver.auth)
      .expect(200);
    expect(morning.body.students.map((x: { firstName: string }) => x.firstName)).toEqual([
      'Awa',
      'Jean',
    ]);
    expect(morning.body.students[0].stop).toMatchObject({
      name: 'Carrefour Bastos',
      time: '06:45',
    });
    const evening = await http()
      .get(`/transport/trips?lineId=${n.lineA}&date=${today}&direction=RETURN`)
      .set(driver.auth)
      .expect(200);
    expect(evening.body.students.map((x: { firstName: string }) => x.firstName).sort()).toEqual([
      'Awa',
      'Paul',
    ]);
  });

  it('enregistre montée et descente, rejouable, et prévient le parent si l’enfant n’est pas monté', async () => {
    const n = await prepared();
    await http()
      .put('/transport/settings')
      .set(s.secretariat.auth)
      .send({ missedBoardingSms: true })
      .expect(200);
    const body = {
      lineId: n.lineA,
      date: today,
      direction: 'OUTBOUND',
      records: [
        { studentId: a.id, boarded: true, alighted: null },
        { studentId: b.id, boarded: false, alighted: null },
      ],
    };
    const first = await http().put('/transport/trips').set(driver.auth).send(body).expect(200);
    expect(first.body).toMatchObject({ saved: 2, notified: 1 });
    // Réseau lent : le même appel renvoyé ne crée ni doublon ni second SMS.
    await http().put('/transport/trips').set(driver.auth).send(body).expect(200);
    expect(await prisma.transportTripRecord.count()).toBe(2);
    const outbox = await prisma.notificationOutbox.findMany({
      where: { template: 'transportMissedBoarding' },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.recipient).toBe('+237677000222');
    expect(outbox[0]!.body).toContain('Jean Mvondo');
    expect(outbox[0]!.availableAt.getTime()).toBeGreaterThan(Date.now());
    // Descente à l'école.
    await http()
      .put('/transport/trips')
      .set(driver.auth)
      .send({ ...body, records: [{ studentId: a.id, boarded: true, alighted: true }] })
      .expect(200);
    const rec = await prisma.transportTripRecord.findFirstOrThrow({ where: { studentId: a.id } });
    expect(rec.alighted).toBe(true);
    expect(rec.boardedAt).not.toBeNull();
    expect(rec.alightedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'transport.roll_call' } })).toBe(3);

    // Pointage corrigé avant l'envoi : le SMS est annulé.
    await http()
      .put('/transport/trips')
      .set(driver.auth)
      .send({ ...body, records: [{ studentId: b.id, boarded: true, alighted: null }] })
      .expect(200);
    await prisma.notificationOutbox.updateMany({
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await runAsSystem('test', () => app.get(NotificationsService).dispatchPending(10));
    const after = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'transportMissedBoarding' },
    });
    expect(after.status).toBe('CANCELLED');
  });

  it('garde l’heure du pointage sur le téléphone (appel envoyé au retour du réseau), bornée', async () => {
    const n = await prepared();
    // Pointé sans réseau plus tôt dans la journée, reçu maintenant.
    const dayStart = new Date(`${today}T00:00:00+01:00`).getTime();
    const pointed = new Date(Math.max(dayStart + 60_000, Date.now() - 3_600_000));
    const before = Date.now();
    await http()
      .put('/transport/trips')
      .set(driver.auth)
      .send({
        lineId: n.lineA,
        date: today,
        direction: 'OUTBOUND',
        records: [
          { studentId: a.id, boarded: true, alighted: null, boardedAt: pointed.toISOString() },
          // Téléphone mal réglé : heure absurde remplacée par l'heure de réception.
          { studentId: b.id, boarded: true, alighted: null, boardedAt: '2020-01-01T07:00:00Z' },
        ],
      })
      .expect(200);
    const after = Date.now();
    const recA = await prisma.transportTripRecord.findFirstOrThrow({ where: { studentId: a.id } });
    // Heure du téléphone (sauf juste après minuit, où elle serait postérieure à la réception).
    expect(recA.boardedAt!.toISOString()).toBe(
      pointed.getTime() <= before ? pointed.toISOString() : recA.boardedAt!.toISOString(),
    );
    expect(recA.boardedAt!.getTime()).toBeLessThanOrEqual(after + 1000);
    const recB = await prisma.transportTripRecord.findFirstOrThrow({ where: { studentId: b.id } });
    expect(recB.boardedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(recB.boardedAt!.getTime()).toBeLessThanOrEqual(after + 1000);
    // Un renvoi du même appel ne change pas l'heure déjà enregistrée.
    await http()
      .put('/transport/trips')
      .set(driver.auth)
      .send({
        lineId: n.lineA,
        date: today,
        direction: 'OUTBOUND',
        records: [{ studentId: a.id, boarded: true, alighted: null }],
      })
      .expect(200);
    expect(
      (await prisma.transportTripRecord.findFirstOrThrow({ where: { studentId: a.id } })).boardedAt,
    ).toEqual(recA.boardedAt);
  });

  it('n’envoie pas de SMS sans le réglage de l’école ni pour un élève non abonné', async () => {
    const n = await prepared();
    await http()
      .put('/transport/trips')
      .set(driver.auth)
      .send({
        lineId: n.lineA,
        date: today,
        direction: 'OUTBOUND',
        records: [{ studentId: b.id, boarded: false }],
      })
      .expect(200);
    expect(
      await prisma.notificationOutbox.count({ where: { template: 'transportMissedBoarding' } }),
    ).toBe(0);
    // Paul n'est abonné qu'au retour.
    await http()
      .put('/transport/trips')
      .set(driver.auth)
      .send({
        lineId: n.lineA,
        date: today,
        direction: 'OUTBOUND',
        records: [{ studentId: c.id, boarded: true }],
      })
      .expect(400);
    await http()
      .put('/transport/trips')
      .set(driver.auth)
      .send({ lineId: n.lineA, date: '2099-01-01', direction: 'OUTBOUND', records: [] })
      .expect(400);
  });
});

describe('portail et isolation', () => {
  it('montre au parent la ligne, l’arrêt et l’horaire de son enfant', async () => {
    const n = await network();
    await subscribe(a.id, n.lineA, n.stop1, 'BOTH').expect(201);
    await http()
      .put('/transport/trips')
      .set(driver.auth)
      .send({
        lineId: n.lineA,
        date: today,
        direction: 'OUTBOUND',
        records: [{ studentId: a.id, boarded: true }],
      })
      .expect(200);
    const code = await requestOtp(app, '677000111');
    const parent = toSession(
      await http().post('/auth/otp/verify').send({ phone: '677000111', code }).expect(200),
    );
    const res = await http().get(`/portal/children/${a.id}/transport`).set(parent.auth).expect(200);
    expect(res.body).toMatchObject({
      enabled: true,
      subscription: {
        line: 'Ligne A – Bastos',
        stop: 'Carrefour Bastos',
        direction: 'BOTH',
        morningTime: '06:45',
        eveningTime: '17:15',
        vehicle: 'CE 123 AB',
      },
    });
    expect(res.body.today).toEqual([
      expect.objectContaining({ direction: 'OUTBOUND', boarded: true }),
    ]);
    await http().get(`/portal/children/${b.id}/transport`).set(parent.auth).expect(404);
    await http().get('/transport/lines').set(parent.auth).expect(403);
  });

  it('cloisonne lignes, véhicules et abonnements entre écoles', async () => {
    const n = await network();
    await subscribe(a.id, n.lineA, n.stop1, 'BOTH').expect(201);
    const other = await seedSchool('autre', 'AU');
    await enableModules(other.schoolId);
    const o = await sessions(app, 'autre');
    const lines = await http().get('/transport/lines').set(o.direction.auth).expect(200);
    expect(lines.body).toEqual([]);
    expect((await http().get('/transport/vehicles').set(o.direction.auth)).body).toEqual([]);
    expect((await http().get('/transport/subscriptions').set(o.direction.auth)).body).toEqual([]);
    await http()
      .put(`/transport/lines/${n.lineA}`)
      .set(o.direction.auth)
      .send({ name: 'Piratage', fee: 0, oneWayFee: 0 })
      .expect(404);
    await http()
      .post(`/transport/lines/${n.lineA}/stops`)
      .set(o.direction.auth)
      .send({ name: 'Intrus', order: 9 })
      .expect(404);
    const ob = await enrollStudent(app, o.secretariat, {
      firstName: 'Zoé',
      lastName: 'Ewane',
      classId: other.class4AId,
    });
    await http()
      .post('/transport/subscriptions')
      .set(o.secretariat.auth)
      .send({ studentId: ob.id, lineId: n.lineA, stopId: n.stop1, direction: 'BOTH' })
      .expect(404);
    await http()
      .get(`/transport/trips?lineId=${n.lineA}&date=${today}&direction=OUTBOUND`)
      .set(o.direction.auth)
      .expect(404);
    // Un chauffeur ne peut pas être affecté à une ligne d'une autre école.
    await http()
      .post('/transport/lines')
      .set(o.direction.auth)
      .send({ name: 'Ligne Z', fee: 0, oneWayFee: 0, staffUserIds: [driverId] })
      .expect(400);
  });
});
