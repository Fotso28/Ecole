import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayInCameroon } from '../src/common/dates';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb, toSession } from './helpers';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let ngono: string;
let bilong: string;
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
  f = await seedSchool();
  s = await sessions(app);
  ngono = (await enrollStudent(app, s.secretariat, { firstName: 'Marie-Claire', lastName: 'Ngono', classId: f.class4AId, phone: '677123456' })).id;
  bilong = (await enrollStudent(app, s.secretariat, { firstName: 'Estelle', lastName: 'Bilong', classId: f.class4AId })).id;
});

function appel(date: string, startTime: string, statuses: Record<string, 'PRESENT' | 'ABSENT' | 'LATE'>) {
  return {
    classId: f.class4AId,
    classSubjectId: f.cs.maths4A,
    date,
    startTime,
    endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, '0')}${startTime.slice(2)}`,
    records: Object.entries(statuses).map(([studentId, status]) => ({ studentId, status })),
  };
}

describe("appel et notification des parents", () => {
  it("affiche la liste d'appel et enregistre l'appel", async () => {
    const roster = await http().get(`/attendance/roster?classId=${f.class4AId}&date=${today()}&startTime=07:30`).set(s.prof.auth).expect(200);
    expect(roster.body.students.map((x: { lastName: string; status: null }) => [x.lastName, x.status])).toEqual([
      ['Bilong', null],
      ['Ngono', null],
    ]);
    const res = await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' })).expect(201);
    expect(res.body.notified).toBe(1);
    const after = await http().get(`/attendance/roster?classId=${f.class4AId}&date=${today()}&startTime=07:30`).set(s.prof.auth).expect(200);
    expect(after.body.students.find((x: { id: string }) => x.id === ngono).status).toBe('ABSENT');
    expect(after.body.session).not.toBeNull();
  });

  it("programme un SMS différé au parent, annulé si l'élève est finalement présent", async () => {
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' })).expect(201);
    const pending = await prisma.notificationOutbox.findFirstOrThrow({ where: { template: 'absence' } });
    expect(pending.recipient).toBe('+237677123456');
    expect(pending.body).toContain('Marie-Claire Ngono était absent(e)');
    expect(pending.availableAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    // Correction de l'appel : l'élève arrivait en retard.
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '07:30', { [ngono]: 'LATE', [bilong]: 'PRESENT' })).expect(201);
    const cancelled = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: pending.id } });
    expect(cancelled.status).toBe('FAILED');
    expect(cancelled.lastError).toMatch(/Annulé/);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: ngono } });
    expect(record.status).toBe('LATE');
  });

  it("alerte quand le seuil d'absences non justifiées est atteint, une seule fois par période", async () => {
    for (const [i, time] of ['07:30', '10:30', '13:00'].entries()) {
      const res = await http().post('/attendance/sessions').set(s.prof.auth).send(appel(addDays(today(), -i), time, { [ngono]: 'ABSENT', [bilong]: 'PRESENT' })).expect(201);
      expect(res.body.alerts.length).toBe(i === 2 ? 1 : 0);
    }
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '15:00', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' })).expect(201);
    const alerts = await prisma.notificationOutbox.findMany({ where: { template: 'absenceThreshold' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('3 absences non justifiées sur 7 jours');
  });

  it('refuse un appel incohérent', async () => {
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(addDays(today(), 1), '07:30', { [ngono]: 'ABSENT' })).expect(400);
    await http().post('/attendance/sessions').set(s.prof.auth).send({ ...appel(today(), '07:30', { [ngono]: 'ABSENT' }), endTime: '07:00' }).expect(400);
    const outsider = await enrollStudent(app, s.secretariat, { firstName: 'Ibrahim', lastName: 'Bello', classId: f.class6AId });
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '07:30', { [outsider.id]: 'ABSENT' })).expect(400);
  });

  it("interdit à un enseignant l'appel d'une classe où il n'intervient pas", async () => {
    await http().get(`/attendance/roster?classId=${f.class6AId}&date=${today()}&startTime=07:30`).set(s.prof.auth).expect(403);
    await http().post('/attendance/sessions').set(s.compta.auth).send(appel(today(), '07:30', { [ngono]: 'ABSENT' })).expect(403);
  });
});

describe('justificatifs', () => {
  it('le parent justifie depuis le portail, la vie scolaire valide, le SMS en attente est annulé', async () => {
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' })).expect(201);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: ngono } });

    await http().post('/auth/otp/request').send({ phone: '677123456' }).expect(202);
    const code = /(\d{6})/.exec(MemorySmsProvider.lastTo('+237677123456') ?? '')?.[1];
    const parent = toSession(await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(200));
    await http().post('/portal/justifications').set(parent.auth).send({ studentId: ngono, recordIds: [record.id], reason: 'Consultation médicale' }).expect(201);
    // Le parent ne peut pas justifier pour un enfant qui n'est pas le sien.
    const other = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: bilong } });
    await http().post('/portal/justifications').set(parent.auth).send({ studentId: bilong, recordIds: [other.id], reason: 'Malade' }).expect(404);

    const list = await http().get('/attendance/justifications?status=PENDING').set(s.surveillant.auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ reason: 'Consultation médicale', student: { lastName: 'Ngono' } });
    await http().patch(`/attendance/justifications/${list.body[0].id}`).set(s.prof.auth).send({ decision: 'ACCEPTED' }).expect(403);
    await http().patch(`/attendance/justifications/${list.body[0].id}`).set(s.surveillant.auth).send({ decision: 'ACCEPTED' }).expect(200);
    await http().patch(`/attendance/justifications/${list.body[0].id}`).set(s.surveillant.auth).send({ decision: 'REJECTED' }).expect(409);

    const outbox = await prisma.notificationOutbox.findFirstOrThrow({ where: { template: 'absence' } });
    expect(outbox.status).toBe('FAILED');
    const records = await http().get(`/attendance/students/${ngono}`).set(s.surveillant.auth).expect(200);
    expect(records.body[0].justification.status).toBe('ACCEPTED');
  });

  it('remet l’absence en non justifiée si le justificatif est refusé', async () => {
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' })).expect(201);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: ngono } });
    const j = await http().post('/attendance/justifications').set(s.surveillant.auth).send({ studentId: ngono, recordIds: [record.id], reason: 'Motif familial' }).expect(201);
    await http().post('/attendance/justifications').set(s.surveillant.auth).send({ studentId: ngono, recordIds: [record.id], reason: 'Doublon' }).expect(409);
    await http().patch(`/attendance/justifications/${j.body.id}`).set(s.surveillant.auth).send({ decision: 'REJECTED' }).expect(200);
    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.justificationId).toBeNull();
  });
});

describe('statistiques et discipline', () => {
  it("calcule l'absentéisme par classe et liste les élèves les plus absents", async () => {
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' })).expect(201);
    await http().post('/attendance/sessions').set(s.prof.auth).send(appel(today(), '10:30', { [ngono]: 'ABSENT', [bilong]: 'LATE' })).expect(201);
    const stats = await http().get('/attendance/stats').set(s.censeur.auth).expect(200);
    const c4a = stats.body.classes.find((c: { className: string }) => c.className === '4e A');
    expect(c4a).toMatchObject({ records: 4, absences: 2, unjustified: 2, lates: 1, rate: 50 });
    expect(stats.body.topStudents[0]).toMatchObject({ absences: 2, student: { lastName: 'Ngono' } });
  });

  it('enregistre un incident disciplinaire', async () => {
    await http().post('/attendance/incidents').set(s.surveillant.auth).send({ studentId: ngono, date: today(), description: 'Bagarre dans la cour', sanction: 'Avertissement' }).expect(201);
    await http().post('/attendance/incidents').set(s.prof.auth).send({ studentId: ngono, date: today(), description: 'X' }).expect(403);
    const detail = await http().get(`/students/${ngono}`).set(s.direction.auth).expect(200);
    expect(detail.body.incidents[0]).toMatchObject({ description: 'Bagarre dans la cour', sanction: 'Avertissement' });
  });
});
