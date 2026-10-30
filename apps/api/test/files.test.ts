import type { INestApplication } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, todayInCameroon } from '../src/common/dates';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, requestOtp, resetDb, type Session, toSession } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n');
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.alloc(64, 7),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const HTML = Buffer.from('<html><script>alert("x")</script></html>');

/** Le lien signé du stockage local est préfixé par /api (relais Nginx ou Next.js). */
const apiPath = (url: string) => url.replace(/^\/api/, '');

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
afterEach(() => {
  vi.useRealTimers();
});

async function parentLogin(phone: string): Promise<Session> {
  const code = await requestOtp(app, phone);
  return toSession(await http().post('/auth/otp/verify').send({ phone, code }).expect(200));
}

async function birthCertificate(studentId: string) {
  return prisma.studentDocument.findFirstOrThrow({
    where: { studentId, type: 'Acte de naissance' },
  });
}

describe('pièces justificatives d’inscription', () => {
  it('dépose, chiffre au repos, consulte par lien signé puis remplace le fichier', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: f.class4AId,
    });
    const doc = await birthCertificate(st.id);
    expect(doc.status).toBe('MISSING');

    const up = await http()
      .post(`/students/${st.id}/documents/${doc.id}/file`)
      .set(s.secretariat.auth)
      .attach('file', PDF, { filename: 'acte naissance.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(up.body).toMatchObject({
      status: 'RECEIVED',
      hasFile: true,
      file: { name: 'acte naissance.pdf', mimeType: 'application/pdf', size: PDF.length },
    });

    // Chiffré au repos : le contenu stocké n'est pas le PDF en clair.
    const stored = await prisma.storedFile.findFirstOrThrow({ where: { id: up.body.file.id } });
    expect(stored).toMatchObject({ encrypted: true, category: 'STUDENT_DOCUMENT' });
    expect(stored.storageKey.startsWith(`${f.schoolId}/eleves/`)).toBe(true);
    const raw = await readFile(path.join(process.env.STORAGE_LOCAL_DIR!, stored.storageKey));
    expect(raw.includes(Buffer.from('%PDF'))).toBe(false);

    // La fiche élève indique le fichier.
    const overview = await http().get(`/students/${st.id}`).set(s.secretariat.auth).expect(200);
    const listed = overview.body.documents.find((d: { id: string }) => d.id === doc.id);
    expect(listed).toMatchObject({ status: 'RECEIVED', hasFile: true, file: { size: PDF.length } });
    // Un rôle sans accès aux pièces voit qu'elle est fournie, sans le détail du fichier.
    const byCensor = await http().get(`/students/${st.id}`).set(s.censeur.auth).expect(200);
    expect(byCensor.body.documents.find((d: { id: string }) => d.id === doc.id)).toMatchObject({
      hasFile: true,
      file: null,
    });

    const link = await http()
      .get(`/students/${st.id}/documents/${doc.id}/file`)
      .set(s.secretariat.auth)
      .expect(200);
    expect(link.body.url).toMatch(/^\/api\/files\//);
    expect(new Date(link.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const content = await http().get(apiPath(link.body.url)).buffer(true).expect(200);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.headers['cache-control']).toBe('private, no-store');
    expect(content.headers['content-disposition']).toContain('acte%20naissance.pdf');
    expect(Buffer.compare(content.body as Buffer, PDF)).toBe(0);

    // Remplacement par une photo prise au téléphone : l'ancien fichier n'est plus servi.
    const replaced = await http()
      .post(`/students/${st.id}/documents/${doc.id}/file`)
      .set(s.direction.auth)
      .attach('file', JPEG, { filename: 'IMG_2026.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(replaced.body.file.mimeType).toBe('image/jpeg');
    await http().get(apiPath(link.body.url)).expect(404);
    const old = await prisma.storedFile.findUniqueOrThrow({ where: { id: stored.id } });
    expect(old.deletedAt).not.toBeNull();

    const actions = (
      await prisma.auditLog.findMany({ where: { schoolId: f.schoolId }, select: { action: true } })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'files.uploaded',
        'students.document_uploaded',
        'students.document_replaced',
        'files.deleted',
        'files.viewed',
      ]),
    );

    // Le statut fournie/manquante reste réglable à la main.
    await http()
      .patch(`/students/${st.id}/documents/${doc.id}`)
      .set(s.secretariat.auth)
      .send({ status: 'MISSING' })
      .expect(200);
  });

  it('vérifie le type sur le contenu réel et la taille maximale', async () => {
    const st = await enrollStudent(app, s.secretariat, { firstName: 'Lea', lastName: 'Mbia' });
    const doc = await birthCertificate(st.id);
    const url = `/students/${st.id}/documents/${doc.id}/file`;
    const refused = await http()
      .post(url)
      .set(s.secretariat.auth)
      .attach('file', HTML, { filename: 'acte.pdf', contentType: 'application/pdf' })
      .expect(400);
    expect(refused.body.message).toContain('PDF, JPEG ou PNG');
    await http()
      .post(url)
      .set(s.secretariat.auth)
      .attach('file', Buffer.from('GIF89a......'), { filename: 'a.png', contentType: 'image/png' })
      .expect(400);
    const big = Buffer.alloc(10 * 1024 * 1024 + 10, 0);
    PDF.copy(big);
    const tooBig = await http()
      .post(url)
      .set(s.secretariat.auth)
      .attach('file', big, { filename: 'gros.pdf', contentType: 'application/pdf' })
      .expect(413);
    expect(tooBig.body.message).toContain('10 Mo');
    await http().post(url).set(s.secretariat.auth).field('x', '1').expect(400);
    // PNG accepté même annoncé avec un autre type.
    await http()
      .post(url)
      .set(s.secretariat.auth)
      .attach('file', PNG, { filename: 'scan', contentType: 'application/octet-stream' })
      .expect(201);
    expect(await prisma.storedFile.count()).toBe(1);
  });

  it('refuse le dépôt et la consultation hors de ses droits', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Ines',
      lastName: 'Fouda',
      classId: f.class4AId,
    });
    const doc = await birthCertificate(st.id);
    const url = `/students/${st.id}/documents/${doc.id}/file`;
    await http().post(url).set(s.secretariat.auth).attach('file', PDF, 'acte.pdf').expect(201);
    for (const who of [s.prof, s.censeur, s.compta, s.surveillant]) {
      await http().post(url).set(who.auth).attach('file', PDF, 'acte.pdf').expect(403);
      await http().get(url).set(who.auth).expect(403);
    }
    await http().get(url).expect(401);
    // Pièce d'un autre élève : introuvable.
    const other = await enrollStudent(app, s.secretariat, { firstName: 'Zoe', lastName: 'Eto' });
    await http()
      .get(`/students/${other.id}/documents/${doc.id}/file`)
      .set(s.secretariat.auth)
      .expect(404);
  });

  it('isole les fichiers entre écoles et rejette les liens altérés ou expirés', async () => {
    const st = await enrollStudent(app, s.secretariat, { firstName: 'Ali', lastName: 'Moussa' });
    const doc = await birthCertificate(st.id);
    const url = `/students/${st.id}/documents/${doc.id}/file`;
    await http().post(url).set(s.secretariat.auth).attach('file', PDF, 'acte.pdf').expect(201);

    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    await http().get(url).set(other.secretariat.auth).expect(404);
    await http().post(url).set(other.direction.auth).attach('file', PDF, 'x.pdf').expect(404);
    await http()
      .patch(`/students/${st.id}/documents/${doc.id}`)
      .set(other.direction.auth)
      .send({ status: 'MISSING' })
      .expect(404);

    const link = await http().get(url).set(s.secretariat.auth).expect(200);
    const token = apiPath(link.body.url).split('/').pop()!;
    const [payload, mac] = token.split('.');
    // Charge utile réécrite (autre école) : signature invalide.
    const forged = Buffer.from(
      Buffer.from(payload!, 'base64url').toString().replace(f.schoolId, 'autre'),
    ).toString('base64url');
    await http().get(`/files/${forged}.${mac}`).expect(404);
    await http()
      .get(`/files/${payload}.${'A'.repeat(43)}`)
      .expect(404);
    await http().get('/files/nimportequoi').expect(404);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 301_000 });
    await http().get(apiPath(link.body.url)).expect(404);
  });
});

describe('pièce jointe des justificatifs d’absence', () => {
  async function absentWithJustification(phone: string) {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone,
    });
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send({
        classId: f.class4AId,
        date: todayInCameroon(),
        startTime: '07:30',
        endTime: '09:20',
        records: [{ studentId: st.id, status: 'ABSENT' }],
      })
      .expect(201);
    const parent = await parentLogin(phone);
    const overview = await http().get(`/portal/children/${st.id}`).set(parent.auth).expect(200);
    const recordId = overview.body.absences[0].id as string;
    const j = await http()
      .post('/portal/justifications')
      .set(parent.auth)
      .send({ studentId: st.id, recordIds: [recordId], reason: 'Paludisme, certificat joint' })
      .expect(201);
    return { st, parent, justificationId: j.body.id as string };
  }

  it('le parent dépose une photo, l’école la consulte, puis elle est figée', async () => {
    const { st, parent, justificationId } = await absentWithJustification('677123456');
    const up = await http()
      .post(`/portal/justifications/${justificationId}/attachment`)
      .set(parent.auth)
      .attach('file', JPEG, { filename: 'certificat.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(up.body.attachment).toMatchObject({ name: 'certificat.jpg', mimeType: 'image/jpeg' });
    const stored = await prisma.storedFile.findFirstOrThrow();
    expect(stored).toMatchObject({
      schoolId: f.schoolId,
      category: 'JUSTIFICATION',
      encrypted: true,
    });

    const overview = await http().get(`/portal/children/${st.id}`).set(parent.auth).expect(200);
    expect(overview.body.absences[0]).toMatchObject({
      justification: 'PENDING',
      justificationId,
      hasAttachment: true,
    });

    const list = await http().get('/attendance/justifications').set(s.surveillant.auth).expect(200);
    expect(list.body[0].attachment).toMatchObject({ name: 'certificat.jpg' });
    const link = await http()
      .get(`/attendance/justifications/${justificationId}/attachment`)
      .set(s.surveillant.auth)
      .expect(200);
    const content = await http().get(apiPath(link.body.url)).buffer(true).expect(200);
    expect(content.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(content.body as Buffer, JPEG)).toBe(0);

    // L'enseignant voit le justificatif de sa classe, pas la pièce (souvent médicale).
    const byTeacher = await http().get('/attendance/justifications').set(s.prof.auth).expect(200);
    expect(byTeacher.body[0]).toMatchObject({ hasAttachment: true, attachment: null });
    await http()
      .get(`/attendance/justifications/${justificationId}/attachment`)
      .set(s.prof.auth)
      .expect(403);

    // Une autre famille ne peut rien déposer.
    await enrollStudent(app, s.secretariat, {
      firstName: 'Jean',
      lastName: 'Ella',
      phone: '699000111',
    });
    const stranger = await parentLogin('699000111');
    await http()
      .post(`/portal/justifications/${justificationId}/attachment`)
      .set(stranger.auth)
      .attach('file', JPEG, 'x.jpg')
      .expect(404);

    // Type refusé côté portail aussi.
    await http()
      .post(`/portal/justifications/${justificationId}/attachment`)
      .set(parent.auth)
      .attach('file', HTML, 'certificat.jpg')
      .expect(400);

    await http()
      .patch(`/attendance/justifications/${justificationId}`)
      .set(s.surveillant.auth)
      .send({ decision: 'ACCEPTED' })
      .expect(200);
    await http()
      .post(`/portal/justifications/${justificationId}/attachment`)
      .set(parent.auth)
      .attach('file', PDF, 'autre.pdf')
      .expect(409);
  });

  it('une autre école ne voit ni ne modifie la pièce jointe', async () => {
    const { justificationId } = await absentWithJustification('677123456');
    await http()
      .post(`/attendance/justifications/${justificationId}/attachment`)
      .set(s.surveillant.auth)
      .attach('file', PDF, 'convocation.pdf')
      .expect(201);
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    await http()
      .get(`/attendance/justifications/${justificationId}/attachment`)
      .set(other.surveillant.auth)
      .expect(404);
    await http()
      .post(`/attendance/justifications/${justificationId}/attachment`)
      .set(other.direction.auth)
      .attach('file', PDF, 'x.pdf')
      .expect(404);
    const list = await http()
      .get('/attendance/justifications')
      .set(other.direction.auth)
      .expect(200);
    expect(list.body).toEqual([]);
  });
});

describe('cahier de texte et supports de cours', () => {
  const today = () => todayInCameroon();

  it('l’enseignant saisit ses séances ; le censeur consulte ; les parents voient les devoirs', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Paul',
      lastName: 'Atangana',
      classId: f.class4AId,
      phone: '677555444',
    });
    const cs = await http().get('/lessons/class-subjects').set(s.prof.auth).expect(200);
    // Classe 4e A : maths (les siennes, modifiables), français et anglais (lecture seule).
    expect(
      cs.body.map((c: { id: string; canWrite: boolean }) => [c.id, c.canWrite]).sort(),
    ).toEqual(
      [
        [f.cs.anglais4A, false],
        [f.cs.francais4A, false],
        [f.cs.maths4A, true],
      ].sort(),
    );

    const entry = await http()
      .post('/lessons')
      .set(s.prof.auth)
      .send({
        classSubjectId: f.cs.maths4A,
        date: today(),
        startTime: '07:30',
        content: 'Théorème de Pythagore : énoncé et démonstration',
        homework: 'Exercices 3 à 6 page 112',
        homeworkDueDate: addDays(today(), 3),
      })
      .expect(201);
    expect(entry.body).toMatchObject({
      className: '4e A',
      subjectName: 'Mathématiques',
      canEdit: true,
      homeworkDueDate: addDays(today(), 3),
    });

    // Pas de saisie dans la matière d'un collègue, ni pour le censeur (consultation).
    await http()
      .post('/lessons')
      .set(s.prof.auth)
      .send({ classSubjectId: f.cs.maths4B, date: today(), content: 'Fractions' })
      .expect(403);
    await http()
      .post('/lessons')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.maths4A, date: today(), content: 'Fractions' })
      .expect(403);
    await http()
      .put(`/lessons/${entry.body.id}`)
      .set(s.prof2.auth)
      .send({ classSubjectId: f.cs.maths4A, date: today(), content: 'Modifié par un collègue' })
      .expect(403);
    await http().get('/lessons').set(s.compta.auth).expect(403);

    const updated = await http()
      .put(`/lessons/${entry.body.id}`)
      .set(s.prof.auth)
      .send({
        classSubjectId: f.cs.maths4A,
        date: today(),
        startTime: '07:30',
        content: 'Théorème de Pythagore et réciproque',
        homework: 'Exercices 3 à 8 page 112',
        homeworkDueDate: addDays(today(), 2),
      })
      .expect(200);
    expect(updated.body.homework).toBe('Exercices 3 à 8 page 112');

    const material = await http()
      .post('/lessons/materials')
      .set(s.prof.auth)
      .field('classSubjectId', f.cs.maths4A)
      .field('lessonLogId', entry.body.id)
      .field('title', 'Fiche d’exercices')
      .attach('file', PDF, { filename: 'fiche.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(material.body).toMatchObject({ title: 'Fiche d’exercices', lessonLogId: entry.body.id });
    const storedMaterial = await prisma.storedFile.findFirstOrThrow({
      where: { category: 'COURSE_MATERIAL' },
    });
    expect(storedMaterial.encrypted).toBe(false);
    await http()
      .post('/lessons/materials')
      .set(s.prof2.auth)
      .field('classSubjectId', f.cs.maths4A)
      .field('title', 'Intrus')
      .attach('file', PDF, 'intrus.pdf')
      .expect(403);

    const byCensor = await http()
      .get(`/lessons?classId=${f.class4AId}`)
      .set(s.censeur.auth)
      .expect(200);
    expect(byCensor.body).toHaveLength(1);
    expect(byCensor.body[0]).toMatchObject({
      content: 'Théorème de Pythagore et réciproque',
      canEdit: false,
      materials: [{ title: 'Fiche d’exercices' }],
    });
    expect(byCensor.body[0].author).toContain('prof');
    // Le collègue de la même classe consulte (lecture seule).
    const byColleague = await http()
      .get(`/lessons?classId=${f.class4AId}`)
      .set(s.prof2.auth)
      .expect(200);
    expect(byColleague.body[0].canEdit).toBe(false);
    // Hors de ses classes : refusé.
    await http().get(`/lessons?classId=${f.class6AId}`).set(s.prof.auth).expect(403);
    const censorLink = await http()
      .get(`/lessons/materials/${material.body.id}/file`)
      .set(s.censeur.auth)
      .expect(200);
    await http().get(apiPath(censorLink.body.url)).expect(200);

    const parent = await parentLogin('677555444');
    const hw = await http().get(`/portal/children/${st.id}/homework`).set(parent.auth).expect(200);
    expect(hw.body.className).toBe('4e A');
    expect(hw.body.homework).toEqual([
      expect.objectContaining({
        subjectName: 'Mathématiques',
        homework: 'Exercices 3 à 8 page 112',
        homeworkDueDate: addDays(today(), 2),
      }),
    ]);
    expect(hw.body.homework[0].author).toBeUndefined();
    expect(hw.body.materials).toEqual([expect.objectContaining({ title: 'Fiche d’exercices' })]);
    const parentLink = await http()
      .get(`/portal/materials/${material.body.id}/file`)
      .set(parent.auth)
      .expect(200);
    const content = await http().get(apiPath(parentLink.body.url)).buffer(true).expect(200);
    expect(Buffer.compare(content.body as Buffer, PDF)).toBe(0);

    // Parent d'un élève d'une autre classe : ni devoirs de 4e A, ni support.
    const other = await enrollStudent(app, s.secretariat, {
      firstName: 'Eric',
      lastName: 'Owona',
      classId: f.class6AId,
      phone: '699888777',
    });
    const otherParent = await parentLogin('699888777');
    const otherHw = await http()
      .get(`/portal/children/${other.id}/homework`)
      .set(otherParent.auth)
      .expect(200);
    expect(otherHw.body.homework).toEqual([]);
    await http()
      .get(`/portal/materials/${material.body.id}/file`)
      .set(otherParent.auth)
      .expect(404);
    await http().get(`/portal/children/${st.id}/homework`).set(otherParent.auth).expect(404);

    // Devoir passé : n'apparaît plus dans « à faire ».
    await http()
      .post('/lessons')
      .set(s.prof.auth)
      .send({
        classSubjectId: f.cs.maths4A,
        date: addDays(today(), -5),
        content: 'Révisions',
        homework: 'Apprendre la leçon',
        homeworkDueDate: addDays(today(), -1),
      })
      .expect(201);
    const hw2 = await http().get(`/portal/children/${st.id}/homework`).set(parent.auth).expect(200);
    expect(hw2.body.homework).toHaveLength(1);

    // Retrait du support et de la séance (suppression logique).
    await http().delete(`/lessons/materials/${material.body.id}`).set(s.prof.auth).expect(200);
    await http().get(apiPath(parentLink.body.url)).expect(404);
    await http().delete(`/lessons/${entry.body.id}`).set(s.prof.auth).expect(200);
    const hw3 = await http().get(`/portal/children/${st.id}/homework`).set(parent.auth).expect(200);
    expect(hw3.body.homework).toEqual([]);
    expect(hw3.body.materials).toEqual([]);
  });

  it('isole le cahier de texte et les supports entre écoles', async () => {
    const entry = await http()
      .post('/lessons')
      .set(s.prof.auth)
      .send({ classSubjectId: f.cs.maths4A, date: today(), content: 'Équations' })
      .expect(201);
    const material = await http()
      .post('/lessons/materials')
      .set(s.prof.auth)
      .field('classSubjectId', f.cs.maths4A)
      .field('title', 'Cours')
      .attach('file', PDF, 'cours.pdf')
      .expect(201);
    const g = await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    expect((await http().get('/lessons').set(other.direction.auth).expect(200)).body).toEqual([]);
    expect(
      (await http().get('/lessons/materials').set(other.direction.auth).expect(200)).body,
    ).toEqual([]);
    await http().get(`/lessons?classId=${f.class4AId}`).set(other.direction.auth).expect(404);
    await http()
      .get(`/lessons/materials/${material.body.id}/file`)
      .set(other.direction.auth)
      .expect(404);
    await http()
      .put(`/lessons/${entry.body.id}`)
      .set(other.direction.auth)
      .send({ classSubjectId: f.cs.maths4A, date: today(), content: 'Piratage' })
      .expect(404);
    await http().delete(`/lessons/${entry.body.id}`).set(other.direction.auth).expect(404);
    await http()
      .delete(`/lessons/materials/${material.body.id}`)
      .set(other.direction.auth)
      .expect(404);
    // Matière de l'école A utilisée depuis l'école B : refusée.
    await http()
      .post('/lessons')
      .set(other.prof.auth)
      .send({ classSubjectId: f.cs.maths4A, date: today(), content: 'Intrusion' })
      .expect(404);
    await http()
      .post('/lessons/materials')
      .set(other.prof.auth)
      .field('classSubjectId', f.cs.maths4A)
      .field('title', 'Intrus')
      .attach('file', PDF, 'x.pdf')
      .expect(404);
    expect(await prisma.lessonLog.count({ where: { schoolId: g.schoolId } })).toBe(0);
    expect(await prisma.storedFile.count({ where: { schoolId: g.schoolId } })).toBe(0);
  });
});
