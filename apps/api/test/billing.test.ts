import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayInCameroon } from '../src/common/dates';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import {
  createPlatformAdmin,
  createTestApp,
  loginPlatformAdmin,
  prisma,
  resetDb,
  type Session,
} from './helpers';

let app: INestApplication;
let a: SchoolFixture;
let b: SchoolFixture;
let sa: Awaited<ReturnType<typeof sessions>>;
let sb: Awaited<ReturnType<typeof sessions>>;
let admin: Session;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  a = await seedSchool('demo', 'CD');
  b = await seedSchool('autre', 'AU');
  sa = await sessions(app, 'demo');
  sb = await sessions(app, 'autre');
  for (const [firstName, lastName] of [
    ['Marie-Claire', 'Ngono'],
    ['Paul-Henri', 'Ngono'],
    ['Awa', 'Bello'],
  ] as const)
    await enrollStudent(app, sa.secretariat, { firstName, lastName, classId: a.class4AId });
  await enrollStudent(app, sb.secretariat, {
    firstName: 'Junior',
    lastName: 'Tchoupo',
    classId: b.class4AId,
  });
  await prisma.school.update({ where: { id: a.schoolId }, data: { phone: '+237222234567' } });
  await createPlatformAdmin();
  admin = await loginPlatformAdmin(app);
});

async function perStudentPlan(price = 1500) {
  return (
    await http()
      .post('/platform/billing/plans')
      .set(admin.auth)
      .send({ name: `Essentiel ${price}`, pricing: 'PER_STUDENT', pricePerStudent: price })
      .expect(201)
  ).body as { id: string };
}

function issue(schoolId: string, dueDate = addDays(todayInCameroon(), 30)) {
  return http()
    .post(`/platform/billing/schools/${schoolId}/invoices`)
    .set(admin.auth)
    .send({ dueDate });
}

describe('offres d’abonnement', () => {
  it('crée des offres par élève et par module, avec des montants entiers', async () => {
    await perStudentPlan();
    const modules = await http()
      .post('/platform/billing/plans')
      .set(admin.auth)
      .send({
        name: 'À la carte',
        pricing: 'PER_MODULE',
        modulePrices: { students: 50000, grades: 150000, finance: 200000 },
      })
      .expect(201);
    expect(modules.body).toMatchObject({ pricing: 'PER_MODULE', pricePerStudent: 0 });
    await http()
      .post('/platform/billing/plans')
      .set(admin.auth)
      .send({ name: 'Décimal', pricing: 'PER_STUDENT', pricePerStudent: 10.5 })
      .expect(400);
    await http()
      .post('/platform/billing/plans')
      .set(admin.auth)
      .send({ name: 'Essentiel 1500', pricing: 'PER_STUDENT', pricePerStudent: 900 })
      .expect(409);
    const list = await http().get('/platform/billing/plans').set(admin.auth).expect(200);
    expect(list.body).toHaveLength(2);
    expect(
      await prisma.auditLog.count({ where: { action: 'platform.subscription_plan_created' } }),
    ).toBe(2);
  });

  it('réserve la facturation au super-administrateur', async () => {
    await http().get('/platform/billing/schools').set(sa.direction.auth).expect(403);
    await http()
      .post('/platform/billing/plans')
      .set(sa.direction.auth)
      .send({ name: 'Pirate', pricing: 'PER_STUDENT', pricePerStudent: 1 })
      .expect(403);
    await http().get('/platform/billing/schools').expect(401);
  });
});

describe('factures calculées sur des chiffres agrégés', () => {
  it('facture l’effectif inscrit sans exposer de donnée d’élève', async () => {
    const plan = await perStudentPlan(1500);
    await http()
      .put(`/platform/billing/schools/${a.schoolId}/subscription`)
      .set(admin.auth)
      .send({ planId: plan.id })
      .expect(200);
    const overview = await http().get('/platform/billing/schools').set(admin.auth).expect(200);
    const rowA = overview.body.schools.find((s: { id: string }) => s.id === a.schoolId);
    expect(rowA).toMatchObject({ studentCount: 3, estimate: 4500, plan: { id: plan.id } });
    const detail = await http()
      .get(`/platform/billing/schools/${a.schoolId}`)
      .set(admin.auth)
      .expect(200);
    expect(detail.body.preview).toMatchObject({
      period: '2026-2027',
      studentCount: 3,
      total: 4500,
    });
    // Aucune donnée nominative dans les réponses de la plateforme.
    const text = JSON.stringify([overview.body, detail.body]);
    for (const name of ['Marie-Claire', 'Ngono', 'Bello', 'Tchoupo', 'CD-'])
      expect(text).not.toContain(name);

    const invoice = await issue(a.schoolId).expect(201);
    expect(invoice.body).toMatchObject({
      number: 'ABO-2026-0001',
      period: '2026-2027',
      studentCount: 3,
      amount: 4500,
      paid: 0,
      due: 4500,
      state: 'DUE',
      lines: [{ quantity: 3, unitPrice: 1500, amount: 4500 }],
    });
    // Une seule facture en cours par année.
    await issue(a.schoolId).expect(409);
    // Un nouvel élève n'a aucun effet sur la facture émise.
    await enrollStudent(app, sa.secretariat, {
      firstName: 'Nouvel',
      lastName: 'Élève',
      classId: a.class4AId,
    });
    const after = await http()
      .get(`/platform/billing/schools/${a.schoolId}`)
      .set(admin.auth)
      .expect(200);
    expect(after.body.invoices[0].amount).toBe(4500);
    expect(after.body.preview.total).toBe(6000);
  });

  it('facture les modules activés et exige une offre', async () => {
    await issue(b.schoolId).expect(400);
    const plan = await http()
      .post('/platform/billing/plans')
      .set(admin.auth)
      .send({
        name: 'À la carte',
        pricing: 'PER_MODULE',
        modulePrices: { students: 50000, grades: 150000, finance: 200000, exams: 99999 },
      })
      .expect(201);
    await http()
      .put(`/platform/billing/schools/${b.schoolId}/subscription`)
      .set(admin.auth)
      .send({ planId: plan.body.id })
      .expect(200);
    const invoice = await issue(b.schoolId).expect(201);
    // Modules de l'école : students, attendance, grades, finance, communication, portal, timetable.
    expect(invoice.body.amount).toBe(400000);
    expect(invoice.body.lines).toHaveLength(7);
    expect(invoice.body.modules).not.toContain('exams');
  });

  it('annule une facture puis en émet une nouvelle, sans modifier l’ancienne', async () => {
    const plan = await perStudentPlan();
    await http()
      .put(`/platform/billing/schools/${a.schoolId}/subscription`)
      .set(admin.auth)
      .send({ planId: plan.id })
      .expect(200);
    const first = await issue(a.schoolId).expect(201);
    await http()
      .post(`/platform/billing/invoices/${first.body.id}/cancel`)
      .set(admin.auth)
      .send({ reason: 'Effectif erroné' })
      .expect(201);
    const second = await issue(a.schoolId).expect(201);
    expect(second.body.number).toBe('ABO-2026-0002');
    await expect(
      prisma.subscriptionInvoice.update({ where: { id: second.body.id }, data: { amount: 1 } }),
    ).rejects.toThrow(/figée/);
    await expect(
      prisma.subscriptionInvoice.update({
        where: { id: first.body.id },
        data: { status: 'ISSUED' },
      }),
    ).rejects.toThrow(/annulée/);
    expect(
      await prisma.auditLog.count({ where: { action: 'platform.subscription_invoice_cancelled' } }),
    ).toBe(1);
  });
});

describe('règlements et relances', () => {
  let invoiceId: string;
  beforeEach(async () => {
    const plan = await perStudentPlan(10000);
    await http()
      .put(`/platform/billing/schools/${a.schoolId}/subscription`)
      .set(admin.auth)
      .send({ planId: plan.id })
      .expect(200);
    invoiceId = (await issue(a.schoolId, addDays(todayInCameroon(), -5)).expect(201)).body.id;
  });

  const pay = (amount: number) =>
    http()
      .post(`/platform/billing/invoices/${invoiceId}/payments`)
      .set(admin.auth)
      .send({ amount, method: 'BANK_TRANSFER', reference: 'VIR-0042', paidOn: todayInCameroon() });

  it('enregistre des règlements en ajout seul et corrige par écriture négative', async () => {
    const partial = await pay(10000).expect(201);
    expect(partial.body).toMatchObject({
      amount: 30000,
      paid: 10000,
      due: 20000,
      state: 'OVERDUE',
    });
    await pay(25000).expect(400);
    await pay(0).expect(400);
    const full = await pay(20000).expect(201);
    expect(full.body).toMatchObject({ paid: 30000, due: 0, state: 'PAID' });

    const paymentId = full.body.payments[1].id as string;
    const corrected = await http()
      .post(`/platform/billing/payments/${paymentId}/correct`)
      .set(admin.auth)
      .send({ reason: 'Virement rejeté par la banque' })
      .expect(201);
    expect(corrected.body).toMatchObject({ paid: 10000, due: 20000, state: 'OVERDUE' });
    expect(corrected.body.payments.map((p: { amount: number }) => p.amount)).toEqual([
      10000, 20000, -20000,
    ]);
    await http()
      .post(`/platform/billing/payments/${paymentId}/correct`)
      .set(admin.auth)
      .send({ reason: 'Deuxième correction' })
      .expect(409);
    await expect(
      prisma.subscriptionPayment.update({ where: { id: paymentId }, data: { amount: 1 } }),
    ).rejects.toThrow(/ne peuvent être ni modifiées ni supprimées/);
    await expect(prisma.subscriptionPayment.delete({ where: { id: paymentId } })).rejects.toThrow();
    // Une facture réglée en partie ne s'annule pas sans corriger ses règlements.
    await http()
      .post(`/platform/billing/invoices/${invoiceId}/cancel`)
      .set(admin.auth)
      .send({ reason: 'Erreur de saisie' })
      .expect(400);
    expect(
      await prisma.auditLog.count({
        where: {
          action: {
            in: [
              'platform.subscription_payment_recorded',
              'platform.subscription_payment_corrected',
            ],
          },
          schoolId: a.schoolId,
        },
      }),
    ).toBe(3);
  });

  it('ne laisse jamais une facture annulée avec un règlement, même en simultané', async () => {
    const results = await Promise.all([
      pay(30000),
      http()
        .post(`/platform/billing/invoices/${invoiceId}/cancel`)
        .set(admin.auth)
        .send({ reason: 'Erreur de saisie' }),
    ]);
    // L'une des deux opérations passe, l'autre est refusée.
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });
    const paid = invoice.payments.reduce((t, p) => t + p.amount, 0);
    expect(invoice.status === 'CANCELLED' && paid > 0).toBe(false);
  });

  it('relance par SMS via la table d’envoi et trace la relance', async () => {
    const res = await http()
      .post(`/platform/billing/invoices/${invoiceId}/reminders`)
      .set(admin.auth)
      .expect(201);
    expect(res.body.reminders).toBe(1);
    const sms = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'subscriptionReminder' },
    });
    expect(sms).toMatchObject({ recipient: '+237222234567', schoolId: a.schoolId });
    expect(sms.body).toContain('ABO-2026-0001');
    expect(sms.body).toContain('30');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'platform.subscription_reminder_sent' },
    });
    expect(audit.actorId).not.toBeNull();
    await pay(30000).expect(201);
    await http()
      .post(`/platform/billing/invoices/${invoiceId}/reminders`)
      .set(admin.auth)
      .expect(400);
  });

  it('montre à la direction sa facture et un avertissement, sans couper l’accès', async () => {
    await pay(5000).expect(201);
    const mine = await http().get('/subscription').set(sa.direction.auth).expect(200);
    expect(mine.body.warning).toEqual({ level: 'overdue', due: 25000 });
    expect(mine.body.invoices).toHaveLength(1);
    expect(mine.body.invoices[0]).toMatchObject({ number: 'ABO-2026-0001', state: 'OVERDUE' });
    expect(mine.body.plan).toMatchObject({ pricing: 'PER_STUDENT', pricePerStudent: 10000 });
    // Aucune coupure : l'école en retard continue de travailler.
    await http().get('/students').set(sa.direction.auth).expect(200);
    await http().get('/finance/summary').set(sa.compta.auth).expect(200);
    // Réservé à la direction.
    await http().get('/subscription').set(sa.compta.auth).expect(403);
    await http().get('/subscription').set(sa.prof.auth).expect(403);
  });

  it('isole les factures d’une école des autres écoles', async () => {
    const other = await http().get('/subscription').set(sb.direction.auth).expect(200);
    expect(other.body).toMatchObject({ plan: null, invoices: [], warning: null });
    expect(other.body.schoolId).toBe(b.schoolId);
    // Le cloisonnement s'applique aussi directement aux tables de facturation.
    const { runInContext } = await import('../src/common/context');
    const { DB } = await import('../src/common/prisma');
    const db = app.get(DB);
    const ctx = {
      kind: 'staff' as const,
      userId: 'x',
      schoolId: b.schoolId,
      roles: ['DIRECTOR' as const],
      permissions: new Set<never>(),
      isPlatformAdmin: false,
      breakGlass: false,
    };
    await runInContext(ctx, async () => {
      expect(await db.subscriptionInvoice.count()).toBe(0);
      expect(await db.subscriptionPayment.count()).toBe(0);
      expect(await db.subscriptionInvoice.findUnique({ where: { id: invoiceId } })).toBeNull();
      await expect(
        db.subscriptionPayment.create({
          data: {
            schoolId: a.schoolId,
            invoiceId,
            amount: 30000,
            method: 'CASH',
            paidOn: new Date(),
          },
        }),
      ).rejects.toThrow(/inter-établissement/);
    });
  });
});
