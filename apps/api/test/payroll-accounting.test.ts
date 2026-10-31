import type { INestApplication } from '@nestjs/common';
import { findNumberGaps } from '@ecole/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAsSystem } from '../src/common/context';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { toDbDate } from '../src/common/dates';
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
    expect(entry.label).toBe('Paie d’octobre 2026 (2 bulletins)');
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

describe('coordonnées de paiement', () => {
  it('figées dans la paie validée ; un changement n’a d’effet qu’après l’accord d’une autre personne', async () => {
    await enable(f.schoolId, ['accounting']);
    const file = (
      await http()
        .post('/hr/employees')
        .set(s.compta.auth)
        .send({
          userId: f.users.teacher,
          position: 'Enseignant',
          hireDate: '2026-09-01',
          payoutMethod: 'MOBILE_MONEY',
          sensitive: { mobileMoneyNumber: '677123456', mobileMoneyOperator: 'MTN' },
        })
        .expect(201)
    ).body.id as string;
    await http()
      .post(`/hr/employees/${file}/contracts`)
      .set(s.compta.auth)
      .send({ type: 'CDI', startDate: '2026-09-01', baseSalary: 200_000 })
      .expect(201);
    await validatedPayroll();
    const transfers = async () =>
      (await http().get(`/hr/payroll/${MONTH}/transfers?format=csv`).set(s.compta.auth).expect(200))
        .text;
    const plain = async () =>
      (
        await http()
          .post(`/hr/employees/${file}/sensitive`)
          .set(s.direction.auth)
          .send({ reason: 'Contrôle des coordonnées' })
          .expect(201)
      ).body;

    // La comptabilité change le numéro Mobile Money après la validation : simple demande.
    const asked = await http()
      .patch(`/hr/employees/${file}`)
      .set(s.compta.auth)
      .send({ sensitive: { mobileMoneyNumber: '699000111' } })
      .expect(200);
    expect(asked.body.pendingPayoutChange).toMatchObject({
      before: { method: 'MOBILE_MONEY', mobileMoneyNumber: '•••• 3456' },
      after: { method: 'MOBILE_MONEY', mobileMoneyNumber: '•••• 0111' },
    });
    expect((await plain()).mobileMoneyNumber).toBe('677123456');
    expect(await transfers()).toContain('677123456');
    expect(await transfers()).not.toContain('699000111');
    await http()
      .patch(`/hr/employees/${file}`)
      .set(s.compta.auth)
      .send({ payoutMethod: 'CASH' })
      .expect(409);
    // Ni la personne qui a demandé ni la personne concernée n'approuvent.
    await http().post(`/hr/employees/${file}/payout-change/approve`).set(s.compta.auth).expect(403);
    await http().post(`/hr/employees/${file}/payout-change/approve`).set(s.prof.auth).expect(403);
    await http()
      .post(`/hr/employees/${file}/payout-change/approve`)
      .set(s.direction.auth)
      .expect(201);
    expect((await plain()).mobileMoneyNumber).toBe('699000111');
    // La paie validée garde le numéro figé à la validation, y compris pour le versement.
    expect(await transfers()).toContain('677123456');
    expect(await transfers()).not.toContain('699000111');
    await http()
      .post(`/hr/payroll/${MONTH}/pay`)
      .set(s.compta.auth)
      .send({ date: today(), method: 'MTN_MOMO' })
      .expect(201);
    const paid = await prisma.auditLog.findFirstOrThrow({ where: { action: 'hr.payroll_paid' } });
    expect(paid.after).toMatchObject({
      transfersFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.keys((paid.after as { byMethod: object }).byMethod)).toEqual(['MOBILE_MONEY']);
    // La paie suivante prend le nouveau numéro approuvé.
    await validatedPayroll('2026-11');
    const nov = (
      await http().get('/hr/payroll/2026-11/transfers?format=csv').set(s.compta.auth).expect(200)
    ).text;
    expect(nov).toContain('699000111');

    // Refus : rien ne change.
    await http()
      .patch(`/hr/employees/${file}`)
      .set(s.compta.auth)
      .send({ payoutMethod: 'BANK', sensitive: { bankName: 'SGC', bankAccount: 'CM21 9999 0000' } })
      .expect(200);
    await http()
      .post(`/hr/employees/${file}/payout-change/reject`)
      .set(s.direction.auth)
      .send({ reason: 'RIB non signé' })
      .expect(201);
    const detail = await http().get(`/hr/employees/${file}`).set(s.direction.auth).expect(200);
    expect(detail.body.payoutMethod).toBe('MOBILE_MONEY');
    expect(detail.body.pendingPayoutChange).toBeNull();
    await http()
      .post(`/hr/employees/${file}/payout-change/approve`)
      .set(s.direction.auth)
      .expect(404);

    // Journal : valeurs masquées et empreintes, jamais de numéro en clair.
    const logs = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'hr.payout_details_' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => l.action)).toEqual([
      'hr.payout_details_requested',
      'hr.payout_details_approved',
      'hr.payout_details_requested',
      'hr.payout_details_rejected',
    ]);
    const text = JSON.stringify(logs);
    for (const secret of ['677123456', '699000111', 'CM21 9999 0000', 'CM2199990000'])
      expect(text).not.toContain(secret);
    expect(logs[1]?.before).toMatchObject({
      mobileMoneyNumber: '•••• 3456',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(logs[1]?.after).toMatchObject({ mobileMoneyNumber: '•••• 0111' });
    expect((logs[1]?.before as { fingerprint: string }).fingerprint).not.toBe(
      (logs[1]?.after as { fingerprint: string }).fingerprint,
    );
    await expect(
      prisma.payoutDetailsChange.updateMany({ data: { status: 'PENDING' } }),
    ).rejects.toThrow(/tranchée/);
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

describe('écarts de caisse', () => {
  it('manquant en 6588 et excédent en 7588 contre la caisse 571, à l’approbation, une seule fois', async () => {
    await enable(f.schoolId, ['accounting']);
    const student = await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: f.class4AId,
    });
    const pay = (amount: number) =>
      http()
        .post('/finance/payments')
        .set(s.compta.auth)
        .send({ studentId: student.id, amount, method: 'CASH', idempotencyKey: randomUUID() })
        .expect(201);
    const closeWith = async (paid: number, counted: number, note?: string) => {
      const session = await http().post('/finance/cash-sessions/open').set(s.compta.auth);
      await pay(paid);
      await http()
        .post(`/finance/cash-sessions/${session.body.id}/close`)
        .set(s.compta.auth)
        .send({ countedAmount: counted, note })
        .expect(201);
      return session.body.id as string;
    };

    // Manquant de 500 FCFA : rien n'est passé avant l'approbation.
    const short = await closeWith(25_000, 24_500, 'Erreur de monnaie rendue');
    expect(await prisma.accountingEntry.count({ where: { sourceType: 'CASH_DIFFERENCE' } })).toBe(
      0,
    );
    const approved = await http()
      .post(`/finance/cash-sessions/${short}/approve`)
      .set(s.direction.auth)
      .expect(201);
    const shortage = await lines('CASH_DIFFERENCE', short);
    expect(approved.body.entry).toBe(shortage.entry.reference);
    expect(shortage.entry.journalCode).toBe('CA');
    expect(shortage.entry.label).toMatch(/^Manquant de caisse · clôture du \d\d\/\d\d\/\d{4}/);
    expect([...shortage.by.entries()]).toEqual([
      ['6588', 500],
      ['571', -500],
    ]);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'finance.cash_approved', entityId: short },
    });
    expect(log.after).toMatchObject({ difference: -500, entry: shortage.entry.reference });

    // Excédent de 250 FCFA ; une caisse juste ne crée aucune écriture.
    const surplus = await closeWith(10_000, 10_250, 'Monnaie non reprise par un parent');
    const exact = await closeWith(5_000, 5_000);
    for (const id of [surplus, exact])
      await http().post(`/finance/cash-sessions/${id}/approve`).set(s.direction.auth).expect(201);
    expect([...(await lines('CASH_DIFFERENCE', surplus)).by.entries()]).toEqual([
      ['571', 250],
      ['7588', -250],
    ]);
    expect(
      await prisma.accountingEntry.count({
        where: { sourceType: 'CASH_DIFFERENCE', sourceId: exact },
      }),
    ).toBe(0);

    // Le rattrapage automatique ne repasse pas un écart déjà comptabilisé.
    await runAsSystem('test', () => app.get(AccountingService).syncAll(), f.schoolId);
    expect(await prisma.accountingEntry.count({ where: { sourceType: 'CASH_DIFFERENCE' } })).toBe(
      2,
    );
    const balance = (
      await http()
        .get('/accounting/reports/balance?from=2026-01-01&to=2026-12-31')
        .set(s.compta.auth)
        .expect(200)
    ).body.balance;
    // Caisse 571 : 40 000 encaissés, moins le manquant, plus l'excédent.
    expect(
      balance.rows.find((r: { accountNumber: string }) => r.accountNumber === '571'),
    ).toMatchObject({ balanceDebit: 40_000 - 500 + 250 });
    await expectIntegrity(f.schoolId);
  });

  it('rattrape l’écart d’une clôture approuvée avant l’activation de la comptabilité', async () => {
    const student = await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: f.class4AId,
    });
    const session = await http().post('/finance/cash-sessions/open').set(s.compta.auth);
    await http()
      .post('/finance/payments')
      .set(s.compta.auth)
      .send({ studentId: student.id, amount: 3000, method: 'CASH', idempotencyKey: randomUUID() })
      .expect(201);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/close`)
      .set(s.compta.auth)
      .send({ countedAmount: 2000, note: 'Billet déchiré refusé à la banque' })
      .expect(201);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/approve`)
      .set(s.direction.auth)
      .expect(201);
    await enable(f.schoolId, ['accounting']);
    await runAsSystem('test', () => app.get(AccountingService).syncAll(), f.schoolId);
    expect([...(await lines('CASH_DIFFERENCE', session.body.id)).by.entries()]).toEqual([
      ['6588', 1000],
      ['571', -1000],
    ]);
  });

  it('une école ne voit ni n’approuve les clôtures d’une autre', async () => {
    await enable(f.schoolId, ['accounting']);
    const other = await seedSchool('autre', 'AU');
    await enable(other.schoolId, ['accounting']);
    const so = await sessions(app, 'autre');
    const session = await http().post('/finance/cash-sessions/open').set(s.compta.auth);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/close`)
      .set(s.compta.auth)
      .send({ countedAmount: 100, note: 'Pièce trouvée' })
      .expect(201);
    expect(
      (await http().get('/finance/cash-sessions').set(so.direction.auth).expect(200)).body,
    ).toEqual([]);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/approve`)
      .set(so.direction.auth)
      .expect(404);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/close`)
      .set(so.compta.auth)
      .send({ countedAmount: 0 })
      .expect(404);
    expect(
      (await prisma.cashSession.findUniqueOrThrow({ where: { id: session.body.id } })).status,
    ).toBe('CLOSED');
    expect(await prisma.accountingEntry.count({ where: { sourceType: 'CASH_DIFFERENCE' } })).toBe(
      0,
    );
  });
});

describe('tableau de bord : ce qui attend une seconde personne', () => {
  it('compte dépenses, écritures, paie, avances et clôtures, jamais ce que la personne a saisi', async () => {
    await enable(f.schoolId, ['accounting']);
    const file = await employee(s.compta, f.users.teacher);
    const todo = async (session: Session) =>
      (await http().get('/dashboard').set(session.auth).expect(200)).body.todo;
    expect(await todo(s.direction)).toMatchObject({
      expensesToApprove: 0,
      entriesToApprove: 0,
      payrollToValidate: 0,
      advancesToDecide: 0,
      advancesToPay: 0,
      cashSessionsToApprove: 0,
    });

    // Saisies de la comptabilité qui attendent la direction.
    await http()
      .post('/accounting/expenses')
      .set(s.compta.auth)
      .send({
        supplierName: 'Librairie Saint-Paul',
        date: today(),
        label: 'Manuels scolaires',
        amount: 350_000,
        accountNumber: '6055',
        method: 'BANK',
        pieceRef: 'FAC-LSP-0460',
      })
      .expect(201);
    await http()
      .post('/accounting/entries')
      .set(s.compta.auth)
      .send({
        journal: 'CA',
        date: today(),
        label: 'Versement des espèces à la banque',
        lines: [
          { accountNumber: '658', debit: 250_000 },
          { accountNumber: '571', credit: 250_000 },
        ],
      })
      .expect(201);
    const adv = await http()
      .post('/hr/advances')
      .set(s.compta.auth)
      .send({
        employeeId: file,
        amount: 50_000,
        installments: 2,
        firstMonth: '2026-11',
        reason: 'Frais médicaux',
      })
      .expect(201);
    await http().post(`/hr/payroll/${MONTH}/compute`).set(s.compta.auth).expect(201);
    await http().post(`/hr/payroll/${MONTH}/submit`).set(s.compta.auth).expect(201);
    const session = await http().post('/finance/cash-sessions/open').set(s.compta.auth);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/close`)
      .set(s.compta.auth)
      .send({ countedAmount: 0 })
      .expect(201);

    expect(await todo(s.direction)).toMatchObject({
      expensesToApprove: 1,
      entriesToApprove: 1,
      payrollToValidate: 1,
      advancesToDecide: 1,
      advancesToPay: 0,
      cashSessionsToApprove: 1,
    });
    // La personne qui a tout saisi n'a rien à valider elle-même.
    expect(await todo(s.compta)).toMatchObject({
      expensesToApprove: 0,
      entriesToApprove: 0,
      payrollToValidate: 0,
      advancesToDecide: 0,
      advancesToPay: 0,
      cashSessionsToApprove: 0,
    });

    // Avance accordée par la direction : à verser par la comptabilité, puis plus rien.
    await http()
      .post(`/hr/advances/${adv.body.id}/approve`)
      .set(s.direction.auth)
      .send({})
      .expect(201);
    expect(await todo(s.direction)).toMatchObject({ advancesToDecide: 0, advancesToPay: 0 });
    expect((await todo(s.compta)).advancesToPay).toBe(1);
    await http()
      .post(`/hr/advances/${adv.body.id}/pay`)
      .set(s.compta.auth)
      .send({ date: today(), method: 'CASH' })
      .expect(201);
    expect((await todo(s.compta)).advancesToPay).toBe(0);
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

describe('produits des autres services facturés par la scolarité', () => {
  it('ventes du stock en 701, transport en 7063, pénalités de bibliothèque en 7071', async () => {
    await enable(f.schoolId, ['accounting', 'library', 'transport']);
    const student = await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: f.class4AId,
    });
    // Vente du stock.
    const item = await http()
      .post('/stock/items')
      .set(s.compta.auth)
      .send({ name: 'Chemise uniforme', category: 'UNIFORM', sizes: [], unitPrice: 4500 })
      .expect(201);
    await http()
      .post('/stock/purchases')
      .set(s.compta.auth)
      .send({ itemId: item.body.id, quantity: 5, unitCost: 3000, supplier: 'Tissus Mfoundi' })
      .expect(201);
    await http()
      .post('/stock/sales')
      .set(s.compta.auth)
      .send({ itemId: item.body.id, quantity: 2, studentId: student.id, requestId: randomUUID() })
      .expect(201);
    // Abonnement au transport.
    const bus = await http()
      .post('/transport/vehicles')
      .set(s.secretariat.auth)
      .send({ plate: 'CE 482 AB', capacity: 30 })
      .expect(201);
    const line = await http()
      .post('/transport/lines')
      .set(s.secretariat.auth)
      .send({ name: 'Ligne 1', vehicleId: bus.body.id, fee: 90_000, oneWayFee: 50_000 })
      .expect(201);
    const stop = await http()
      .post(`/transport/lines/${line.body.id}/stops`)
      .set(s.secretariat.auth)
      .send({ name: 'Carrefour Bastos', order: 1, morningTime: '06:45' })
      .expect(201);
    await http()
      .post('/transport/subscriptions')
      .set(s.secretariat.auth)
      .send({
        studentId: student.id,
        lineId: line.body.id,
        stopId: stop.body.id,
        direction: 'BOTH',
      })
      .expect(201);
    // Pénalité de retard de la bibliothèque.
    await http()
      .put('/library/settings')
      .set(s.secretariat.auth)
      .send({
        maxLoans: 3,
        loanDays: 14,
        maxRenewals: 1,
        lateFeePerDay: 100,
        lateFeeCap: 500,
        reminderSms: false,
      })
      .expect(200);
    const book = await http()
      .post('/library/books')
      .set(s.secretariat.auth)
      .send({ title: 'Ville cruelle', authors: ['Eza Boto'], callNumber: 'R BOT', copies: 1 })
      .expect(201);
    const copy = await prisma.libraryCopy.findFirstOrThrow({ where: { bookId: book.body.id } });
    const loan = await http()
      .post('/library/loans')
      .set(s.secretariat.auth)
      .send({ copyId: copy.id, borrowerType: 'STUDENT', studentId: student.id })
      .expect(201);
    await prisma.libraryLoan.update({
      where: { id: loan.body.id },
      data: { dueDate: toDbDate(new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10)) },
    });
    await http()
      .post(`/library/loans/${loan.body.id}/return`)
      .set(s.secretariat.auth)
      .send({})
      .expect(201);

    await http().post('/accounting/sync').set(s.compta.auth).expect(201);
    const credited = async (labelStart: string) => {
      const e = await prisma.accountingEntry.findFirstOrThrow({
        where: { schoolId: f.schoolId, sourceType: 'LEDGER', label: { startsWith: labelStart } },
        include: { lines: true },
      });
      return e.lines.filter((l) => l.credit > 0).map((l) => [l.accountNumber, l.credit]);
    };
    expect(await credited('Chemise uniforme')).toEqual([['701', 9000]]);
    expect(await credited('Transport scolaire')).toEqual([['7063', 90_000]]);
    expect(await credited('Pénalité de retard')).toEqual([['7071', 400]]);
    // La scolarité reste en 7061 et 7062.
    const tuition = await prisma.accountingLine.findMany({
      where: { schoolId: f.schoolId, credit: { gt: 0 }, accountNumber: { in: ['7061', '7062'] } },
    });
    expect(tuition.length).toBeGreaterThan(0);
    const is = (
      await http()
        .get(
          `/accounting/reports/compte-de-resultat?from=${today().slice(0, 4)}-01-01&to=${today().slice(0, 4)}-12-31`,
        )
        .set(s.compta.auth)
        .expect(200)
    ).body.statement;
    expect(is.products.map((g: { code: string }) => g.code)).toEqual(
      expect.arrayContaining(['70']),
    );
    await expectIntegrity(f.schoolId);
  });
});

describe('écritures manuelles de trésorerie', () => {
  it('une sortie de trésorerie au-delà du seuil attend la validation d’une autre personne', async () => {
    await enable(f.schoolId, ['accounting']);
    const body = (journal: string, amount: number, label: string, charge = '658') => ({
      journal,
      date: today(),
      label,
      pieceRef: 'BC-9',
      lines: [
        { accountNumber: charge, debit: amount },
        { accountNumber: '571', credit: amount },
      ],
    });
    const post = (b: object, session = s.compta) =>
      http().post('/accounting/entries').set(session.auth).send(b);

    // Sous le seuil : passée aussitôt.
    const small = await post(body('CA', 99_999, 'Petite caisse')).expect(201);
    expect(small.body.reference).toMatch(/^CA-/);
    // Au-delà du seuil, dans un journal de trésorerie ou en opérations diverses : en attente.
    const big = await post(body('CA', 250_000, 'Sortie de caisse')).expect(201);
    expect(big.body).toMatchObject({
      status: 'PENDING_APPROVAL',
      needsApproval: true,
      reference: null,
    });
    const viaOd = await post(body('OD', 300_000, 'Contournement par OD')).expect(201);
    expect(viaOd.body.status).toBe('PENDING_APPROVAL');
    expect(
      await prisma.accountingEntry.count({
        where: { schoolId: f.schoolId, total: { gte: 250_000 } },
      }),
    ).toBe(0);
    // Un apport en banque (aucune sortie de trésorerie) reste direct.
    await post({
      journal: 'BQ',
      date: today(),
      label: 'Apport du promoteur',
      lines: [
        { accountNumber: '521', debit: 500_000 },
        { accountNumber: '101', credit: 500_000 },
      ],
    }).expect(201);

    const pending = (
      await http().get('/accounting/entry-requests?status=PENDING').set(s.compta.auth).expect(200)
    ).body;
    expect(pending).toHaveLength(2);
    expect((await http().get('/accounting/overview').set(s.compta.auth)).body.pendingEntries).toBe(
      2,
    );
    // La personne qui a saisi ne valide pas, le secrétariat non plus.
    const self = await http()
      .post(`/accounting/entry-requests/${big.body.id}/approve`)
      .set(s.compta.auth)
      .expect(403);
    expect(self.body.message).toMatch(/autre personne/);
    await http()
      .post(`/accounting/entry-requests/${big.body.id}/approve`)
      .set(s.secretariat.auth)
      .expect(403);
    const approved = await http()
      .post(`/accounting/entry-requests/${big.body.id}/approve`)
      .set(s.direction.auth)
      .expect(201);
    expect(approved.body).toMatchObject({ journal: 'CA', total: 250_000 });
    await http()
      .post(`/accounting/entry-requests/${big.body.id}/approve`)
      .set(s.direction.auth)
      .expect(409);
    await http()
      .post(`/accounting/entry-requests/${viaOd.body.id}/reject`)
      .set(s.direction.auth)
      .send({ reason: 'Pièce justificative absente' })
      .expect(201);
    const all = (await http().get('/accounting/entry-requests').set(s.compta.auth)).body;
    expect(all.map((r: { status: string }) => r.status).sort()).toEqual(['APPROVED', 'REJECTED']);
    expect(all.find((r: { status: string }) => r.status === 'APPROVED').reference).toBe(
      approved.body.reference,
    );
    for (const action of [
      'accounting.entry_requested',
      'accounting.entry_approved',
      'accounting.entry_rejected',
    ])
      expect(await prisma.auditLog.count({ where: { action } }), action).toBeGreaterThan(0);
    await expect(
      prisma.manualEntryRequest.update({ where: { id: viaOd.body.id }, data: { total: 1 } }),
    ).rejects.toThrow(/tranchée/);
    await expectIntegrity(f.schoolId);
  });

  it('la clôture attend la décision sur les écritures de trésorerie de l’exercice', async () => {
    await enable(f.schoolId, ['accounting']);
    const year = await http()
      .post('/accounting/fiscal-years')
      .set(s.compta.auth)
      .send({ startDate: `${lastYear}-01-01`, endDate: `${lastYear}-12-31` })
      .expect(201);
    const req = await http()
      .post('/accounting/entries')
      .set(s.compta.auth)
      .send({
        journal: 'BQ',
        date: `${lastYear}-11-30`,
        label: 'Virement fournisseur',
        lines: [
          { accountNumber: '658', debit: 400_000 },
          { accountNumber: '521', credit: 400_000 },
        ],
      })
      .expect(201);
    const blocked = await http()
      .post(`/accounting/fiscal-years/${year.body.id}/close`)
      .set(s.direction.auth)
      .expect(409);
    expect(blocked.body.message).toMatch(/écriture\(s\) de trésorerie/);
    await http()
      .post(`/accounting/entry-requests/${req.body.id}/reject`)
      .set(s.direction.auth)
      .send({ reason: 'Virement non effectué' })
      .expect(201);
    await http()
      .post(`/accounting/fiscal-years/${year.body.id}/close`)
      .set(s.direction.auth)
      .expect(201);
  });
});

describe('annulation d’une dépense', () => {
  it('contre-passe achat et règlement, passe la dépense en « annulée », avec motif journalisé', async () => {
    await enable(f.schoolId, ['accounting']);
    const expense = await http()
      .post('/accounting/expenses')
      .set(s.compta.auth)
      .send({
        supplierName: 'CAMWATER',
        date: today(),
        label: 'Eau',
        amount: 20_000,
        accountNumber: '6051',
        method: 'BANK',
        pieceRef: 'CW-1',
      })
      .expect(201);
    expect(expense.body.status).toBe('POSTED');
    const invoice = await prisma.accountingEntry.findFirstOrThrow({
      where: { sourceType: 'EXPENSE', sourceId: expense.body.id },
    });
    // Contre-passer une écriture de dépense à la main laisserait la dépense « comptabilisée ».
    const direct = await http()
      .post(`/accounting/entries/${invoice.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Facture en double' })
      .expect(409);
    expect(direct.body.message).toMatch(/annulez la dépense/);

    const cancel = (session: Session, reason: string) =>
      http()
        .post(`/accounting/expenses/${expense.body.id}/cancel`)
        .set(session.auth)
        .send({ reason });
    await cancel(s.secretariat, 'Facture en double').expect(403);
    await cancel(s.compta, 'Non').expect(400);
    const done = await cancel(s.compta, 'Facture en double').expect(201);
    expect(done.body).toMatchObject({ status: 'CANCELLED' });
    expect(done.body.reversals).toHaveLength(2);
    await cancel(s.direction, 'Encore une fois').expect(409);

    const listed = (await http().get('/accounting/expenses').set(s.compta.auth).expect(200)).body;
    expect(listed[0]).toMatchObject({ status: 'CANCELLED', cancelReason: 'Facture en double' });
    expect(listed[0].cancelledBy).toBeTruthy();
    const net = async (n: string) => {
      const agg = await prisma.accountingLine.aggregate({
        where: { schoolId: f.schoolId, accountNumber: n },
        _sum: { debit: true, credit: true },
      });
      return (agg._sum.debit ?? 0) - (agg._sum.credit ?? 0);
    };
    expect(await net('6051')).toBe(0);
    expect(await net('521')).toBe(0);
    expect(await net('4011')).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'accounting.expense_cancelled' },
    });
    expect(audit.reason).toBe('Facture en double');
    // Une dépense annulée ne se modifie plus, même directement en base.
    await expect(
      prisma.expense.update({ where: { id: expense.body.id }, data: { status: 'POSTED' } }),
    ).rejects.toThrow(/ne se modifie plus/);
    await expect(
      prisma.expense.update({ where: { id: expense.body.id }, data: { amount: 1 } }),
    ).rejects.toThrow(/ne se modifient pas/);

    // Une dépense en attente ne s'annule pas : elle se rejette.
    const pending = await http()
      .post('/accounting/expenses')
      .set(s.compta.auth)
      .send({
        supplierName: 'ENEO',
        date: today(),
        label: 'Électricité',
        amount: 500_000,
        accountNumber: '6052',
        method: 'BANK',
        pieceRef: 'E-1',
      })
      .expect(201);
    await http()
      .post(`/accounting/expenses/${pending.body.id}/cancel`)
      .set(s.compta.auth)
      .send({ reason: 'Erreur de saisie' })
      .expect(409);
    await expectIntegrity(f.schoolId);
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
