import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());
const apiPath = (url: string) => url.replace(/^\/api/, '');

/** PNG valide de 1 × 1 pixel (lisible par le moteur PDF). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n');

async function enableDocuments(schoolId: string) {
  const school = await prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
  await prisma.school.update({
    where: { id: schoolId },
    data: { modules: [...school.modules, 'documents'] },
  });
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
  s = await sessions(app);
});

describe('photo de l’élève et consentement', () => {
  it('exige le consentement, chiffre la photo et la retire avec le consentement', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: f.class4AId,
    });
    const upload = () =>
      http()
        .post(`/students/${st.id}/photo`)
        .set(s.secretariat.auth)
        .attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' });

    // Sans consentement : dépôt refusé.
    const refused = await upload().expect(409);
    expect(refused.body.message).toMatch(/Consentement à la photo requis/);
    expect(await prisma.storedFile.count()).toBe(0);

    // Un enseignant ne peut pas enregistrer le consentement.
    await http()
      .put(`/students/${st.id}/photo-consent`)
      .set(s.prof.auth)
      .send({ consent: true })
      .expect(403);
    const given = await http()
      .put(`/students/${st.id}/photo-consent`)
      .set(s.secretariat.auth)
      .send({ consent: true })
      .expect(200);
    expect(given.body).toMatchObject({ consent: true, hasPhoto: false });

    // Un PDF n'est pas une photo.
    await http()
      .post(`/students/${st.id}/photo`)
      .set(s.secretariat.auth)
      .attach('file', PDF, { filename: 'photo.pdf', contentType: 'application/pdf' })
      .expect(400);

    await upload().expect(201);
    const stored = await prisma.storedFile.findFirstOrThrow({
      where: { category: 'STUDENT_PHOTO' },
    });
    expect(stored.encrypted).toBe(true);
    expect(stored.storageKey.startsWith(`${f.schoolId}/photos/`)).toBe(true);
    const raw = await readFile(path.join(process.env.STORAGE_LOCAL_DIR!, stored.storageKey));
    expect(raw.includes(PNG.subarray(1, 4))).toBe(false);

    // Fiche : consentement daté, auteur, photo présente.
    const overview = await http().get(`/students/${st.id}`).set(s.direction.auth).expect(200);
    expect(overview.body.photo).toMatchObject({
      consent: true,
      hasPhoto: true,
      consentBy: expect.stringMatching(/\S/),
    });
    expect(new Date(overview.body.photo.consentAt).getTime()).toBeGreaterThan(0);

    // Lien de courte durée, déchiffré par l'API ; l'enseignant de la classe peut voir la photo.
    const link = await http().get(`/students/${st.id}/photo`).set(s.prof.auth).expect(200);
    const content = await http().get(apiPath(link.body.url)).buffer(true).expect(200);
    expect(content.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(content.body as Buffer, PNG)).toBe(0);

    // Retrait du consentement : la photo est supprimée logiquement et n'est plus servie.
    const withdrawn = await http()
      .put(`/students/${st.id}/photo-consent`)
      .set(s.secretariat.auth)
      .send({ consent: false })
      .expect(200);
    expect(withdrawn.body).toMatchObject({ consent: false, hasPhoto: false });
    const deleted = await prisma.storedFile.findUniqueOrThrow({ where: { id: stored.id } });
    expect(deleted.deletedAt).not.toBeNull();
    await http().get(apiPath(link.body.url)).expect(404);
    await http().get(`/students/${st.id}/photo`).set(s.direction.auth).expect(404);
    const after = await http().get(`/students/${st.id}`).set(s.direction.auth).expect(200);
    expect(after.body.photo).toMatchObject({ consent: false, hasPhoto: false });
    await upload().expect(409);

    const audit = await prisma.auditLog.findMany({
      where: { entity: 'Student', entityId: st.id },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorId: true },
    });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'students.photo_consent_given',
        'students.photo_uploaded',
        'students.photo_consent_withdrawn',
      ]),
    );
    expect(audit.find((a) => a.action === 'students.photo_consent_given')?.actorId).toBe(
      f.users.secretary,
    );
    const student = await prisma.student.findUniqueOrThrow({ where: { id: st.id } });
    expect(student).toMatchObject({ photoFileId: null, photoConsentById: f.users.secretary });
  });

  it('limite la photo aux classes de l’enseignant et passe aussi par la modification de la fiche', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Paul',
      lastName: 'Mbarga',
      classId: f.class6AId,
    });
    // La modification de la fiche date et journalise le consentement.
    await http()
      .patch(`/students/${st.id}`)
      .set(s.secretariat.auth)
      .send({ photoConsent: true })
      .expect(200);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: st.id } });
    expect(student.photoConsentAt).not.toBeNull();
    await http()
      .post(`/students/${st.id}/photo`)
      .set(s.secretariat.auth)
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .expect(201);
    await http().get(`/students/${st.id}/photo`).set(s.direction.auth).expect(200);
    // Aucun enseignant n'a cours en 6e A.
    await http().get(`/students/${st.id}/photo`).set(s.prof.auth).expect(404);
    // Suppression de la photo sans retirer le consentement.
    await http().delete(`/students/${st.id}/photo`).set(s.secretariat.auth).expect(200);
    await http().get(`/students/${st.id}/photo`).set(s.direction.auth).expect(404);
    expect(
      await prisma.auditLog.count({ where: { action: 'students.photo_removed', entityId: st.id } }),
    ).toBe(1);
  });

  it('imprime la photo sur la carte d’élève, et plus après le retrait du consentement', async () => {
    await enableDocuments(f.schoolId);
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Grâce',
      lastName: 'Essomba',
      classId: f.class4AId,
    });
    await http()
      .put(`/students/${st.id}/photo-consent`)
      .set(s.secretariat.auth)
      .send({ consent: true })
      .expect(200);
    await http()
      .post(`/students/${st.id}/photo`)
      .set(s.secretariat.auth)
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .expect(201);
    const card = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: st.id, type: 'STUDENT_CARD' })
      .expect(201);
    const stored = await prisma.adminDocument.findUniqueOrThrow({ where: { id: card.body.id } });
    expect(stored.photoKey).not.toBeNull();
    const pdf = async () =>
      (
        await http()
          .get(`/documents/${card.body.id}/pdf`)
          .set(s.secretariat.auth)
          .buffer(true)
          .expect(200)
      ).body as Buffer;
    // Le QR de vérification est aussi une image : la photo en ajoute une.
    const images = async () => (await pdf()).toString('latin1').split('/Subtype /Image').length - 1;
    const withPhoto = await images();
    // Un certificat ne porte jamais de photo.
    const cert = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: st.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    expect(
      (await prisma.adminDocument.findUniqueOrThrow({ where: { id: cert.body.id } })).photoKey,
    ).toBeNull();

    await http()
      .put(`/students/${st.id}/photo-consent`)
      .set(s.secretariat.auth)
      .send({ consent: false })
      .expect(200);
    expect(await images()).toBeLessThan(withPhoto);
  });

  it('isole la photo et le consentement entre écoles', async () => {
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: f.class4AId,
    });
    await http()
      .put(`/students/${st.id}/photo-consent`)
      .set(s.secretariat.auth)
      .send({ consent: true })
      .expect(200);
    await http()
      .post(`/students/${st.id}/photo`)
      .set(s.secretariat.auth)
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .expect(201);

    await http()
      .put(`/students/${st.id}/photo-consent`)
      .set(other.secretariat.auth)
      .send({ consent: false })
      .expect(404);
    await http()
      .post(`/students/${st.id}/photo`)
      .set(other.secretariat.auth)
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' })
      .expect(404);
    await http().get(`/students/${st.id}/photo`).set(other.direction.auth).expect(404);
    await http().delete(`/students/${st.id}/photo`).set(other.secretariat.auth).expect(404);

    const student = await prisma.student.findUniqueOrThrow({ where: { id: st.id } });
    expect(student.photoConsent).toBe(true);
    expect(student.photoFileId).not.toBeNull();
    expect(await prisma.storedFile.count({ where: { category: 'STUDENT_PHOTO' } })).toBe(1);
  });
});

describe('déplacement d’un cours dans l’emploi du temps', () => {
  async function entry(classSubjectId: string, dayOfWeek: number, start: string, end: string) {
    const res = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({ classSubjectId, dayOfWeek, startTime: start, endTime: end })
      .expect(201);
    return res.body as { id: string };
  }

  it('déplace un cours en gardant sa durée et refuse les conflits', async () => {
    const maths = await entry(f.cs.maths4A, 1, '07:30', '09:20');
    const francais = await entry(f.cs.francais4A, 2, '07:30', '08:25');
    const maths4B = await entry(f.cs.maths4B, 3, '10:30', '11:25');

    // Classe déjà occupée le mardi à 07:30.
    const cls = await http()
      .patch(`/timetable/entries/${maths.id}`)
      .set(s.censeur.auth)
      .send({ dayOfWeek: 2, startTime: '07:30' })
      .expect(409);
    expect(cls.body.conflicts).toEqual([{ kind: 'class', entryId: francais.id }]);

    // L'enseignant de français (aussi en 4e B) est déjà pris le mercredi à 10:30.
    const teacher = await http()
      .patch(`/timetable/entries/${francais.id}`)
      .set(s.censeur.auth)
      .send({ dayOfWeek: 3, startTime: '10:30' })
      .expect(409);
    expect(teacher.body.conflicts).toEqual([{ kind: 'teacher', entryId: maths4B.id }]);

    // Créneau libre : la durée (1 h 50) est conservée.
    const moved = await http()
      .patch(`/timetable/entries/${maths.id}`)
      .set(s.censeur.auth)
      .send({ dayOfWeek: 4, startTime: '10:30' })
      .expect(200);
    expect(moved.body).toMatchObject({ dayOfWeek: 4, startTime: '10:30', endTime: '12:20' });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'timetable.entry_moved', entityId: maths.id },
    });
    expect(audit.before).toMatchObject({ dayOfWeek: 1, startTime: '07:30' });
    expect(audit.after).toMatchObject({ dayOfWeek: 4, startTime: '10:30', endTime: '12:20' });

    // Un enseignant ne modifie pas l'emploi du temps ; un créneau après minuit est refusé.
    await http()
      .patch(`/timetable/entries/${maths.id}`)
      .set(s.prof.auth)
      .send({ dayOfWeek: 5, startTime: '07:30' })
      .expect(403);
    await http()
      .patch(`/timetable/entries/${maths.id}`)
      .set(s.censeur.auth)
      .send({ dayOfWeek: 5, startTime: '23:00' })
      .expect(400);
  });

  it('signale la salle occupée et la charge horaire dépassée', async () => {
    const room = await http()
      .post('/timetable/rooms')
      .set(s.censeur.auth)
      .send({ name: 'B12' })
      .expect(201);
    const a = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({
        classSubjectId: f.cs.maths4A,
        dayOfWeek: 1,
        startTime: '07:30',
        endTime: '08:25',
        roomId: room.body.id,
      })
      .expect(201);
    const b = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({
        classSubjectId: f.cs.maths4B,
        dayOfWeek: 2,
        startTime: '07:30',
        endTime: '08:25',
        roomId: room.body.id,
      })
      .expect(201);
    const roomConflict = await http()
      .patch(`/timetable/entries/${a.body.id}`)
      .set(s.censeur.auth)
      .send({ dayOfWeek: 2, startTime: '08:00' })
      .expect(409);
    expect(roomConflict.body.conflicts).toEqual([{ kind: 'room', entryId: b.body.id }]);

    // Charge déjà au-delà du maximum (110 min pour 1 h) : le déplacement est refusé.
    await entry(f.cs.maths4A, 5, '07:30', '08:25');
    await prisma.membership.updateMany({
      where: { userId: f.users.teacher },
      data: { maxWeeklyHours: 1 },
    });
    const load = await http()
      .patch(`/timetable/entries/${a.body.id}`)
      .set(s.censeur.auth)
      .send({ dayOfWeek: 3, startTime: '07:30' })
      .expect(409);
    expect(load.body.message).toMatch(/Charge horaire dépassée/);
    expect(load.body.conflicts).toEqual([{ kind: 'load' }]);
    const planning = await http().get('/timetable/planning').set(s.censeur.auth).expect(200);
    expect(planning.body.entries).toHaveLength(3);
    expect(planning.body.maxWeeklyMinutes[f.users.teacher]).toBe(60);
  });

  it('isole l’emploi du temps entre écoles', async () => {
    const maths = await entry(f.cs.maths4A, 1, '07:30', '08:25');
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    await http()
      .patch(`/timetable/entries/${maths.id}`)
      .set(other.censeur.auth)
      .send({ dayOfWeek: 2, startTime: '07:30' })
      .expect(404);
    const planning = await http().get('/timetable/planning').set(other.censeur.auth).expect(200);
    expect(planning.body.entries).toEqual([]);
    const unchanged = await prisma.timetableEntry.findUniqueOrThrow({ where: { id: maths.id } });
    expect(unchanged.dayOfWeek).toBe(1);
  });
});

describe('listes paginées', () => {
  it('pagine le journal des paiements par curseur, sans recouvrement', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: f.class4AId,
    });
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    for (const amount of [1000, 2000, 3000, 4000, 5000]) {
      await http()
        .post('/finance/payments')
        .set(s.compta.auth)
        .send({ studentId: st.id, idempotencyKey: randomUUID(), amount, method: 'CASH' })
        .expect(201);
    }
    const first = await http().get('/finance/payments?limit=2').set(s.compta.auth).expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBe(first.body.items[1].id);
    const ids: string[] = first.body.items.map((p: { id: string }) => p.id);
    let cursor: string | null = first.body.nextCursor;
    while (cursor) {
      const page = await http()
        .get(`/finance/payments?limit=2&cursor=${cursor}`)
        .set(s.compta.auth)
        .expect(200);
      ids.push(...page.body.items.map((p: { id: string }) => p.id));
      cursor = page.body.nextCursor;
    }
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    await http().get('/finance/payments?limit=500').set(s.compta.auth).expect(400);
  });

  it('pagine les impayés et la liste des élèves', async () => {
    for (const name of ['Abena', 'Bilo', 'Chantal']) {
      await enrollStudent(app, s.secretariat, {
        firstName: name,
        lastName: 'Ngono',
        classId: f.class4AId,
      });
    }
    const p1 = await http().get('/students?page=1&pageSize=2').set(s.secretariat.auth).expect(200);
    const p2 = await http().get('/students?page=2&pageSize=2').set(s.secretariat.auth).expect(200);
    expect(p1.body.total).toBe(3);
    expect(
      [...p1.body.items, ...p2.body.items].map((i: { firstName: string }) => i.firstName),
    ).toEqual(['Abena', 'Bilo', 'Chantal']);

    const unpaid = await http()
      .get('/finance/unpaid?page=1&pageSize=1')
      .set(s.compta.auth)
      .expect(200);
    expect(unpaid.body).toMatchObject({ page: 1, pageSize: 1 });
    expect(unpaid.body.students.length).toBeLessThanOrEqual(1);
    expect(unpaid.body.total).toBeGreaterThanOrEqual(unpaid.body.students.length);
  });
});
