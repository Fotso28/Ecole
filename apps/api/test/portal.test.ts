import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { todayInCameroon } from '../src/common/dates';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import {
  createPlatformAdmin,
  createTestApp,
  login,
  prisma,
  resetDb,
  toSession,
  type Session,
} from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());

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
});

async function parentLogin(phone: string): Promise<Session> {
  await http().post('/auth/otp/request').send({ phone }).expect(202);
  const code = /(\d{6})/.exec(MemorySmsProvider.sent.at(-1)?.body ?? '')?.[1];
  return toSession(await http().post('/auth/otp/verify').send({ phone, code }).expect(200));
}

describe('portail parent', () => {
  it('regroupe les enfants de plusieurs écoles sous un même compte', async () => {
    const mc = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    });
    const primary = await seedSchool('primaire', 'EP');
    const sp = await sessions(app, 'primaire');
    const ph = await enrollStudent(app, sp.secretariat, {
      firstName: 'Paul-Henri',
      lastName: 'Ngono',
      classId: primary.class6AId,
      phone: '677123456',
      gender: 'M',
    });
    await enrollStudent(app, s.secretariat, {
      firstName: 'Junior',
      lastName: 'Tchoupo',
      classId: f.class4BId,
      phone: '695442108',
    });

    const parent = await parentLogin('677123456');
    const children = await http().get('/portal/children').set(parent.auth).expect(200);
    expect(
      children.body
        .map((c: { firstName: string; school: { name: string } }) => [c.firstName, c.school.name])
        .sort(),
    ).toEqual([
      ['Marie-Claire', 'Collège demo'],
      ['Paul-Henri', 'Collège primaire'],
    ]);
    await http().get(`/portal/children/${ph.id}`).set(parent.auth).expect(200);
    const tchoupo = await prisma.student.findFirstOrThrow({ where: { lastName: 'Tchoupo' } });
    await http().get(`/portal/children/${tchoupo.id}`).set(parent.auth).expect(404);
    // Le compte parent n'ouvre aucune route du personnel.
    await http().get(`/students/${mc.id}`).set(parent.auth).expect(403);
    await http().get('/dashboard').set(parent.auth).expect(403);
  });

  it("présente notes publiées, absences, finances et annonces de l'enfant", async () => {
    const mc = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    });
    const ev = await http()
      .post('/grades/evaluations')
      .set(s.prof.auth)
      .send({
        classSubjectId: f.cs.maths4A,
        sequenceId: f.seq2Id,
        name: 'Composition',
        type: 'EXAM',
        weight: 2,
      })
      .expect(201);
    await http()
      .put(`/grades/evaluations/${ev.body.id}/grades`)
      .set(s.prof.auth)
      .send({ grades: [{ studentId: mc.id, value: '16,5' }] })
      .expect(200);
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send({
        classId: f.class4AId,
        date: todayInCameroon(),
        startTime: '07:30',
        endTime: '09:20',
        records: [{ studentId: mc.id, status: 'ABSENT' }],
      })
      .expect(201);
    await http()
      .post('/announcements')
      .set(s.direction.auth)
      .send({
        title: 'Réunion des parents',
        body: 'Samedi à 9 h',
        scope: 'CLASS',
        targetId: f.class4AId,
      })
      .expect(201);
    await http()
      .post('/announcements')
      .set(s.direction.auth)
      .send({ title: 'Sortie de 6e', body: 'Musée', scope: 'CLASS', targetId: f.class6AId })
      .expect(201);

    const parent = await parentLogin('677123456');
    let overview = await http().get(`/portal/children/${mc.id}`).set(parent.auth).expect(200);
    // Notes en brouillon : invisibles pour les parents.
    expect(overview.body.grades).toEqual([]);
    expect(overview.body.absences[0]).toMatchObject({
      status: 'ABSENT',
      startTime: '07:30',
      justification: null,
    });
    expect(overview.body.finance.totals.outstanding).toBe(185000);
    expect(overview.body.announcements.map((a: { title: string }) => a.title)).toEqual([
      'Réunion des parents',
    ]);

    await http()
      .post('/grades/sheet/submit')
      .set(s.prof.auth)
      .send({ classSubjectId: f.cs.maths4A, sequenceId: f.seq2Id })
      .expect(201);
    overview = await http().get(`/portal/children/${mc.id}`).set(parent.auth).expect(200);
    expect(overview.body.grades[0]).toMatchObject({
      subject: 'Mathématiques',
      evaluation: 'Composition',
      value: '16,50',
      sequence: 'Séquence 2',
    });
  });
});

describe('tableau de bord, annonces, audit, paramètres', () => {
  it('donne les indicateurs et les tâches du jour à la direction', async () => {
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
    });
    await enrollStudent(app, s.secretariat, {
      firstName: 'Yvan',
      lastName: 'Kamga',
      classId: f.class4BId,
      gender: 'M',
    });
    const dash = await http().get('/dashboard').set(s.direction.auth).expect(200);
    expect(dash.body.enrollment).toEqual({
      total: 2,
      girls: 1,
      boys: 1,
      changeFromPreviousYear: null,
    });
    expect(dash.body.finance.expected).toBe(370000);
    expect(dash.body.todo).toMatchObject({ pendingJustifications: 0, gradeSheetsToValidate: 0 });
    expect(dash.body.activity[0]).toMatchObject({ label: 'a inscrit un élève' });
    // Un enseignant n'a pas de tableau de bord ; le censeur le voit sans les finances.
    await http().get('/dashboard').set(s.prof.auth).expect(403);
    const censor = await http().get('/dashboard').set(s.censeur.auth).expect(200);
    expect(censor.body.finance).toBeNull();
  });

  it('envoie une annonce par SMS au parent principal des élèves ciblés', async () => {
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    });
    await enrollStudent(app, s.secretariat, {
      firstName: 'Paul-Henri',
      lastName: 'Ngono',
      classId: f.class6AId,
      phone: '677123456',
      gender: 'M',
    });
    await enrollStudent(app, s.secretariat, {
      firstName: 'Ibrahim',
      lastName: 'Bello',
      classId: f.class6AId,
      phone: '691378014',
      gender: 'M',
    });
    const res = await http()
      .post('/announcements')
      .set(s.direction.auth)
      .send({
        title: 'Rentrée du 2e trimestre',
        body: 'Le 4 janvier',
        scope: 'SCHOOL',
        sendSms: true,
      })
      .expect(201);
    expect(res.body.sms).toBe(2);
    const level = await http()
      .post('/announcements')
      .set(s.direction.auth)
      .send({ title: 'Sortie', body: 'Musée', scope: 'LEVEL', targetId: f.level6Id, sendSms: true })
      .expect(201);
    expect(level.body.sms).toBe(2);
    await http()
      .post('/announcements')
      .set(s.prof.auth)
      .send({ title: 'Test', body: 'Test', scope: 'SCHOOL' })
      .expect(403);
  });

  it("réserve le journal d'audit à la direction", async () => {
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
    });
    const logs = await http().get('/audit-logs?action=students').set(s.direction.auth).expect(200);
    expect(logs.body.items[0]).toMatchObject({
      action: 'students.created',
      actor: { lastName: 'secretariat' },
    });
    await http().get('/audit-logs').set(s.censeur.auth).expect(403);
  });

  it('met à jour les paramètres de l’école', async () => {
    const res = await http()
      .patch('/settings')
      .set(s.direction.auth)
      .send({ phone: '222 23 45 67', settings: { absenceAlertThreshold: 5, mfaRequired: true } })
      .expect(200);
    expect(res.body.settings).toMatchObject({ absenceAlertThreshold: 5, mfaRequired: true });
    await http()
      .patch('/settings')
      .set(s.censeur.auth)
      .send({ settings: { mfaRequired: false } })
      .expect(403);
    // Double authentification obligatoire : les rôles administratifs doivent l'activer d'abord.
    const fresh = await login(app, 'compta@demo.cm');
    const blocked = await http().get('/finance/summary').set(fresh.auth).expect(403);
    expect(blocked.body.code).toBe('MFA_SETUP_REQUIRED');
    await http().get('/auth/me').set(fresh.auth).expect(200);
    // Un enseignant n'est pas concerné.
    await http().get('/grades/class-subjects').set(s.prof.auth).expect(200);
  });

  it("désactive les routes d'un module non souscrit", async () => {
    await prisma.school.update({
      where: { id: f.schoolId },
      data: { modules: ['students', 'attendance', 'grades'] },
    });
    await http().get('/finance/summary').set(s.direction.auth).expect(403);
    await http().get('/students').set(s.direction.auth).expect(200);
  });

  it('donne au super-administrateur un accès exceptionnel en lecture seule', async () => {
    await createPlatformAdmin();
    const admin = await login(app, 'admin@plateforme.cm', 'motdepasse-admin-1');
    const access = await http()
      .post(`/platform/schools/${f.schoolId}/access`)
      .set(admin.auth)
      .send({ reason: 'Assistance demandée par la direction' })
      .expect(201);
    const bg = { Authorization: `Bearer ${access.body.accessToken}` };
    await http().get('/students').set(bg).expect(200);
    await http().post('/students').set(bg).send({}).expect(403);
    await http().get(`/students/x/health?reason=curiosite`).set(bg).expect(403);
  });
});

describe('emploi du temps', () => {
  it('refuse les conflits enseignant, salle et classe, et la charge excessive', async () => {
    const room = await http()
      .post('/timetable/rooms')
      .set(s.censeur.auth)
      .send({ name: 'B12' })
      .expect(201);
    const lab = await http()
      .post('/timetable/rooms')
      .set(s.censeur.auth)
      .send({ name: 'Labo 1' })
      .expect(201);
    const e1 = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({
        classSubjectId: f.cs.maths4A,
        dayOfWeek: 2,
        startTime: '07:30',
        endTime: '09:20',
        roomId: room.body.id,
      })
      .expect(201);
    // Même classe au même moment.
    const cls = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({
        classSubjectId: f.cs.francais4A,
        dayOfWeek: 2,
        startTime: '08:25',
        endTime: '09:20',
        roomId: lab.body.id,
      })
      .expect(409);
    expect(cls.body.conflicts).toEqual([{ kind: 'class', entryId: e1.body.id }]);
    // Même salle, autre classe.
    const rm = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({
        classSubjectId: f.cs.maths4B,
        dayOfWeek: 2,
        startTime: '07:30',
        endTime: '08:25',
        roomId: room.body.id,
      })
      .expect(409);
    expect(rm.body.conflicts.map((c: { kind: string }) => c.kind)).toEqual(['room']);
    // L'enseignant de français (aussi en 4e B) déjà occupé.
    await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.francais4A, dayOfWeek: 3, startTime: '10:30', endTime: '11:25' })
      .expect(201);
    const teacher = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.maths4B, dayOfWeek: 3, startTime: '10:30', endTime: '11:25' })
      .expect(409);
    expect(teacher.body.conflicts.map((c: { kind: string }) => c.kind)).toEqual(['teacher']);
    // Charge maximale : 2 h autorisées pour l'enseignant de maths de 4e A.
    await prisma.membership.updateMany({
      where: { userId: f.users.teacher },
      data: { maxWeeklyHours: 2 },
    });
    const load = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.maths4A, dayOfWeek: 4, startTime: '07:30', endTime: '08:30' })
      .expect(409);
    expect(load.body.message).toMatch(/Charge horaire dépassée/);

    const list = await http()
      .get(`/timetable/entries?classId=${f.class4AId}`)
      .set(s.prof.auth)
      .expect(200);
    expect(list.body).toHaveLength(2);
  });

  it("présente à l'enseignant ses cours du jour", async () => {
    const day = ((new Date(`${todayInCameroon()}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    if (day <= 6) {
      await http()
        .post('/timetable/entries')
        .set(s.censeur.auth)
        .send({
          classSubjectId: f.cs.maths4A,
          dayOfWeek: day,
          startTime: '07:30',
          endTime: '09:20',
        })
        .expect(201);
    }
    const res = await http().get('/teacher/today').set(s.prof.auth).expect(200);
    expect(res.body.classSubjects).toEqual([
      expect.objectContaining({ className: '4e A', subjectName: 'Mathématiques', coefficient: 4 }),
    ]);
    if (day <= 6)
      expect(res.body.lessons[0]).toMatchObject({
        startTime: '07:30',
        className: '4e A',
        attendanceTaken: false,
      });
  });
});
