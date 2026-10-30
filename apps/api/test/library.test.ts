import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAsSystem } from '../src/common/context';
import { addDays, todayInCameroon, toDbDate } from '../src/common/dates';
import { LibraryService } from '../src/modules/library/library.service';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let a: { id: string };
let b: { id: string };
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
    data: { modules: [...school.modules, 'library'] },
  });
}

beforeEach(async () => {
  await resetDb();
  f = await seedSchool();
  await enableModules(f.schoolId);
  s = await sessions(app);
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
  });
});

async function book(title: string, copies = 2, isbn?: string) {
  const res = await http()
    .post('/library/books')
    .set(s.secretariat.auth)
    .send({ title, authors: ['Ferdinand Oyono'], isbn, callNumber: 'R OYO', copies });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const copyRows = await prisma.libraryCopy.findMany({
    where: { bookId: res.body.id },
    orderBy: { code: 'asc' },
  });
  return { id: res.body.id as string, copies: copyRows.map((c) => c.id), codes: res.body.codes };
}

const lend = (copyId: string, studentId: string) =>
  http()
    .post('/library/loans')
    .set(s.secretariat.auth)
    .send({ copyId, borrowerType: 'STUDENT', studentId });

describe('catalogue', () => {
  it('crée notices et exemplaires numérotés, recherche par titre, ISBN ou code', async () => {
    const boy = await book('Une vie de boy', 2, '978-2-266-11949-8');
    expect(boy.codes).toEqual(['BIB-00001', 'BIB-00002']);
    await http()
      .post('/library/books')
      .set(s.secretariat.auth)
      .send({ title: 'Doublon', isbn: '9782266119498' })
      .expect(409);
    await http()
      .post('/library/books')
      .set(s.secretariat.auth)
      .send({ title: 'Mauvais ISBN', isbn: '12345' })
      .expect(400);
    await http()
      .post(`/library/books/${boy.id}/copies`)
      .set(s.secretariat.auth)
      .send({ count: 1 })
      .expect(201);
    for (const search of ['vie de', '9782266119498', 'BIB-00003']) {
      const res = await http()
        .get(`/library/books?search=${encodeURIComponent(search)}`)
        .set(s.censeur.auth)
        .expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ title: 'Une vie de boy', available: 3 });
    }
    await http()
      .post('/library/books')
      .set(s.censeur.auth)
      .send({ title: 'Lecture seule' })
      .expect(403);
  });
});

describe('emprunts', () => {
  it('prête, prolonge et reprend un exemplaire, avec historique', async () => {
    const boy = await book('Une vie de boy');
    const loan = await lend(boy.copies[0]!, a.id);
    if (loan.status !== 201) throw new Error(JSON.stringify(loan.body));
    expect(loan.body.dueDate).toBe(addDays(today, 14));
    await lend(boy.copies[0]!, b.id).expect(409);
    const renewed = await http()
      .post(`/library/loans/${loan.body.id}/renew`)
      .set(s.secretariat.auth)
      .expect(201);
    expect(renewed.body.dueDate).toBe(addDays(today, 28));
    await http().post(`/library/loans/${loan.body.id}/renew`).set(s.secretariat.auth).expect(409);
    const back = await http()
      .post(`/library/loans/${loan.body.id}/return`)
      .set(s.secretariat.auth)
      .send({})
      .expect(201);
    expect(back.body).toMatchObject({ daysLate: 0, penalty: 0 });
    await http()
      .post(`/library/loans/${loan.body.id}/return`)
      .set(s.secretariat.auth)
      .send({})
      .expect(409);
    const history = await http()
      .get(`/library/loans?filter=history&studentId=${a.id}`)
      .set(s.secretariat.auth)
      .expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({ renewals: 1, book: { title: 'Une vie de boy' } });
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'library.' } } })).toBe(4);
  });

  it('applique le plafond d’emprunts par lecteur et bloque en cas de retard', async () => {
    const boy = await book('Une vie de boy', 3);
    await http()
      .put('/library/settings')
      .set(s.secretariat.auth)
      .send({
        maxLoans: 2,
        loanDays: 14,
        maxRenewals: 1,
        lateFeePerDay: 0,
        lateFeeCap: 0,
        reminderSms: true,
      })
      .expect(200);
    await lend(boy.copies[0]!, a.id).expect(201);
    await lend(boy.copies[1]!, a.id).expect(201);
    const capped = await lend(boy.copies[2]!, a.id).expect(409);
    expect(capped.body.message).toMatch(/Plafond/);
    const results = await Promise.all([lend(boy.copies[2]!, b.id), lend(boy.copies[2]!, b.id)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    // Un prêt en retard bloque les nouveaux emprunts.
    await prisma.libraryLoan.updateMany({
      where: { studentId: b.id },
      data: { dueDate: toDbDate(addDays(today, -1)) },
    });
    const extra = await book('Le vieux nègre et la médaille', 1);
    await lend(extra.copies[0]!, b.id).expect(409);
    const overdue = await http()
      .get('/library/loans?filter=overdue')
      .set(s.secretariat.auth)
      .expect(200);
    expect(overdue.body.items).toEqual([expect.objectContaining({ overdue: true, daysLate: 1 })]);
  });

  it('facture la pénalité de retard une seule fois, sauf levée ou personnel', async () => {
    const boy = await book('Une vie de boy', 3);
    await http()
      .put('/library/settings')
      .set(s.secretariat.auth)
      .send({
        maxLoans: 3,
        loanDays: 14,
        maxRenewals: 1,
        lateFeePerDay: 100,
        lateFeeCap: 500,
        reminderSms: true,
      })
      .expect(200);
    const l1 = await lend(boy.copies[0]!, a.id).expect(201);
    const l2 = await lend(boy.copies[1]!, a.id).expect(201);
    const l3 = await http()
      .post('/library/loans')
      .set(s.secretariat.auth)
      .send({ copyId: boy.copies[2], borrowerType: 'STAFF', staffUserId: f.users.teacher })
      .expect(201);
    await prisma.libraryLoan.updateMany({ data: { dueDate: toDbDate(addDays(today, -3)) } });
    const results = await Promise.all([
      http().post(`/library/loans/${l1.body.id}/return`).set(s.secretariat.auth).send({}),
      http().post(`/library/loans/${l1.body.id}/return`).set(s.secretariat.auth).send({}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 201)!.body).toMatchObject({
      daysLate: 3,
      penalty: 300,
    });
    const penalties = await prisma.invoiceLine.findMany({
      where: { invoice: { studentId: a.id }, label: { startsWith: 'Pénalité de retard' } },
    });
    expect(penalties).toHaveLength(1);
    expect(penalties[0]!.amount).toBe(300);
    const waived = await http()
      .post(`/library/loans/${l2.body.id}/return`)
      .set(s.secretariat.auth)
      .send({ waivePenalty: true })
      .expect(201);
    expect(waived.body.penalty).toBe(0);
    const staff = await http()
      .post(`/library/loans/${l3.body.id}/return`)
      .set(s.secretariat.auth)
      .send({ lost: true })
      .expect(201);
    expect(staff.body.penalty).toBe(0);
    expect(
      (await prisma.libraryCopy.findUniqueOrThrow({ where: { id: boy.copies[2]! } })).status,
    ).toBe('LOST');
    expect(
      await prisma.invoiceLine.count({ where: { label: { startsWith: 'Pénalité de retard' } } }),
    ).toBe(1);
  });

  it('rappelle les retards au parent par SMS, une fois par semaine', async () => {
    const boy = await book('Une vie de boy', 2);
    const loan = await lend(boy.copies[0]!, a.id).expect(201);
    await http()
      .post('/library/loans')
      .set(s.secretariat.auth)
      .send({ copyId: boy.copies[1], borrowerType: 'STAFF', staffUserId: f.users.teacher })
      .expect(201);
    await prisma.libraryLoan.updateMany({ data: { dueDate: toDbDate(addDays(today, -2)) } });
    const library = app.get(LibraryService);
    expect(await runAsSystem('test', () => library.sendOverdueReminders(today))).toEqual({
      sent: 1,
    });
    expect(await runAsSystem('test', () => library.sendOverdueReminders(today))).toEqual({
      sent: 0,
    });
    const sms = await prisma.notificationOutbox.findMany({ where: { template: 'libraryOverdue' } });
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ recipient: '+237677000111', status: 'PENDING' });
    expect(sms[0]!.body).toContain('Une vie de boy');
    expect(
      await runAsSystem('test', () => library.sendOverdueReminders(addDays(today, 7))),
    ).toEqual({ sent: 1 });
    // Réglage de l'école : pas de rappel.
    await http()
      .put('/library/settings')
      .set(s.secretariat.auth)
      .send({
        maxLoans: 3,
        loanDays: 14,
        maxRenewals: 1,
        lateFeePerDay: 0,
        lateFeeCap: 0,
        reminderSms: false,
      })
      .expect(200);
    expect(
      await runAsSystem('test', () => library.sendOverdueReminders(addDays(today, 14))),
    ).toEqual({ sent: 0 });
    expect(loan.body.id).toBeTruthy();
  });

  it('cloisonne catalogue et prêts entre écoles', async () => {
    const boy = await book('Une vie de boy');
    await lend(boy.copies[0]!, a.id).expect(201);
    const other = await seedSchool('autre', 'AU');
    await enableModules(other.schoolId);
    const o = await sessions(app, 'autre');
    expect((await http().get('/library/books').set(o.secretariat.auth)).body.total).toBe(0);
    expect((await http().get('/library/loans').set(o.secretariat.auth)).body.total).toBe(0);
    const ob = await enrollStudent(app, o.secretariat, {
      firstName: 'Zoé',
      lastName: 'Ewane',
      classId: other.class4AId,
    });
    await http()
      .post('/library/loans')
      .set(o.secretariat.auth)
      .send({ copyId: boy.copies[1], borrowerType: 'STUDENT', studentId: ob.id })
      .expect(404);
    await http()
      .post('/library/loans')
      .set(o.secretariat.auth)
      .send({ copyId: boy.copies[1], borrowerType: 'STUDENT', studentId: a.id })
      .expect(404);
    await http()
      .post(`/library/books/${boy.id}/copies`)
      .set(o.secretariat.auth)
      .send({ count: 1 })
      .expect(404);
    // Le code des exemplaires est numéroté par école.
    const theirs = await http()
      .post('/library/books')
      .set(o.secretariat.auth)
      .send({ title: 'Ville cruelle', copies: 1 })
      .expect(201);
    expect(theirs.body.codes).toEqual(['BIB-00001']);
  });
});
