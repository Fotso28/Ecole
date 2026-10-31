import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayInCameroon, toDbDate } from '../src/common/dates';
import { FinanceService } from '../src/modules/finance/finance.service';
import {
  signWebhook,
  SimulatorMobileMoneyProvider,
} from '../src/modules/finance/mobile-money.provider';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, requestOtp, resetDb, toSession } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let student: string;
const http = () => request(app.getHttpServer());
const today = () => todayInCameroon();

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  SimulatorMobileMoneyProvider.statuses.clear();
  SimulatorMobileMoneyProvider.requests.length = 0;
  f = await seedSchool();
  // Échéances relatives à aujourd'hui : deux échues, deux à venir.
  const due: Record<string, string> = {
    Inscription: addDays(today(), -60),
    'Tranche 1': addDays(today(), -30),
    'Frais de laboratoire 4e': addDays(today(), -30),
    'Tranche 2': addDays(today(), 15),
    'Tranche 3': addDays(today(), 75),
  };
  for (const [name, date] of Object.entries(due)) {
    await prisma.feeItem.updateMany({ where: { name }, data: { dueDate: toDbDate(date) } });
  }
  s = await sessions(app);
  student = (
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    })
  ).id;
});

const pay = (body: Record<string, unknown>, session = s.compta) =>
  http()
    .post('/finance/payments')
    .set(session.auth)
    .send({ studentId: student, idempotencyKey: randomUUID(), ...body });

async function account() {
  return (await http().get(`/finance/students/${student}/account`).set(s.compta.auth).expect(200))
    .body;
}

describe('échéancier et relevé de compte', () => {
  it('présente les échéances, les retards et le solde', async () => {
    const a = await account();
    expect(
      a.lines.map((l: { label: string; status: string; overdue: boolean }) => [
        l.label,
        l.status,
        l.overdue,
      ]),
    ).toEqual([
      ['Inscription', 'UNPAID', true],
      ['Tranche 1', 'UNPAID', true],
      ['Frais de laboratoire 4e', 'UNPAID', true],
      ['Tranche 2', 'UNPAID', false],
      ['Tranche 3', 'UNPAID', false],
    ]);
    expect(a.totals).toEqual({
      due: 185000,
      paid: 0,
      outstanding: 185000,
      overdue: 105000,
      balance: 185000,
      credit: 0,
    });
    expect(a.nextDue).toMatchObject({ label: 'Inscription', amount: 25000 });
  });

  it('accorde une remise (bourse) tracée dans le ledger', async () => {
    const a = await account();
    const t3 = a.lines.find((l: { label: string }) => l.label === 'Tranche 3');
    await http()
      .post(`/finance/invoice-lines/${t3.id}/discounts`)
      .set(s.compta.auth)
      .send({ amount: 10000, reason: 'Bourse excellence' })
      .expect(201);
    await http()
      .post(`/finance/invoice-lines/${t3.id}/discounts`)
      .set(s.compta.auth)
      .send({ amount: 50000, reason: 'Trop' })
      .expect(409);
    const after = await account();
    expect(after.totals.balance).toBe(175000);
    expect(after.lines.find((l: { label: string }) => l.label === 'Tranche 3')).toMatchObject({
      due: 20000,
      discount: 10000,
    });
  });

  it('ne perd aucune remise accordée simultanément', async () => {
    const a = await account();
    const t3 = a.lines.find((l: { label: string }) => l.label === 'Tranche 3');
    const results = await Promise.all(
      [5000, 7000].map((amount) =>
        http()
          .post(`/finance/invoice-lines/${t3.id}/discounts`)
          .set(s.compta.auth)
          .send({ amount, reason: 'Bourse' }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const line = await prisma.invoiceLine.findUniqueOrThrow({ where: { id: t3.id } });
    expect(line.discount).toBe(12000);
    expect((await account()).totals.balance).toBe(173000);
  });

  it('refuse de recréer un échéancier existant', async () => {
    await http()
      .post('/finance/invoices')
      .set(s.compta.auth)
      .send({ studentId: student, academicYearId: f.yearId })
      .expect(409);
  });
});

describe('encaissement en espèces', () => {
  it('exige une caisse ouverte', async () => {
    const res = await pay({ amount: 25000, method: 'CASH' }).expect(409);
    expect(res.body.code).toBe('CASH_SESSION_REQUIRED');
  });

  it("impute sur l'échéance la plus ancienne, émet un reçu et prévient le parent", async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const res = await pay({ amount: 40000, method: 'CASH' }).expect(201);
    const year = new Date(Date.now()).getUTCFullYear();
    expect(res.body).toMatchObject({
      status: 'SUCCESS',
      amount: 40000,
      unallocated: 0,
      balance: 145000,
      receipt: { number: `R-${year}-000001` },
    });
    const a = await account();
    expect(
      a.lines.slice(0, 2).map((l: { paid: number; status: string }) => [l.paid, l.status]),
    ).toEqual([
      [25000, 'PAID'],
      [15000, 'PARTIAL'],
    ]);
    const sms = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'paymentReceived' },
    });
    expect(sms.recipient).toBe('+237677123456');
    expect(sms.body).toContain('Reste à payer : 145');

    const second = await pay({ amount: 5000, method: 'CASH' }).expect(201);
    expect(second.body.receipt.number).toBe(`R-${year}-000002`);
  });

  it('impute en priorité sur les échéances choisies au guichet', async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const a = await account();
    const t2 = a.lines.find((l: { label: string }) => l.label === 'Tranche 2');
    const res = await pay({ amount: 50000, method: 'CASH', lineIds: [t2.id] }).expect(201);
    expect(res.body.allocations).toEqual([{ lineId: t2.id, amount: 50000 }]);
  });

  it('impute l’avoir sur les échéances rouvertes par une annulation', async () => {
    const bank = (amount: number) =>
      pay({
        amount,
        method: 'BANK',
        bankName: 'Banque',
        bankReference: `VIR-${amount}-${randomUUID()}`.slice(0, 30),
      }).expect(201);
    const p1 = await bank(100000);
    const p2 = await bank(100000);
    expect(p2.body.unallocated).toBe(15000);
    // Quatre yeux pour tous les modes : l'auteur du virement ne l'annule pas lui-même.
    await http()
      .post(`/finance/payments/${p1.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Chèque impayé' })
      .expect(403);
    await http()
      .post(`/finance/payments/${p1.body.id}/reverse`)
      .set(s.direction.auth)
      .send({ reason: 'Chèque impayé' })
      .expect(201);
    const a = await account();
    expect(a.totals).toMatchObject({ outstanding: 85000, balance: 85000, credit: 0 });
  });

  it('garde le trop-perçu comme avoir', async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const res = await pay({ amount: 200000, method: 'CASH' }).expect(201);
    expect(res.body.unallocated).toBe(15000);
    const a = await account();
    expect(a.totals).toMatchObject({ outstanding: 0, balance: -15000, credit: 15000 });
  });

  it("rejoue une requête répétée (même clé d'idempotence) sans double encaissement", async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const key = randomUUID();
    const first = await pay({ amount: 25000, method: 'CASH', idempotencyKey: key }).expect(201);
    const again = await pay({ amount: 25000, method: 'CASH', idempotencyKey: key }).expect(201);
    expect(again.body).toMatchObject({ id: first.body.id, replayed: true });
    expect(await prisma.payment.count()).toBe(1);
    await pay({ amount: 30000, method: 'CASH', idempotencyKey: key }).expect(409);
  });

  it('résiste à deux encaissements simultanés sur les mêmes échéances', async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    await Promise.all([
      pay({ amount: 100000, method: 'CASH' }).expect(201),
      pay({ amount: 100000, method: 'CASH' }).expect(201),
    ]);
    const allocations = await prisma.paymentAllocation.groupBy({
      by: ['invoiceLineId'],
      _sum: { amount: true },
    });
    const lines = await prisma.invoiceLine.findMany();
    for (const a of allocations) {
      const line = lines.find((l) => l.id === a.invoiceLineId)!;
      expect(a._sum.amount).toBeLessThanOrEqual(line.amount - line.discount);
    }
    const acc = await account();
    expect(acc.totals).toMatchObject({ outstanding: 0, credit: 15000 });
  });

  it('refuse un montant décimal ou nul et un paiement sans droit', async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    await pay({ amount: 100.5, method: 'CASH' }).expect(400);
    await pay({ amount: 0, method: 'CASH' }).expect(400);
    // Au-delà des entiers 32 bits : erreur de saisie (400), pas d'erreur serveur.
    await pay({ amount: 2_147_483_648, method: 'CASH' }).expect(400);
    await pay({ amount: 1000, method: 'CASH' }, s.secretariat).expect(403);
    await pay({ amount: 1000, method: 'BANK' }).expect(400);
  });
});

describe('annulation (écriture de correction)', () => {
  it('annule un paiement sans le modifier ni le supprimer', async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const p = await pay({ amount: 25000, method: 'CASH' }).expect(201);
    await http()
      .post(`/finance/payments/${p.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'non' })
      .expect(400);
    // Le caissier ne peut pas annuler ses propres espèces : la direction s'en charge.
    await http()
      .post(`/finance/payments/${p.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Erreur de saisie du montant' })
      .expect(403);
    await http()
      .post(`/finance/payments/${p.body.id}/reverse`)
      .set(s.direction.auth)
      .send({ reason: 'Erreur de saisie du montant' })
      .expect(201);
    await http()
      .post(`/finance/payments/${p.body.id}/reverse`)
      .set(s.direction.auth)
      .send({ reason: 'Erreur de saisie du montant' })
      .expect(409);
    const a = await account();
    expect(a.totals.balance).toBe(185000);
    expect(a.lines[0].status).toBe('UNPAID');
    const entries = await prisma.ledgerEntry.findMany({
      where: { paymentId: p.body.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries.map((e) => [e.type, e.amount])).toEqual([
      ['PAYMENT', -25000],
      ['REVERSAL', 25000],
    ]);
    const verify = await http().get(`/verify/${p.body.receipt.verificationCode}`).expect(200);
    expect(verify.body).toMatchObject({ type: 'receipt', valid: false, status: 'REVERSED' });
  });

  it('protège le ledger et les paiements au niveau de la base de données', async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const p = await pay({ amount: 25000, method: 'CASH' }).expect(201);
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { paymentId: p.body.id } });
    await expect(
      prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amount: -1 } }),
    ).rejects.toThrow(/ni modifiées ni supprimées/);
    await expect(prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /ni modifiées ni supprimées/,
    );
    await expect(
      prisma.payment.update({ where: { id: p.body.id }, data: { amount: 1 } }),
    ).rejects.toThrow(/ne peuvent pas être modifiés/);
    await expect(prisma.payment.delete({ where: { id: p.body.id } })).rejects.toThrow(
      /ne peut pas être supprimé/,
    );
    await expect(
      prisma.payment.update({ where: { id: p.body.id }, data: { status: 'FAILED' } }),
    ).rejects.toThrow(/statut final/);
    await http()
      .post(`/finance/payments/${p.body.id}/reverse`)
      .set(s.direction.auth)
      .send({ reason: 'Erreur de saisie du montant' })
      .expect(201);
    await expect(
      prisma.payment.update({ where: { id: p.body.id }, data: { reversedAt: null } }),
    ).rejects.toThrow(/définitive/);
  });
});

describe('Mobile Money', () => {
  async function requestMomo(amount = 35000) {
    const res = await pay({ amount, method: 'MTN_MOMO', payerPhone: '677123456' }).expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING', receipt: null });
    return res.body as { id: string; operatorReference: string };
  }

  function webhook(body: Record<string, unknown>, secret?: string) {
    const raw = JSON.stringify(body);
    return http()
      .post('/webhooks/mobile-money')
      .set('content-type', 'application/json')
      .set('x-ecole-signature', signWebhook(raw, secret))
      .send(raw);
  }

  it('crée un paiement en attente puis le confirme par webhook signé', async () => {
    const p = await requestMomo();
    expect(SimulatorMobileMoneyProvider.requests[0]).toMatchObject({
      amount: 35000,
      phone: '+237677123456',
      method: 'MTN_MOMO',
    });
    await webhook(
      { reference: p.operatorReference, status: 'SUCCESS', amount: 35000 },
      'mauvais-secret-0123456789',
    ).expect(401);
    await http()
      .post('/webhooks/mobile-money')
      .send({ reference: p.operatorReference, status: 'SUCCESS' })
      .expect(401);
    await webhook({ reference: p.operatorReference, status: 'SUCCESS', amount: 30000 }).expect(409);
    const ok = await webhook({
      reference: p.operatorReference,
      status: 'SUCCESS',
      amount: 35000,
    }).expect(200);
    expect(ok.body).toEqual({ status: 'SUCCESS', changed: true });
    // Webhook rejoué : aucun double encaissement.
    const replay = await webhook({
      reference: p.operatorReference,
      status: 'SUCCESS',
      amount: 35000,
    }).expect(200);
    expect(replay.body.changed).toBe(false);
    const payment = await http().get(`/finance/payments/${p.id}`).set(s.compta.auth).expect(200);
    expect(payment.body).toMatchObject({
      status: 'SUCCESS',
      receipt: { number: expect.stringMatching(/^R-\d{4}-000001$/) },
    });
    expect(await prisma.ledgerEntry.count({ where: { paymentId: p.id } })).toBe(1);
    const mismatch = await prisma.auditLog.count({
      where: { action: 'finance.mobile_money_amount_mismatch' },
    });
    expect(mismatch).toBe(1);
  });

  it('enregistre un échec sans écriture et prévient le payeur', async () => {
    const p = await requestMomo();
    await webhook({ reference: p.operatorReference, status: 'FAILED' }).expect(200);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe('FAILED');
    expect(await prisma.ledgerEntry.count({ where: { paymentId: p.id } })).toBe(0);
    const sms = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'paymentFailed' },
    });
    expect(sms.recipient).toBe('+237677123456');
    // Un succès après un échec signalé par l'opérateur est contradictoire : il est signalé.
    await webhook({ reference: p.operatorReference, status: 'SUCCESS', amount: 35000 }).expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('FAILED');
    expect(
      await prisma.auditLog.count({ where: { action: 'finance.mobile_money_conflict' } }),
    ).toBe(1);
  });

  it("signale une erreur claire si l'opérateur refuse la demande", async () => {
    SimulatorMobileMoneyProvider.failNextRequest = true;
    const res = await pay({
      amount: 35000,
      method: 'ORANGE_MONEY',
      payerPhone: '699887766',
    }).expect(502);
    expect(res.body.message).toMatch(/a refusé la demande/);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe('FAILED');
  });

  it("garde en attente un paiement dont l'opérateur n'a pas répondu, puis le retrouve", async () => {
    SimulatorMobileMoneyProvider.timeoutNextRequest = true;
    const res = await pay({ amount: 35000, method: 'MTN_MOMO', payerPhone: '677123456' }).expect(
      201,
    );
    expect(res.body).toMatchObject({
      status: 'PENDING',
      unconfirmed: true,
      operatorReference: null,
    });
    // Confirmation par webhook identifiée par notre identifiant (externalId).
    await webhook({ externalId: res.body.id, status: 'SUCCESS' }).expect(400);
    await webhook({
      externalId: res.body.id,
      reference: 'MTN-778899',
      status: 'SUCCESS',
      amount: 35000,
    }).expect(200);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ status: 'SUCCESS', operatorReference: 'MTN-778899' });

    // Sans webhook : la réconciliation interroge l'opérateur avec notre identifiant.
    SimulatorMobileMoneyProvider.timeoutNextRequest = true;
    const other = await pay({ amount: 10000, method: 'MTN_MOMO', payerPhone: '677123456' }).expect(
      201,
    );
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - interval '20 minutes' WHERE "id" = ${other.body.id}`;
    SimulatorMobileMoneyProvider.statuses.set(other.body.id, 'SUCCESS');
    expect(await app.get(FinanceService).reconcilePending()).toMatchObject({ settled: 1 });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: other.body.id } })).status).toBe(
      'SUCCESS',
    );
  });

  it('encaisse une confirmation tardive après expiration et signale un succès contradictoire', async () => {
    const p = await requestMomo();
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - interval '25 hours' WHERE "id" = ${p.id}`;
    await app.get(FinanceService).reconcilePending();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      'CANCELLED',
    );
    const late = await webhook({
      reference: p.operatorReference,
      status: 'SUCCESS',
      amount: 35000,
    }).expect(200);
    expect(late.body).toEqual({ status: 'SUCCESS', changed: true });
    expect(
      await prisma.auditLog.count({ where: { action: 'finance.mobile_money_late_success' } }),
    ).toBe(1);
    expect((await account()).totals.balance).toBe(150000);
  });

  it('réconcilie les paiements en attente et expire les plus anciens', async () => {
    const finance = app.get(FinanceService);
    const a = await requestMomo(10000);
    const b = await requestMomo(20000);
    const c = await requestMomo(30000);
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - interval '20 minutes' WHERE "id" IN (${a.id}, ${b.id})`;
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - interval '25 hours' WHERE "id" = ${c.id}`;
    SimulatorMobileMoneyProvider.statuses.set(a.operatorReference, 'SUCCESS');
    SimulatorMobileMoneyProvider.statuses.set(b.operatorReference, 'FAILED');
    const result = await finance.reconcilePending();
    expect(result).toEqual({ checked: 3, settled: 2, expired: 1 });
    const statuses = await prisma.payment.findMany({
      orderBy: { amount: 'asc' },
      select: { status: true },
    });
    expect(statuses.map((x) => x.status)).toEqual(['SUCCESS', 'FAILED', 'CANCELLED']);
  });

  it("expire un paiement ancien même si l'opérateur ne répond pas", async () => {
    const finance = app.get(FinanceService);
    const p = await requestMomo();
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - interval '25 hours' WHERE "id" = ${p.id}`;
    const provider = SimulatorMobileMoneyProvider.prototype;
    const original = provider.checkStatus;
    provider.checkStatus = () => Promise.reject(new Error('Passerelle indisponible'));
    try {
      expect(await finance.reconcilePending()).toEqual({ checked: 1, settled: 0, expired: 1 });
    } finally {
      provider.checkStatus = original;
    }
  });

  it('le parent paie depuis le portail et suit le statut', async () => {
    const code = await requestOtp(app, '677123456');
    const parent = toSession(
      await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(200),
    );
    const children = await http().get('/portal/children').set(parent.auth).expect(200);
    expect(children.body).toHaveLength(1);
    expect(children.body[0]).toMatchObject({
      firstName: 'Marie-Claire',
      balance: 185000,
      overdue: 105000,
      className: '4e A',
    });
    const created = await http()
      .post('/portal/payments')
      .set(parent.auth)
      .send({
        studentId: student,
        amount: 35000,
        method: 'ORANGE_MONEY',
        payerPhone: '677123456',
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    expect(created.body.status).toBe('PENDING');
    await http().post(`/dev/mobile-money/${created.body.operatorReference}/SUCCESS`).expect(200);
    const status = await http()
      .get(`/portal/payments/${created.body.id}`)
      .set(parent.auth)
      .expect(200);
    expect(status.body).toMatchObject({ status: 'SUCCESS', balance: 150000 });
    const receipt = await http()
      .get(`/portal/payments/${created.body.id}/receipt.pdf`)
      .set(parent.auth)
      .expect(200);
    expect(receipt.body.subarray(0, 4).toString()).toBe('%PDF');
    // L'autre tuteur voit le paiement dans la fiche de l'enfant, mais ni le numéro Mobile Money
    // du payeur ni la référence de l'opérateur, comme pour le détail du paiement.
    const schoolId = (await prisma.student.findUniqueOrThrow({ where: { id: student } })).schoolId;
    const mother = await prisma.guardian.create({
      data: { schoolId, firstName: 'Mère', lastName: 'Ngono', phone: '+237699887766' },
    });
    await prisma.studentGuardian.create({
      data: { schoolId, studentId: student, guardianId: mother.id, relationship: 'MOTHER' },
    });
    const otherCode = await requestOtp(app, '699887766');
    const otherParent = toSession(
      await http()
        .post('/auth/otp/verify')
        .send({ phone: '699887766', code: otherCode })
        .expect(200),
    );
    await http().get(`/portal/payments/${created.body.id}`).set(otherParent.auth).expect(403);
    const overview = await http()
      .get(`/portal/children/${student}`)
      .set(otherParent.auth)
      .expect(200);
    const seen = overview.body.finance.payments.find(
      (x: { id: string }) => x.id === created.body.id,
    );
    expect(seen).toMatchObject({ amount: 35000, status: 'SUCCESS' });
    expect(JSON.stringify(overview.body)).not.toContain('677123456');
    expect(seen.operatorReference).toBeUndefined();
    // Le portail n'accepte pas les espèces, ni un enfant qui n'est pas le sien.
    await http()
      .post('/portal/payments')
      .set(parent.auth)
      .send({
        studentId: student,
        amount: 100,
        method: 'CASH',
        payerPhone: '677123456',
        idempotencyKey: randomUUID(),
      })
      .expect(400);
    const other = await enrollStudent(app, s.secretariat, {
      firstName: 'Junior',
      lastName: 'Tchoupo',
      classId: f.class4BId,
    });
    await http()
      .post('/portal/payments')
      .set(parent.auth)
      .send({
        studentId: other.id,
        amount: 100,
        method: 'MTN_MOMO',
        payerPhone: '677123456',
        idempotencyKey: randomUUID(),
      })
      .expect(404);
  });
});

describe('caisse journalière', () => {
  it('calcule l’attendu, l’écart, et exige une validation par une autre personne', async () => {
    const session = await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    await pay({ amount: 25000, method: 'CASH' }).expect(201);
    const p2 = await pay({ amount: 15000, method: 'CASH' }).expect(201);
    await pay({
      amount: 50000,
      method: 'BANK',
      bankReference: 'BRD-001',
      bankName: 'Banque',
    }).expect(201);
    await http()
      .post(`/finance/payments/${p2.body.id}/reverse`)
      .set(s.direction.auth)
      .send({ reason: 'Billet refusé par le parent' })
      .expect(201);
    const current = await http()
      .get('/finance/cash-sessions/current')
      .set(s.compta.auth)
      .expect(200);
    expect(current.body).toMatchObject({ operations: 1, expected: 25000, reversed: 1 });
    // Un écart exige un motif.
    const noReason = await http()
      .post(`/finance/cash-sessions/${session.body.id}/close`)
      .set(s.compta.auth)
      .send({ countedAmount: 24000 })
      .expect(400);
    expect(noReason.body.message).toMatch(/Manquant de 1.000.FCFA : indiquez le motif/);
    const closed = await http()
      .post(`/finance/cash-sessions/${session.body.id}/close`)
      .set(s.compta.auth)
      .send({ countedAmount: 24000, note: 'Billet de 1 000 introuvable' })
      .expect(201);
    expect(closed.body).toMatchObject({
      status: 'CLOSED',
      expectedAmount: 25000,
      countedAmount: 24000,
      difference: -1000,
      note: 'Billet de 1 000 introuvable',
    });
    await pay({ amount: 1000, method: 'CASH' }).expect(409);

    // Liste des clôtures : la direction peut approuver, pas le caissier.
    const forDirection = await http()
      .get('/finance/cash-sessions?status=CLOSED')
      .set(s.direction.auth)
      .expect(200);
    expect(forDirection.body).toEqual([
      expect.objectContaining({
        id: session.body.id,
        expectedAmount: 25000,
        countedAmount: 24000,
        difference: -1000,
        note: 'Billet de 1 000 introuvable',
        openedBy: expect.objectContaining({ firstName: expect.any(String) }),
        canApprove: true,
      }),
    ]);
    const forCashier = await http()
      .get('/finance/cash-sessions?status=CLOSED')
      .set(s.compta.auth)
      .expect(200);
    expect(forCashier.body[0].canApprove).toBe(false);
    await http().get('/finance/cash-sessions').set(s.prof.auth).expect(403);

    await http()
      .post(`/finance/cash-sessions/${session.body.id}/approve`)
      .set(s.compta.auth)
      .expect(403);
    const approved = await http()
      .post(`/finance/cash-sessions/${session.body.id}/approve`)
      .set(s.direction.auth)
      .expect(201);
    // Comptabilité non activée : aucune écriture, mais l'approbation est journalisée.
    expect(approved.body).toMatchObject({ status: 'APPROVED', difference: -1000, entry: null });
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/approve`)
      .set(s.direction.auth)
      .expect(409);
    const audit = await prisma.auditLog.findMany({
      where: {
        entityId: session.body.id,
        action: { in: ['finance.cash_closed', 'finance.cash_approved'] },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['finance.cash_closed', 'finance.cash_approved']);
    expect(audit[0]?.reason).toBe('Billet de 1 000 introuvable');
  });

  it('n’ouvre qu’une caisse à la fois et fait valider la caisse de la direction par un tiers', async () => {
    const opened = await Promise.all(
      [1, 2, 3].map(() => http().post('/finance/cash-sessions/open').set(s.direction.auth)),
    );
    expect(new Set(opened.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.cashSession.count({ where: { status: 'OPEN' } })).toBe(1);
    await http()
      .post(`/finance/cash-sessions/${opened[0]!.body.id}/close`)
      .set(s.direction.auth)
      .send({ countedAmount: 0 })
      .expect(201);
    // La direction ne valide pas sa propre caisse.
    await http()
      .post(`/finance/cash-sessions/${opened[0]!.body.id}/approve`)
      .set(s.direction.auth)
      .expect(403);
  });
});

describe('pilotage', () => {
  it('calcule recouvrement, impayés par classe et encaissements hebdomadaires', async () => {
    const other = await enrollStudent(app, s.secretariat, {
      firstName: 'Junior',
      lastName: 'Tchoupo',
      classId: f.class4BId,
    });
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    await pay({ amount: 105000, method: 'CASH' }).expect(201);
    const summary = await http().get('/finance/summary').set(s.compta.auth).expect(200);
    expect(summary.body).toMatchObject({
      expected: 370000,
      collected: 105000,
      recoveryRate: 28,
      overdue: 105000,
      overdueStudents: 1,
    });
    expect(
      summary.body.items.find((i: { name: string }) => i.name === 'Inscription'),
    ).toMatchObject({ due: 50000, paid: 25000, rate: 50 });
    const unpaid = await http().get('/finance/unpaid').set(s.compta.auth).expect(200);
    expect(unpaid.body.students).toHaveLength(1);
    expect(unpaid.body.students[0]).toMatchObject({
      student: { id: other.id },
      overdue: 105000,
      class: { name: '4e B' },
    });
    expect(unpaid.body.classes[0]).toMatchObject({ className: '4e B', students: 1, rate: 0 });
    const dash = await http().get('/dashboard').set(s.direction.auth).expect(200);
    expect(dash.body.finance.weekly.at(-1).amount).toBe(105000);
    expect(dash.body.enrollment).toMatchObject({ total: 2, girls: 2 });
    const csv = await http()
      .get(`/finance/payments/export.csv?from=${addDays(today(), -1)}&to=${addDays(today(), 1)}`)
      .set(s.compta.auth)
      .expect(200);
    expect(csv.text).toContain('date;recu;matricule;eleve;moyen;montant;annule;reference;banque');
    expect(csv.text).toContain(';105000;non;');
  });

  it('exporte comme à l’écran : moyen filtré, heure de Douala, n° de bordereau', async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    await pay({ amount: 25000, method: 'CASH' }).expect(201);
    const bank = await pay({
      amount: 50000,
      method: 'BANK',
      bankReference: 'BRD-778812',
      bankName: 'Afriland First Bank',
    }).expect(201);
    // 31/10 à 0 h 30 heure de Douala (23 h 30 UTC la veille) : compté le 31.
    await prisma.payment.update({
      where: { id: bank.body.id },
      data: {
        createdAt: new Date('2026-10-30T23:30:00Z'),
        confirmedAt: new Date('2026-10-30T23:30:00Z'),
      },
    });
    const day = await http()
      .get('/finance/payments/export.csv?from=2026-10-31&to=2026-10-31&method=BANK')
      .set(s.compta.auth)
      .expect(200);
    const rows = day.text.trim().split('\n').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^2026-10-31 00:30;R-\d{4}-\d{6};/);
    expect(rows[0]).toMatch(/;Banque;50000;non;BRD-778812;Afriland First Bank$/);
    const cash = await http()
      .get(`/finance/payments/export.csv?from=${today()}&to=${today()}&method=CASH`)
      .set(s.compta.auth)
      .expect(200);
    const cashRows = cash.text.trim().split('\n').slice(1);
    expect(cashRows.length).toBeGreaterThan(0);
    expect(cashRows.every((r) => r.includes(';Espèces;'))).toBe(true);
    expect(cash.text).not.toContain('BRD-778812');
    await http()
      .get('/finance/payments/export.csv?from=2026-10-31&to=2026-10-31&method=CHEQUE')
      .set(s.compta.auth)
      .expect(400);
  });

  it('exporte tous les paiements de la période, même au-delà de 500', async () => {
    // Rentrée chargée : 520 virements enregistrés hier (insertion directe, sans imputation).
    const schoolId = (await prisma.student.findUniqueOrThrow({ where: { id: student } })).schoolId;
    const yesterday = new Date(`${addDays(today(), -1)}T10:00:00Z`);
    await prisma.payment.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({
        schoolId,
        studentId: student,
        amount: 1000 + i,
        method: 'BANK' as const,
        status: 'SUCCESS' as const,
        idempotencyKey: `export-${i}`,
        bankReference: `VIR-${i}`,
        createdAt: yesterday,
        confirmedAt: yesterday,
      })),
    });
    const csv = await http()
      .get(`/finance/payments/export.csv?from=${addDays(today(), -1)}&to=${today()}`)
      .set(s.compta.auth)
      .expect(200);
    const rows = csv.text.trim().split('\n');
    expect(rows).toHaveLength(521);
    expect(csv.text).toContain(';1000;non;');
  });

  it('envoie les relances J+n une seule fois par échéance et par palier', async () => {
    const finance = app.get(FinanceService);
    const first = await finance.sendReminders();
    // Inscription échue depuis 60 j (palier J+30) ; Tranche 1 et frais de labo depuis 30 j (palier J+30).
    expect(first.sent).toBe(3);
    const again = await finance.sendReminders();
    expect(again.sent).toBe(0);
    const reminders = await prisma.notificationOutbox.findMany({
      where: { template: 'feeReminder' },
    });
    expect(reminders.every((r) => r.recipient === '+237677123456')).toBe(true);
    expect(reminders.map((r) => r.body).join('\n')).toContain('Tranche 1 de Marie-Claire Ngono');
  });

  it('produit un reçu PDF vérifiable', async () => {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const p = await pay({ amount: 25000, method: 'CASH' }).expect(201);
    const pdf = await http()
      .get(`/finance/payments/${p.body.id}/receipt.pdf`)
      .set(s.compta.auth)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const verify = await http().get(`/verify/${p.body.receipt.verificationCode}`).expect(200);
    expect(verify.body).toMatchObject({
      type: 'receipt',
      valid: true,
      student: 'NGONO Marie-Claire',
    });
  });
});

describe('envoi des notifications', () => {
  it('envoie, réessaie avec délai croissant et abandonne après cinq échecs', async () => {
    const notifications = app.get(NotificationsService);
    const n = await notifications.enqueue({
      recipient: '+237677000000',
      template: 'test',
      body: 'Bonjour',
    });
    MemorySmsProvider.failNext = 1;
    expect(await notifications.dispatchPending()).toBeGreaterThanOrEqual(1);
    let row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: n.id } });
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'Échec simulé du fournisseur SMS',
    });
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());

    await prisma.notificationOutbox.update({
      where: { id: n.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await notifications.dispatchPending();
    row = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe('SENT');
    expect(MemorySmsProvider.lastTo('+237677000000')).toBe('Bonjour');

    const failing = await notifications.enqueue({
      recipient: '+237677000001',
      template: 'test',
      body: 'Échec',
    });
    MemorySmsProvider.failNext = 10;
    for (let i = 0; i < 5; i++) {
      await prisma.notificationOutbox.update({
        where: { id: failing.id },
        data: { availableAt: new Date(Date.now() - 1000) },
      });
      await notifications.dispatchPending();
    }
    const dead = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: failing.id } });
    expect(dead).toMatchObject({ status: 'FAILED', attempts: 5 });
  });
});
