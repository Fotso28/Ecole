import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayInCameroon } from '../src/common/dates';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, requestOtp, resetDb, toSession } from './helpers';

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
  ngono = (
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    })
  ).id;
  bilong = (
    await enrollStudent(app, s.secretariat, {
      firstName: 'Estelle',
      lastName: 'Bilong',
      classId: f.class4AId,
    })
  ).id;
});

function appel(
  date: string,
  startTime: string,
  statuses: Record<string, 'PRESENT' | 'ABSENT' | 'LATE'>,
) {
  return {
    classId: f.class4AId,
    classSubjectId: f.cs.maths4A,
    date,
    startTime,
    endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, '0')}${startTime.slice(2)}`,
    records: Object.entries(statuses).map(([studentId, status]) => ({ studentId, status })),
  };
}

describe('appel et notification des parents', () => {
  it("affiche la liste d'appel et enregistre l'appel", async () => {
    const roster = await http()
      .get(`/attendance/roster?classId=${f.class4AId}&date=${today()}&startTime=07:30`)
      .set(s.prof.auth)
      .expect(200);
    expect(
      roster.body.students.map((x: { lastName: string; status: null }) => [x.lastName, x.status]),
    ).toEqual([
      ['Bilong', null],
      ['Ngono', null],
    ]);
    const res = await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    expect(res.body.notified).toBe(1);
    const after = await http()
      .get(`/attendance/roster?classId=${f.class4AId}&date=${today()}&startTime=07:30`)
      .set(s.prof.auth)
      .expect(200);
    expect(after.body.students.find((x: { id: string }) => x.id === ngono).status).toBe('ABSENT');
    expect(after.body.session).not.toBeNull();
  });

  it("programme un SMS différé au parent, annulé si l'élève est finalement présent", async () => {
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    const pending = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'absence' },
    });
    expect(pending.recipient).toBe('+237677123456');
    // Accordé au sexe de l'élève.
    expect(pending.body).toContain('Marie-Claire Ngono était absente le');
    expect(pending.availableAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);

    // Correction de l'appel : l'élève arrivait en retard.
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '07:30', { [ngono]: 'LATE', [bilong]: 'PRESENT' }))
      .expect(201);
    const cancelled = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(cancelled.status).toBe('FAILED');
    expect(cancelled.lastError).toMatch(/Annulé/);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: ngono } });
    expect(record.status).toBe('LATE');
  });

  it("alerte quand le seuil d'absences non justifiées est atteint, une seule fois par période", async () => {
    for (const [i, time] of ['07:30', '10:30', '13:00'].entries()) {
      const res = await http()
        .post('/attendance/sessions')
        .set(s.prof.auth)
        .send(appel(addDays(today(), -i), time, { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
        .expect(201);
      expect(res.body.alerts.length).toBe(i === 2 ? 1 : 0);
    }
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '15:00', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    const alerts = await prisma.notificationOutbox.findMany({
      where: { template: 'absenceThreshold' },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('3 absences non justifiées sur 7 jours');
  });

  it('refuse un appel incohérent', async () => {
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(addDays(today(), 1), '07:30', { [ngono]: 'ABSENT' }))
      .expect(400);
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send({ ...appel(today(), '07:30', { [ngono]: 'ABSENT' }), endTime: '07:00' })
      .expect(400);
    const outsider = await enrollStudent(app, s.secretariat, {
      firstName: 'Ibrahim',
      lastName: 'Bello',
      classId: f.class6AId,
    });
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '07:30', { [outsider.id]: 'ABSENT' }))
      .expect(400);
  });

  it("interdit à un enseignant l'appel d'une classe où il n'intervient pas", async () => {
    await http()
      .get(`/attendance/roster?classId=${f.class6AId}&date=${today()}&startTime=07:30`)
      .set(s.prof.auth)
      .expect(403);
    await http()
      .post('/attendance/sessions')
      .set(s.compta.auth)
      .send(appel(today(), '07:30', { [ngono]: 'ABSENT' }))
      .expect(403);
  });
});

describe('justificatifs', () => {
  it('le parent justifie depuis le portail, la vie scolaire valide, le SMS en attente est annulé', async () => {
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: ngono } });

    const code = await requestOtp(app, '677123456');
    const parent = toSession(
      await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(200),
    );
    await http()
      .post('/portal/justifications')
      .set(parent.auth)
      .send({ studentId: ngono, recordIds: [record.id], reason: 'Consultation médicale' })
      .expect(201);
    // Le parent ne peut pas justifier pour un enfant qui n'est pas le sien.
    const other = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: bilong } });
    await http()
      .post('/portal/justifications')
      .set(parent.auth)
      .send({ studentId: bilong, recordIds: [other.id], reason: 'Malade' })
      .expect(404);

    const list = await http()
      .get('/attendance/justifications?status=PENDING')
      .set(s.surveillant.auth)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      reason: 'Consultation médicale',
      student: { lastName: 'Ngono' },
    });
    await http()
      .patch(`/attendance/justifications/${list.body[0].id}`)
      .set(s.prof.auth)
      .send({ decision: 'ACCEPTED' })
      .expect(403);
    await http()
      .patch(`/attendance/justifications/${list.body[0].id}`)
      .set(s.surveillant.auth)
      .send({ decision: 'ACCEPTED' })
      .expect(200);
    await http()
      .patch(`/attendance/justifications/${list.body[0].id}`)
      .set(s.surveillant.auth)
      .send({ decision: 'REJECTED', note: 'Déjà accepté' })
      .expect(409);

    const outbox = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'absence' },
    });
    expect(outbox.status).toBe('FAILED');
    expect(outbox.lastError).toBe('Annulé : absence justifiée');
    const records = await http()
      .get(`/attendance/students/${ngono}`)
      .set(s.surveillant.auth)
      .expect(200);
    expect(records.body[0].justification.status).toBe('ACCEPTED');
  });

  it('remet l’absence en non justifiée si le justificatif est refusé', async () => {
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: ngono } });
    const j = await http()
      .post('/attendance/justifications')
      .set(s.surveillant.auth)
      .send({ studentId: ngono, recordIds: [record.id], reason: 'Motif familial' })
      .expect(201);
    await http()
      .post('/attendance/justifications')
      .set(s.surveillant.auth)
      .send({ studentId: ngono, recordIds: [record.id], reason: 'Doublon' })
      .expect(409);
    await http()
      .patch(`/attendance/justifications/${j.body.id}`)
      .set(s.surveillant.auth)
      .send({ decision: 'REJECTED', note: 'Motif insuffisant' })
      .expect(200);
    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.justificationId).toBeNull();
  });
});

describe('justificatif refusé', () => {
  async function parentSession() {
    const code = await requestOtp(app, '677123456');
    return toSession(
      await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(200),
    );
  }

  it('exige un motif, garde les absences visées, prévient le parent et permet un nouvel envoi', async () => {
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '10:20', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: ngono } });
    const parent = await parentSession();
    const sent = await http()
      .post('/portal/justifications')
      .set(parent.auth)
      .send({ studentId: ngono, recordIds: [record.id], reason: 'Fatigué' })
      .expect(201);

    // Pas de refus sans motif.
    await http()
      .patch(`/attendance/justifications/${sent.body.id}`)
      .set(s.surveillant.auth)
      .send({ decision: 'REJECTED' })
      .expect(400);
    await http()
      .patch(`/attendance/justifications/${sent.body.id}`)
      .set(s.surveillant.auth)
      .send({ decision: 'REJECTED', note: 'La fatigue ne justifie pas une absence' })
      .expect(200);

    // L'absence redevient « à justifier »…
    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.justificationId).toBeNull();
    // … mais l'onglet « Refusés » montre toujours l'absence concernée et le motif.
    const rejected = await http()
      .get('/attendance/justifications?status=REJECTED')
      .set(s.surveillant.auth)
      .expect(200);
    expect(rejected.body).toHaveLength(1);
    expect(rejected.body[0]).toMatchObject({
      status: 'REJECTED',
      reason: 'Fatigué',
      reviewNote: 'La fatigue ne justifie pas une absence',
      records: [{ id: record.id, status: 'ABSENT', startTime: '10:20' }],
    });

    // Le parent est prévenu par la table d'envoi, avec le motif.
    const sms = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'justificationRejected' },
    });
    expect(sms.recipient).toBe('+237677123456');
    expect(sms.status).toBe('PENDING');
    expect(sms.body).toContain('Marie-Claire Ngono');
    expect(sms.body).toContain('Motif : La fatigue ne justifie pas une absence.');
    expect(sms.body).toContain(today().split('-').reverse().join('/'));

    // Le parent voit « Refusé » et le motif dans l'historique.
    const overview = await http().get(`/portal/children/${ngono}`).set(parent.auth).expect(200);
    expect(overview.body.absences[0]).toMatchObject({
      id: record.id,
      justification: null,
      rejection: { note: 'La fatigue ne justifie pas une absence' },
    });

    // Journal d'audit : décision et motif.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'attendance.justification_reviewed', entityId: sent.body.id },
    });
    expect(audit.after).toMatchObject({
      decision: 'REJECTED',
      note: 'La fatigue ne justifie pas une absence',
    });

    // Un nouveau justificatif reste possible ; l'ancien garde sa trace.
    const second = await http()
      .post('/portal/justifications')
      .set(parent.auth)
      .send({ studentId: ngono, recordIds: [record.id], reason: 'Certificat médical du Dr Abena' })
      .expect(201);
    const again = await http().get(`/portal/children/${ngono}`).set(parent.auth).expect(200);
    expect(again.body.absences[0]).toMatchObject({ justification: 'PENDING', rejection: null });
    const pending = await http()
      .get('/attendance/justifications?status=PENDING')
      .set(s.surveillant.auth)
      .expect(200);
    expect(pending.body.map((j: { id: string }) => j.id)).toEqual([second.body.id]);
    const stillRejected = await http()
      .get('/attendance/justifications?status=REJECTED')
      .set(s.surveillant.auth)
      .expect(200);
    expect(stillRejected.body[0].records.map((r: { id: string }) => r.id)).toEqual([record.id]);
  });

  it('ne crée jamais de justificatif rattaché à aucune absence (double envoi simultané)', async () => {
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '10:20', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: ngono } });
    const parent = await parentSession();
    const send = () =>
      http()
        .post('/portal/justifications')
        .set(parent.auth)
        .send({ studentId: ngono, recordIds: [record.id], reason: 'Consultation médicale' });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const all = await prisma.justification.findMany({ where: { studentId: ngono } });
    expect(all).toHaveLength(1);
    const linked = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(linked.justificationId).toBe(all[0]?.id);
    expect(all[0]?.recordIds).toEqual([record.id]);

    // Une absence d'un autre élève, ou aucune absence : refusé.
    const other = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: bilong } });
    await http()
      .post('/attendance/justifications')
      .set(s.surveillant.auth)
      .send({ studentId: ngono, recordIds: [other.id], reason: 'Malade' })
      .expect(400);
    await http()
      .post('/attendance/justifications')
      .set(s.surveillant.auth)
      .send({ studentId: ngono, recordIds: [], reason: 'Malade' })
      .expect(400);
    expect(await prisma.justification.count()).toBe(1);
  });
});

describe('confidentialité des absences', () => {
  it("un enseignant ne voit ni les absences ni les justificatifs des élèves d'autres classes", async () => {
    const other = await enrollStudent(app, s.secretariat, {
      firstName: 'Aline',
      lastName: 'Mbarga',
      classId: f.class4BId,
    });
    await http()
      .post('/attendance/sessions')
      .set(s.surveillant.auth)
      .send({
        classId: f.class4BId,
        date: today(),
        startTime: '07:30',
        endTime: '08:25',
        records: [{ studentId: other.id, status: 'ABSENT' }],
      })
      .expect(201);
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    for (const studentId of [other.id, ngono]) {
      const rec = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId } });
      await http()
        .post('/attendance/justifications')
        .set(s.surveillant.auth)
        .send({ studentId, recordIds: [rec.id], reason: 'Hospitalisation paludisme' })
        .expect(201);
    }

    await http().get(`/attendance/students/${other.id}`).set(s.prof.auth).expect(404);
    await http().get(`/attendance/students/${ngono}`).set(s.prof.auth).expect(200);
    const mine = await http().get('/attendance/justifications').set(s.prof.auth).expect(200);
    expect(mine.body.map((j: { student: { id: string } }) => j.student.id)).toEqual([ngono]);
    const all = await http().get('/attendance/justifications').set(s.surveillant.auth).expect(200);
    expect(all.body).toHaveLength(2);
  });
});

describe('statistiques et discipline', () => {
  it("calcule l'absentéisme par classe et liste les élèves les plus absents", async () => {
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '07:30', { [ngono]: 'ABSENT', [bilong]: 'PRESENT' }))
      .expect(201);
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send(appel(today(), '10:30', { [ngono]: 'ABSENT', [bilong]: 'LATE' }))
      .expect(201);
    const stats = await http().get('/attendance/stats').set(s.censeur.auth).expect(200);
    const c4a = stats.body.classes.find((c: { className: string }) => c.className === '4e A');
    expect(c4a).toMatchObject({ records: 4, absences: 2, unjustified: 2, lates: 1, rate: 50 });
    expect(stats.body.topStudents[0]).toMatchObject({
      absences: 2,
      student: { lastName: 'Ngono' },
    });
  });

  it('enregistre un incident disciplinaire', async () => {
    await http()
      .post('/attendance/incidents')
      .set(s.surveillant.auth)
      .send({
        studentId: ngono,
        date: today(),
        description: 'Bagarre dans la cour',
        sanction: 'Avertissement',
      })
      .expect(201);
    await http()
      .post('/attendance/incidents')
      .set(s.prof.auth)
      .send({ studentId: ngono, date: today(), description: 'X' })
      .expect(403);
    const detail = await http().get(`/students/${ngono}`).set(s.direction.auth).expect(200);
    expect(detail.body.incidents[0]).toMatchObject({
      description: 'Bagarre dans la cour',
      sanction: 'Avertissement',
    });
  });
});
