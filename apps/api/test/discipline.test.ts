import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@ecole/shared';
import { addDays, todayInCameroon } from '../src/common/dates';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, requestOtp, resetDb, toSession } from './helpers';

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
    await report(a.id, '2026-07-20', 'INSOLENCE');
    await report(a.id, '2026-08-02', 'VIOLENCE', 'BLAME');
    await report(b.id, '2026-08-15', 'VIOLENCE', 'DETENTION');
    await report(c.id, '2026-09-03', 'FRAUD', 'WARNING');

    const all = await http().get('/discipline/incidents').set(s.surveillant.auth).expect(200);
    expect(all.body.total).toBe(4);
    expect(all.body.items[0]).toMatchObject({
      date: '2026-09-03',
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
      .get('/discipline/incidents?from=2026-08-01&to=2026-08-31')
      .set(s.surveillant.auth)
      .expect(200);
    expect(byPeriod.body.total).toBe(2);
    await http()
      .get('/discipline/incidents?from=2026-11-01&to=2026-10-01')
      .set(s.surveillant.auth)
      .expect(400);
  });

  it('calcule des statistiques simples', async () => {
    await report(a.id, '2026-07-20', 'INSOLENCE');
    await report(a.id, '2026-08-02', 'VIOLENCE', 'BLAME');
    await report(b.id, '2026-08-15', 'VIOLENCE', 'DETENTION');
    await report(c.id, '2026-09-03', 'FRAUD', 'WARNING');
    const stats = await http().get('/discipline/stats').set(s.surveillant.auth).expect(200);
    // « Élèves sanctionnés » : des élèves, jamais plus que les élèves concernés.
    expect(stats.body).toMatchObject({ total: 4, students: 3, sanctioned: 3 });
    await report(a.id, '2026-08-20', 'INSOLENCE', 'WARNING');
    const again = await http().get('/discipline/stats').set(s.surveillant.auth).expect(200);
    expect(again.body).toMatchObject({ total: 5, students: 3, sanctioned: 3 });
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

describe('correction et suppression des incidents', () => {
  it('refuse une date future, depuis le registre comme depuis la fiche élève', async () => {
    const tomorrow = addDays(todayInCameroon(), 1);
    const res = await http()
      .post('/discipline/incidents')
      .set(s.surveillant.auth)
      .send({ studentId: a.id, date: tomorrow, type: 'OTHER', description: 'Bavardages' })
      .expect(400);
    expect(res.body.errors[0]).toMatchObject({
      path: 'date',
      message: 'La date ne peut pas être dans le futur',
    });
    await http()
      .post('/attendance/incidents')
      .set(s.surveillant.auth)
      .send({ studentId: a.id, date: tomorrow, description: 'Bavardages' })
      .expect(400);
    await report(a.id, todayInCameroon(), 'OTHER');
    expect(await prisma.incident.count()).toBe(1);
  });

  it('le déclarant, la vie scolaire et la direction corrigent ou suppriment, avec audit', async () => {
    const incident = await report(a.id, '2026-10-12', 'INDISCIPLINE');
    const list = await http().get('/discipline/incidents').set(s.surveillant.auth).expect(200);
    expect(list.body.items[0].canEdit).toBe(true);

    // Correction par le déclarant : mauvais élève, sanction ajoutée.
    const fixed = await http()
      .patch(`/discipline/incidents/${incident.id}`)
      .set(s.surveillant.auth)
      .send({
        studentId: b.id,
        date: '2026-10-12',
        type: 'INSOLENCE',
        description: 'Insolence envers le professeur',
        sanctionType: 'DETENTION',
        sanction: 'Mercredi 14 h',
      })
      .expect(200);
    expect(fixed.body).toMatchObject({ studentId: b.id, sanctionType: 'DETENTION' });
    const updated = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'discipline.incident_updated', entityId: incident.id },
    });
    expect(updated.before).toMatchObject({ studentId: a.id, type: 'INDISCIPLINE' });
    expect(updated.after).toMatchObject({ studentId: b.id, sanction: 'Mercredi 14 h' });
    await http()
      .patch(`/discipline/incidents/${incident.id}`)
      .set(s.surveillant.auth)
      .send({
        studentId: b.id,
        date: addDays(todayInCameroon(), 3),
        type: 'INSOLENCE',
        description: 'Insolence',
      })
      .expect(400);

    // Un secrétariat à qui l'école a donné le droit de signaler ne corrige que ses signalements.
    await http()
      .put('/roles/builtin/SECRETARY')
      .set(s.direction.auth)
      .send({
        permissions: [...ROLE_PERMISSIONS.SECRETARY, 'discipline.read', 'discipline.write'],
      })
      .expect(200);
    const others = await http().get('/discipline/incidents').set(s.secretariat.auth).expect(200);
    expect(others.body.items[0].canEdit).toBe(false);
    await http()
      .patch(`/discipline/incidents/${incident.id}`)
      .set(s.secretariat.auth)
      .send({ studentId: b.id, date: '2026-10-12', type: 'OTHER', description: 'Autre' })
      .expect(403);
    await http().delete(`/discipline/incidents/${incident.id}`).set(s.secretariat.auth).expect(403);
    const own = await http()
      .post('/discipline/incidents')
      .set(s.secretariat.auth)
      .send({ studentId: c.id, date: '2026-10-13', type: 'OTHER', description: 'Retard répété' })
      .expect(201);
    await http()
      .patch(`/discipline/incidents/${own.body.id}`)
      .set(s.secretariat.auth)
      .send({ studentId: c.id, date: '2026-10-13', type: 'TRUANCY', description: 'Absent' })
      .expect(200);

    // La direction supprime l'incident du surveillant ; le contenu reste au journal d'audit.
    await http().delete(`/discipline/incidents/${incident.id}`).set(s.direction.auth).expect(204);
    expect(await prisma.incident.findUnique({ where: { id: incident.id } })).toBeNull();
    const deleted = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'discipline.incident_deleted', entityId: incident.id },
    });
    expect(deleted.before).toMatchObject({
      studentId: b.id,
      description: 'Insolence envers le professeur',
      reportedById: f.users.supervisor,
    });
    await http().delete(`/discipline/incidents/${incident.id}`).set(s.direction.auth).expect(404);
    // Sans droit de signaler : ni correction ni suppression.
    await http().delete(`/discipline/incidents/${own.body.id}`).set(s.censeur.auth).expect(403);
  });
});

describe('exclusion temporaire', () => {
  it('prévient le parent par la table d’envoi et apparaît sur son portail', async () => {
    const date = addDays(todayInCameroon(), -1);
    // Un avertissement reste interne à l'école.
    await report(a.id, date, 'INSOLENCE', 'WARNING');
    expect(
      await prisma.notificationOutbox.count({ where: { template: 'temporaryExclusion' } }),
    ).toBe(0);
    const incident = await report(a.id, date, 'VIOLENCE', 'TEMPORARY_EXCLUSION', '2 jours.');
    const guardian = await prisma.guardian.findFirstOrThrow({
      where: { students: { some: { studentId: a.id } } },
    });
    const sms = await prisma.notificationOutbox.findFirstOrThrow({
      where: { template: 'temporaryExclusion' },
    });
    expect(sms).toMatchObject({ recipient: guardian.phone, status: 'PENDING' });
    expect(sms.body).toContain('Awa Bello est exclue temporairement');
    expect(sms.body).toContain(`(2 jours)`);
    expect(sms.payload).toMatchObject({ incidentId: incident.id });

    const code = await requestOtp(app, guardian.phone);
    const parent = toSession(
      await http().post('/auth/otp/verify').send({ phone: guardian.phone, code }).expect(200),
    );
    const overview = await http().get(`/portal/children/${a.id}`).set(parent.auth).expect(200);
    expect(overview.body.exclusions).toEqual([{ id: incident.id, date, details: '2 jours.' }]);

    // Exclusion ajoutée par une correction : le parent de l'élève (garçon) est prévenu.
    const other = await report(b.id, date, 'FRAUD', 'NONE');
    await http()
      .patch(`/discipline/incidents/${other.id}`)
      .set(s.surveillant.auth)
      .send({
        studentId: b.id,
        date,
        type: 'FRAUD',
        description: 'Fraude à la composition',
        sanctionType: 'TEMPORARY_EXCLUSION',
      })
      .expect(200);
    const second = await prisma.notificationOutbox.findMany({
      where: { template: 'temporaryExclusion' },
      orderBy: { createdAt: 'asc' },
    });
    expect(second).toHaveLength(2);
    expect(second[1]?.body).toContain('Jean Mvondo est exclu temporairement');
  });
});

describe('isolation du registre entre écoles', () => {
  it('une école ne voit ni ne crée d’incident pour une autre', async () => {
    await report(a.id, '2026-08-02', 'VIOLENCE', 'BLAME');
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
    const [mine] = await prisma.incident.findMany();
    await http()
      .patch(`/discipline/incidents/${mine?.id}`)
      .set(o.surveillant.auth)
      .send({ studentId: a.id, date: '2026-10-12', type: 'OTHER', description: 'Piratage' })
      .expect(404);
    await http().delete(`/discipline/incidents/${mine?.id}`).set(o.surveillant.auth).expect(404);
    expect(await prisma.incident.count()).toBe(1);
    expect(await prisma.incident.findFirst()).toMatchObject({ description: 'Incident VIOLENCE' });
  });
});
