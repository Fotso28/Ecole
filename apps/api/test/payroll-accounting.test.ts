import type { INestApplication } from '@nestjs/common';
import { findNumberGaps } from '@ecole/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAsSystem } from '../src/common/context';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb, type Session } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());

const MONTH = '2026-10';
const today = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
const lastYear = String(new Date().getUTCFullYear() - 1);

async function enable(schoolId: string, modules: string[]) {
  const school = await prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
  await prisma.school.update({
    where: { id: schoolId },
    data: { modules: [...new Set([...school.modules, ...modules])] },
  });
}

/** Dossier et CDI d'un enseignant, par la comptabilité. */
async function employee(
  session: Session,
  userId: string,
  baseSalary = 200_000,
  start = '2026-09-01',
) {
  const file = await http()
    .post('/hr/employees')
    .set(session.auth)
    .send({ userId, position: 'Enseignant', hireDate: start, payoutMethod: 'BANK' })
    .expect(201);
  await http()
    .post(`/hr/employees/${file.body.id}/contracts`)
    .set(session.auth)
    .send({ type: 'CDI', startDate: start, baseSalary })
    .expect(201);
  return file.body.id as string;
}

/** Paie calculée et soumise par la comptabilité, validée par la direction. */
async function validatedPayroll(month = MONTH, ss = s) {
  await http().post(`/hr/payroll/${month}/compute`).set(ss.compta.auth).expect(201);
  await http().post(`/hr/payroll/${month}/submit`).set(ss.compta.auth).expect(201);
  return (await http().post(`/hr/payroll/${month}/validate`).set(ss.direction.auth).expect(201))
    .body;
}

const lines = async (sourceType: string, sourceId?: string) => {
  const entry = await prisma.accountingEntry.findFirstOrThrow({
    where: { schoolId: f.schoolId, sourceType, sourceId },
    include: { lines: true },
  });
  const by = new Map<string, number>();
  for (const l of entry.lines)
    by.set(l.accountNumber, (by.get(l.accountNumber) ?? 0) + l.debit - l.credit);
  return { entry, by };
};

async function expectIntegrity(schoolId: string) {
  const entries = await prisma.accountingEntry.findMany({
    where: { schoolId },
    include: { lines: true },
  });
  const groups = new Map<string, number[]>();
  for (const e of entries) {
    const debit = e.lines.reduce((n, l) => n + l.debit, 0);
    expect(debit).toBe(e.lines.reduce((n, l) => n + l.credit, 0));
    expect(debit).toBe(e.total);
    const key = `${e.fiscalYearId}:${e.journalCode}`;
    groups.set(key, [...(groups.get(key) ?? []), e.number]);
  }
  for (const numbers of groups.values()) expect(findNumberGaps(numbers)).toEqual([]);
  // Une opération n'est jamais passée deux fois.
  const keys = entries.filter((e) => e.sourceType).map((e) => `${e.sourceType}:${e.sourceId}`);
  expect(new Set(keys).size).toBe(keys.length);
  return entries;
}

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  f = await seedSchool();
  await enable(f.schoolId, ['hr']);
  s = await sessions(app);
});

describe('écritures de paie', () => {
  it('à la validation : charges, organismes et net dû, équilibrés ; puis versement par la comptabilité', async () => {
    await enable(f.schoolId, ['accounting']);
    await employee(s.compta, f.users.teacher);
    await employee(s.compta, f.users.teacher2, 157_333);
    const run = await validatedPayroll();
    const summary = (
      await http().get(`/hr/payroll/${MONTH}/summary`).set(s.compta.auth).expect(200)
    ).body;

    const { entry, by } = await lines('PAYROLL', run.id);
    expect(entry.journalCode).toBe('OD');
    expect(entry.date.toISOString().slice(0, 10)).toBe('2026-10-31');
    expect(entry.label).toBe('Paie de octobre 2026 (2 bulletins)');
    expect(entry.total).toBe(summary.employerCost);
    expect((by.get('661') ?? 0) + (by.get('663') ?? 0)).toBe(summary.gross);
    expect(by.get('664')).toBe(summary.employer.total);
    expect(by.get('431')).toBe(
      -(
        summary.employee.cnps +
        summary.employer.pension +
        summary.employer.family +
        summary.employer.accident
      ),
    );
    expect(by.get('4471')).toBe(-summary.employee.irpp);
    expect(by.get('4473')).toBe(-(summary.employee.housing + summary.employer.housing));
    expect(by.get('4476')).toBe(-summary.employer.employment);
    expect(by.get('422')).toBe(-summary.net);

    // Versement : réservé à la comptabilité (et à la direction), pas au secrétariat.
    const body = { date: today(), method: 'BANK', reference: 'VIR-OCT-2026' };
    await http().post(`/hr/payroll/${MONTH}/pay`).set(s.secretariat.auth).send(body).expect(403);
    // La direction a validé : une autre personne habilitée (la comptabilité) doit verser.
    const refused = await http()
      .post(`/hr/payroll/${MONTH}/pay`)
      .set(s.direction.auth)
      .send(body)
      .expect(403);
    expect(refused.body.message).toMatch(/autre personne que celle qui a validé/);
    await http()
      .post(`/hr/payroll/${MONTH}/pay`)
      .set(s.compta.auth)
      .send({ ...body, method: 'CHEQUE' })
      .expect(400);
    const paid = await http()
      .post(`/hr/payroll/${MONTH}/pay`)
      .set(s.compta.auth)
      .send(body)
      .expect(201);
    expect(paid.body.payout).toMatchObject({
      method: 'BANK',
      reference: 'VIR-OCT-2026',
      amount: summary.net,
      sameAsValidator: false,
    });
    expect(paid.body.payout.entry).toMatch(/^BQ-\d{4}-000001$/);
    const payment = await lines('PAYROLL_PAYMENT', paid.body.payout.id);
    expect([...payment.by.entries()]).toEqual([
      ['422', summary.net],
      ['521', -summary.net],
    ]);
    const again = await http()
      .post(`/hr/payroll/${MONTH}/pay`)
      .set(s.compta.auth)
      .send(body)
      .expect(409);
    expect(again.body.message).toMatch(/déjà marquée comme versée/);
    expect(await prisma.auditLog.count({ where: { action: 'hr.payroll_paid' } })).toBe(1);
    await expect(
      prisma.staffPayout.update({ where: { id: paid.body.payout.id }, data: { amount: 1 } }),
    ).rejects.toThrow(/ni modifiés ni supprimés/);

    // États : 422 soldé, charges de personnel au compte de résultat, balance équilibrée.
    const period = 'from=2026-01-01&to=2026-12-31';
    const balance = (
      await http().get(`/accounting/reports/balance?${period}`).set(s.compta.auth).expect(200)
    ).body.balance;
    expect(balance.totals.debit).toBe(balance.totals.credit);
    const row = (n: string) =>
      balance.rows.find((r: { accountNumber: string }) => r.accountNumber === n);
    expect(row('422')).toMatchObject({ balanceDebit: 0, balanceCredit: 0 });
    expect(row('521').balanceCredit).toBe(summary.net);
    const is = (
      await http().get(`/accounting/reports/compte-de-resultat?${period}`).set(s.compta.auth)
    ).body.statement;
    expect(is.charges.find((g: { code: string }) => g.code === '66').amount).toBe(
      summary.employerCost,
    );
    const gl = (
      await http().get(`/accounting/reports/grand-livre?${period}&account=431`).set(s.compta.auth)
    ).body;
    expect(gl.accounts[0].closing).toBe(by.get('431'));
    await expectIntegrity(f.schoolId);

    // Une paie validée est figée : son écriture ne se contre-passe pas.
    await http()
      .post(`/accounting/entries/${entry.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Essai de correction' })
      .expect(409);
  });

  it('rattrape l’historique une seule fois, même avec des synchronisations simultanées', async () => {
    await employee(s.compta, f.users.teacher);
    const run = await validatedPayroll();
    // Versement enregistré avant l'activation de la comptabilité : aucune écriture.
    await http()
      .post(`/hr/payroll/${MONTH}/pay`)
      .set(s.compta.auth)
      .send({ date: today(), method: 'CASH' })
      .expect(201);
    expect(await prisma.accountingEntry.count()).toBe(0);

    await enable(f.schoolId, ['accounting']);
    const overview = await http().get('/accounting/overview').set(s.compta.auth).expect(200);
    expect(overview.body.pendingOperations).toBe(2);
    const service = app.get(AccountingService);
    const results = await Promise.all([
      runAsSystem('test', () => service.syncOperations(), f.schoolId),
      runAsSystem('test', () => service.syncOperations(), f.schoolId),
      runAsSystem('test', () => service.syncAll(), f.schoolId),
    ]);
    expect(results.reduce((n, r) => n + r.failed, 0)).toBe(0);
    await http().post('/accounting/sync').set(s.compta.auth).expect(201);
    const entries = await expectIntegrity(f.schoolId);
    expect(entries.filter((e) => e.sourceType === 'PAYROLL')).toHaveLength(1);
    expect(entries.filter((e) => e.sourceType === 'PAYROLL_PAYMENT')).toHaveLength(1);
    expect((await lines('PAYROLL', run.id)).entry).toBeTruthy();
    const pay = entries.find((e) => e.sourceType === 'PAYROLL_PAYMENT');
    expect(pay?.journalCode).toBe('CA');
    expect(
      (await http().get('/accounting/overview').set(s.compta.auth)).body.pendingOperations,
    ).toBe(0);
  });

  it('petite école : la personne qui a validé verse si personne d’autre n’en a le droit', async () => {
    await enable(f.schoolId, ['accounting']);
    await employee(s.compta, f.users.teacher);
    await validatedPayroll();
    // La comptabilité quitte l'école : la direction reste seule habilitée à verser.
    await prisma.membership.updateMany({
      where: { schoolId: f.schoolId, userId: f.users.accountant },
      data: { active: false },
    });
    const paid = await http()
      .post(`/hr/payroll/${MONTH}/pay`)
      .set(s.direction.auth)
      .send({ date: today(), method: 'MTN_MOMO', reference: 'MOMO-1' })
      .expect(201);
    expect(paid.body.payout.sameAsValidator).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'hr.payroll_paid' } });
    expect(audit.after).toMatchObject({ sameAsValidator: true, method: 'MTN_MOMO' });
    expect((await lines('PAYROLL_PAYMENT')).entry.journalCode).toBe('MM');
  });

  it('respecte l’exercice clos : versement refusé, paie tardive reportée sur l’exercice ouvert', async () => {
    await enable(f.schoolId, ['accounting']);
    await employee(s.compta, f.users.teacher, 200_000, `${lastYear}-12-01`);
    const year = await http()
      .post('/accounting/fiscal-years')
      .set(s.compta.auth)
      .send({ startDate: `${lastYear}-01-01`, endDate: `${lastYear}-12-31` })
      .expect(201);
    await http()
      .post(`/accounting/fiscal-years/${year.body.id}/close`)
      .set(s.direction.auth)
      .expect(201);

    const month = `${lastYear}-12`;
    const run = await validatedPayroll(month);
    const { entry } = await lines('PAYROLL', run.id);
    expect(entry.fiscalYearId).not.toBe(year.body.id);
    expect(entry.date.toISOString().slice(0, 10)).toBe(`${Number(lastYear) + 1}-01-01`);
    expect(entry.label).toMatch(/exercice clos/);

    const refused = await http()
      .post(`/hr/payroll/${month}/pay`)
      .set(s.compta.auth)
      .send({ date: `${lastYear}-12-31`, method: 'BANK' })
      .expect(409);
    expect(refused.body.message).toMatch(/Exercice clôturé/);
    expect(await prisma.staffPayout.count()).toBe(0);
    await http()
      .post(`/hr/payroll/${month}/pay`)
      .set(s.compta.auth)
      .send({ date: today(), method: 'BANK' })
      .expect(201);
    await expectIntegrity(f.schoolId);
  });
});

describe('avances sur salaire', () => {
  it('versement 421 / trésorerie, puis remboursement par retenue sur la paie', async () => {
    await enable(f.schoolId, ['accounting']);
    const file = await employee(s.compta, f.users.teacher);
    const adv = await http()
      .post('/hr/advances')
      .set(s.compta.auth)
      .send({
        employeeId: file,
        amount: 60_000,
        installments: 2,
        firstMonth: MONTH,
        reason: 'Frais médicaux',
      })
      .expect(201);
    const body = { date: today(), method: 'CASH', reference: 'BC-12' };
    // Une avance seulement demandée ne se verse pas.
    await http().post(`/hr/advances/${adv.body.id}/pay`).set(s.compta.auth).send(body).expect(409);
    await http()
      .post(`/hr/advances/${adv.body.id}/approve`)
      .set(s.direction.auth)
      .send({})
      .expect(201);
    await http().post(`/hr/advances/${adv.body.id}/pay`).set(s.prof.auth).send(body).expect(403);
    await http()
      .post(`/hr/advances/${adv.body.id}/pay`)
      .set(s.direction.auth)
      .send(body)
      .expect(403);
    const paid = await http()
      .post(`/hr/advances/${adv.body.id}/pay`)
      .set(s.compta.auth)
      .send(body)
      .expect(201);
    expect(paid.body.payout).toMatchObject({ amount: 60_000, method: 'CASH' });
    await http().post(`/hr/advances/${adv.body.id}/pay`).set(s.compta.auth).send(body).expect(409);
    const payout = await lines('ADVANCE_PAYMENT');
    expect(payout.entry.journalCode).toBe('CA');
    expect([...payout.by.entries()]).toEqual([
      ['421', 60_000],
      ['571', -60_000],
    ]);
    expect(await prisma.auditLog.count({ where: { action: 'hr.advance_paid' } })).toBe(1);

    // Deux paies retiennent 30 000 chacune : le compte 421 est soldé.
    for (const month of [MONTH, '2026-11']) {
      const run = await validatedPayroll(month);
      expect((await lines('PAYROLL', run.id)).by.get('421')).toBe(-30_000);
    }
    const balance = (
      await http()
        .get('/accounting/reports/balance?from=2026-01-01&to=2026-12-31')
        .set(s.compta.auth)
        .expect(200)
    ).body.balance;
    expect(
      balance.rows.find((r: { accountNumber: string }) => r.accountNumber === '421'),
    ).toMatchObject({ debit: 60_000, credit: 60_000, balanceDebit: 0, balanceCredit: 0 });
    await expectIntegrity(f.schoolId);
  });
});

describe('achats de stock', () => {
  it('achat fournisseur en 60x / 4011, correction contre-passée, ventes non comptées deux fois', async () => {
    await enable(f.schoolId, ['accounting', 'library']);
    const student = await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: f.class4AId,
    });
    const item = async (name: string, category: string) =>
      (
        await http()
          .post('/stock/items')
          .set(s.compta.auth)
          .send({ name, category, sizes: [], unitPrice: 4500, alertThreshold: 0 })
          .expect(201)
      ).body.id as string;
    const shirt = await item('Chemise uniforme', 'UNIFORM');
    const book = await item('Cahier 200 pages', 'SUPPLY');
    const buy = (itemId: string, quantity: number, unitCost: number) =>
      http()
        .post('/stock/purchases')
        .set(s.compta.auth)
        .send({ itemId, quantity, unitCost, supplier: 'Tissus Mfoundi', reference: 'BL-7' })
        .expect(201);
    const p1 = await buy(shirt, 10, 3000);
    const p2 = await buy(shirt, 4, 3000);
    await buy(book, 50, 550);
    await buy(book, 5, 0); // don : aucun montant, aucune écriture
    await http()
      .post('/stock/sales')
      .set(s.compta.auth)
      .send({ itemId: shirt, quantity: 2, studentId: student.id, requestId: randomUUID() })
      .expect(201);
    const fix = await http()
      .post(`/stock/movements/${p2.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Livraison refusée' })
      .expect(201);

    await http().post('/accounting/sync').set(s.compta.auth).expect(201);
    await http().post('/accounting/sync').set(s.compta.auth).expect(201);
    const entries = await expectIntegrity(f.schoolId);
    const stock = entries.filter((e) => e.sourceType === 'STOCK_PURCHASE');
    expect(stock).toHaveLength(4);
    const shirtBuy = await lines('STOCK_PURCHASE', p1.body.id);
    expect(shirtBuy.entry.journalCode).toBe('AC');
    expect(shirtBuy.entry.pieceRef).toBe('BL-7');
    expect([...shirtBuy.by.entries()]).toEqual([
      ['601', 30_000],
      ['4011', -30_000],
    ]);
    expect((await lines('STOCK_PURCHASE', fix.body.id)).by.get('601')).toBe(-12_000);
    const books = stock.find((e) => e.label.includes('Cahier'));
    expect(books?.lines.find((l) => l.accountNumber === '604')?.debit).toBe(27_500);

    // La vente n'est comptée qu'une fois : par la facture de scolarité (4111 / 7061).
    const sale = await prisma.stockMovement.findFirstOrThrow({ where: { type: 'SALE' } });
    expect(entries.some((e) => e.sourceId === sale.id)).toBe(false);
    const line = await prisma.invoiceLine.findUniqueOrThrow({
      where: { id: sale.invoiceLineId ?? '' },
    });
    const charge = await prisma.ledgerEntry.findFirstOrThrow({
      where: { invoiceLineId: line.id, type: 'CHARGE' },
    });
    expect(
      entries.filter((e) => e.sourceType === 'LEDGER' && e.sourceId === charge.id),
    ).toHaveLength(1);
    expect(
      entries.filter((e) => e.sourceType === 'LEDGER' && e.label.startsWith('Chemise uniforme')),
    ).toHaveLength(1);
    const accountTotals = await prisma.accountingLine.aggregate({
      where: { schoolId: f.schoolId, accountNumber: { in: ['601', '604'] } },
      _sum: { debit: true, credit: true },
    });
    expect((accountTotals._sum.debit ?? 0) - (accountTotals._sum.credit ?? 0)).toBe(57_500);
  });
});

describe('isolation entre écoles', () => {
  it('une école ne verse ni ne comptabilise la paie, les avances ou les achats d’une autre', async () => {
    await enable(f.schoolId, ['accounting']);
    const other = await seedSchool('autre', 'AU');
    await enable(other.schoolId, ['hr', 'accounting']);
    const so = await sessions(app, 'autre');
    const file = await employee(s.compta, f.users.teacher);
    await validatedPayroll();
    const adv = await http()
      .post('/hr/advances')
      .set(s.compta.auth)
      .send({
        employeeId: file,
        amount: 10_000,
        installments: 1,
        firstMonth: '2026-12',
        reason: 'Test',
      })
      .expect(201);
    await http()
      .post(`/hr/advances/${adv.body.id}/approve`)
      .set(s.direction.auth)
      .send({})
      .expect(201);

    const body = { date: today(), method: 'BANK' };
    await http().post(`/hr/payroll/${MONTH}/pay`).set(so.compta.auth).send(body).expect(404);
    await http().post(`/hr/advances/${adv.body.id}/pay`).set(so.compta.auth).send(body).expect(404);
    expect(await prisma.staffPayout.count()).toBe(0);

    const r = await http().post('/accounting/sync').set(so.compta.auth).expect(201);
    expect(r.body.posted).toBe(0);
    expect(await prisma.accountingEntry.count({ where: { schoolId: other.schoolId } })).toBe(0);
    const entryA = await prisma.accountingEntry.findFirstOrThrow({
      where: { schoolId: f.schoolId, sourceType: 'PAYROLL' },
    });
    await http().get(`/accounting/entries/${entryA.id}`).set(so.compta.auth).expect(404);
    expect((await http().get('/hr/advances').set(so.compta.auth).expect(200)).body).toEqual([]);
    expect(
      (await http().get('/accounting/overview').set(so.compta.auth)).body.pendingOperations,
    ).toBe(0);

    // L'école A verse normalement ; ses écritures restent les siennes.
    await http().post(`/hr/payroll/${MONTH}/pay`).set(s.compta.auth).send(body).expect(201);
    const payout = await prisma.staffPayout.findFirstOrThrow();
    expect(payout.schoolId).toBe(f.schoolId);
    expect(await prisma.accountingEntry.count({ where: { schoolId: other.schoolId } })).toBe(0);
  });
});
