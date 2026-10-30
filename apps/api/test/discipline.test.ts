import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let a: { id: string };
let b: { id: string };
let c: { id: string };
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
  a = await enrollStudent(app, s.secretariat, {
    firstName: 'Awa',
    lastName: 'Bello',
    classId: f.class4AId,
  });
  b = await enrollStudent(app, s.secretariat, {
    firstName: 'Jean',
    lastName: 'Mvondo',
    classId: f.class4AId,
    gender: 'M',
  });
  c = await enrollStudent(app, s.secretariat, {
    firstName: 'Paul',
    lastName: 'Ondoa',
    classId: f.class6AId,
    gender: 'M',
  });
});

async function report(
  studentId: string,
  date: string,
  type: string,
  sanctionType = 'NONE',
  sanction?: string,
) {
  const res = await http()
    .post('/discipline/incidents')
    .set(s.surveillant.auth)
    .send({ studentId, date, type, sanctionType, sanction, description: `Incident ${type}` });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

describe('registre des incidents', () => {
  it('enregistre un incident depuis le registre et le journalise', async () => {
    const incident = await report(a.id, '2026-10-12', 'VIOLENCE', 'BLAME', 'Blâme du conseil');
    const stored = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(stored).toMatchObject({
      type: 'VIOLENCE',
      sanctionType: 'BLAME',
      sanction: 'Blâme du conseil',
      reportedById: f.users.supervisor,
    });
    expect(
      await prisma.auditLog.count({
        where: { action: 'discipline.incident', entityId: incident.id },
      }),
    ).toBe(1);
    const invalid = await http()
      .post('/discipline/incidents')
      .set(s.surveillant.auth)
      .send({ studentId: a.id, date: '2026-10-12', type: 'INCONNU', description: 'Test' })
      .expect(400);
    expect(invalid.body.errors[0].path).toBe('type');
  });

  it('filtre par classe, période, type et sanction', async () => {
    await report(a.id, '2026-09-20', 'INSOLENCE');
    await report(a.id, '2026-10-02', 'VIOLENCE', 'BLAME');
    await report(b.id, '2026-10-15', 'VIOLENCE', 'DETENTION');
    await report(c.id, '2026-11-03', 'FRAUD', 'WARNING');

    const all = await http().get('/discipline/incidents').set(s.surveillant.auth).expect(200);
    expect(all.body.total).toBe(4);
    expect(all.body.items[0]).toMatchObject({
      date: '2026-11-03',
      typeLabel: 'Fraude',
      sanctionLabel: 'Avertissement',
      class: { name: '6e A' },
      student: { lastName: 'Ondoa' },
      reportedBy: expect.any(String),
    });

    const byClass = await http()
      .get(`/discipline/incidents?classId=${f.class4AId}`)
      .set(s.direction.auth)
      .expect(200);
    expect(byClass.body.total).toBe(3);
    const byType = await http()
      .get('/discipline/incidents?type=VIOLENCE')
      .set(s.surveillant.auth)
      .expect(200);
    expect(byType.body.total).toBe(2);
    const bySanction = await http()
      .get('/discipline/incidents?sanctionType=BLAME')
      .set(s.surveillant.auth)
      .expect(200);
    expect(
      bySanction.body.items.map((i: { student: { lastName: string } }) => i.student.lastName),
    ).toEqual(['Bello']);
    const byPeriod = await http()
      .get('/discipline/incidents?from=2026-10-01&to=2026-10-31')
      .set(s.surveillant.auth)
      .expect(200);
    expect(byPeriod.body.total).toBe(2);
    await http()
      .get('/discipline/incidents?from=2026-11-01&to=2026-10-01')
      .set(s.surveillant.auth)
      .expect(400);
  });

  it('calcule des statistiques simples', async () => {
    await report(a.id, '2026-09-20', 'INSOLENCE');
    await report(a.id, '2026-10-02', 'VIOLENCE', 'BLAME');
    await report(b.id, '2026-10-15', 'VIOLENCE', 'DETENTION');
    await report(c.id, '2026-11-03', 'FRAUD', 'WARNING');
    const stats = await http().get('/discipline/stats').set(s.surveillant.auth).expect(200);
    expect(stats.body).toMatchObject({ total: 4, students: 3, sanctioned: 3 });
    expect(stats.body.byType[0]).toEqual({ type: 'VIOLENCE', count: 2 });
    expect(stats.body.byClass).toEqual([
      { classId: f.class4AId, className: '4e A', count: 3 },
      { classId: f.class6AId, className: '6e A', count: 1 },
    ]);
    expect(stats.body.byMonth).toHaveLength(3);
    expect(stats.body.repeatStudents).toEqual([
      expect.objectContaining({
        studentId: a.id,
        count: 2,
        class: { id: f.class4AId, name: '4e A' },
      }),
    ]);
    const filtered = await http()
      .get(`/discipline/stats?classId=${f.class6AId}`)
      .set(s.surveillant.auth)
      .expect(200);
    expect(filtered.body.total).toBe(1);
  });

  it('réserve le registre au surveillant général et à la direction', async () => {
    for (const who of ['censeur', 'secretariat', 'compta', 'prof'] as const) {
      await http().get('/discipline/incidents').set(s[who].auth).expect(403);
      await http().get('/discipline/stats').set(s[who].auth).expect(403);
      await http()
        .post('/discipline/incidents')
        .set(s[who].auth)
        .send({ studentId: a.id, date: '2026-10-12', type: 'OTHER', description: 'Test' })
        .expect(403);
    }
    await http().get('/discipline/incidents').set(s.direction.auth).expect(200);
  });

  it('classe en « autre sanction » une sanction saisie depuis la fiche élève', async () => {
    const res = await http()
      .post('/attendance/incidents')
      .set(s.surveillant.auth)
      .send({ studentId: a.id, date: '2026-10-12', description: 'Bavardage', sanction: 'Consigne' })
      .expect(201);
    const stored = await prisma.incident.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored).toMatchObject({ type: 'OTHER', sanctionType: 'OTHER' });
  });
});

describe('isolation du registre entre écoles', () => {
  it('une école ne voit ni ne crée d’incident pour une autre', async () => {
    await report(a.id, '2026-10-02', 'VIOLENCE', 'BLAME');
    await seedSchool('autre', 'AU');
    const o = await sessions(app, 'autre');
    const list = await http().get('/discipline/incidents').set(o.surveillant.auth).expect(200);
    expect(list.body.total).toBe(0);
    const stats = await http().get('/discipline/stats').set(o.surveillant.auth).expect(200);
    expect(stats.body.total).toBe(0);
    await http()
      .post('/discipline/incidents')
      .set(o.surveillant.auth)
      .send({ studentId: a.id, date: '2026-10-12', type: 'OTHER', description: 'Test' })
      .expect(404);
    expect(await prisma.incident.count()).toBe(1);
  });
});
