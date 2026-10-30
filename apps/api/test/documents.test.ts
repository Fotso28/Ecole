import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let student: { id: string; matricule: string };
const http = () => request(app.getHttpServer());

async function enableDocuments(schoolId: string) {
  const school = await prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
  await prisma.school.update({
    where: { id: schoolId },
    data: { modules: [...school.modules, 'documents'] },
  });
}

beforeAll(async () => {
  app = await createTestApp();
  // Demandes simultanées : une écoute par requête sur le même serveur.
  app.getHttpServer().setMaxListeners(50);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  f = await seedSchool();
  await enableDocuments(f.schoolId);
  s = await sessions(app);
  student = await enrollStudent(app, s.secretariat, {
    firstName: 'Grâce',
    lastName: 'Essomba',
    classId: f.class4AId,
    gender: 'F',
  });
});

describe('documents administratifs', () => {
  it('délivre un certificat rempli depuis la fiche, avec un numéro par type et par année', async () => {
    const first = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    expect(first.body.number).toBe('CS-2026-2027-0001');
    expect(first.body.status).toBe('ISSUED');
    expect(first.body.class).toBe('4e A');
    expect(first.body.student.matricule).toBe(student.matricule);
    const second = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    expect(second.body.number).toBe('CS-2026-2027-0002');
    const attestation = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'ENROLLMENT_ATTESTATION' })
      .expect(201);
    expect(attestation.body.number).toBe('AI-2026-2027-0001');
    const card = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'STUDENT_CARD' })
      .expect(201);
    expect(card.body.number).toBe('CE-2026-2027-0001');

    const stored = await prisma.adminDocument.findUniqueOrThrow({ where: { id: first.body.id } });
    const data = stored.data as {
      student: { lastName: string; birthPlace: string; photoKey: string | null };
      year: { name: string };
    };
    expect(data.student.lastName).toBe('Essomba');
    expect(data.student.birthPlace).toBe('Yaoundé');
    expect(data.student.photoKey).toBeNull();
    expect(data.year.name).toBe('2026-2027');

    const audit = await prisma.auditLog.findMany({
      where: { entity: 'AdminDocument', action: 'documents.issued' },
    });
    expect(audit).toHaveLength(4);
  });

  it('produit les PDF et trace chaque impression', async () => {
    for (const type of ['SCHOOL_CERTIFICATE', 'ENROLLMENT_ATTESTATION', 'STUDENT_CARD']) {
      const doc = await http()
        .post('/documents')
        .set(s.secretariat.auth)
        .send({ studentId: student.id, type })
        .expect(201);
      const pdf = await http()
        .get(`/documents/${doc.body.id}/pdf`)
        .set(s.secretariat.auth)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect(await prisma.auditLog.count({ where: { action: 'documents.printed' } })).toBe(3);
  });

  it('n’attribue jamais deux fois le même numéro, même pour des demandes simultanées', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        http()
          .post('/documents')
          .set(s.secretariat.auth)
          .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const numbers = results.map((r) => r.body.number as string).sort();
    expect(new Set(numbers).size).toBe(20);
    expect(numbers).toEqual(
      Array.from({ length: 20 }, (_, i) => `CS-2026-2027-${String(i + 1).padStart(4, '0')}`),
    );
  });

  it('vérifie publiquement un document, puis l’affiche comme annulé', async () => {
    const doc = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    const ok = await http().get(`/verify/${doc.body.verificationCode}`).expect(200);
    expect(ok.body).toMatchObject({
      type: 'document',
      documentType: 'SCHOOL_CERTIFICATE',
      label: 'Certificat de scolarité',
      valid: true,
      status: 'ISSUED',
      student: 'ESSOMBA Grâce',
      class: '4e A',
      number: 'CS-2026-2027-0001',
    });

    // Le secrétariat délivre mais n'annule pas ; un motif est exigé.
    await http()
      .post(`/documents/${doc.body.id}/cancel`)
      .set(s.secretariat.auth)
      .send({ reason: 'Erreur de saisie' })
      .expect(403);
    await http()
      .post(`/documents/${doc.body.id}/cancel`)
      .set(s.direction.auth)
      .send({ reason: 'x' })
      .expect(400);
    const cancelled = await http()
      .post(`/documents/${doc.body.id}/cancel`)
      .set(s.direction.auth)
      .send({ reason: 'Erreur sur la classe' })
      .expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    await http()
      .post(`/documents/${doc.body.id}/cancel`)
      .set(s.direction.auth)
      .send({ reason: 'Erreur sur la classe' })
      .expect(409);

    const ko = await http().get(`/verify/${doc.body.verificationCode}`).expect(200);
    expect(ko.body).toMatchObject({ type: 'document', valid: false, status: 'CANCELLED' });
    expect(JSON.stringify(ko.body)).not.toContain('Erreur sur la classe');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'documents.cancelled', entityId: doc.body.id },
    });
    expect(audit.reason).toBe('Erreur sur la classe');

    await http().post(`/documents/${doc.body.id}/duplicate`).set(s.secretariat.auth).expect(409);
    const list = await http()
      .get('/documents?status=CANCELLED')
      .set(s.secretariat.auth)
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].cancelledBy).toBeTruthy();
  });

  it('délivre un duplicata sous un nouveau numéro, en gardant le contenu d’origine', async () => {
    const original = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'STUDENT_CARD' })
      .expect(201);
    // La fiche change après délivrance : le duplicata reproduit l'original figé.
    await http()
      .patch(`/students/${student.id}`)
      .set(s.secretariat.auth)
      .send({ birthPlace: 'Douala' })
      .expect(200);
    const dup = await http()
      .post(`/documents/${original.body.id}/duplicate`)
      .set(s.secretariat.auth)
      .expect(201);
    expect(dup.body.number).toBe('CE-2026-2027-0002');
    expect(dup.body.duplicateOf).toBe('CE-2026-2027-0001');
    const stored = await prisma.adminDocument.findUniqueOrThrow({ where: { id: dup.body.id } });
    expect(stored.duplicateOfId).toBe(original.body.id);
    expect((stored.data as { student: { birthPlace: string } }).student.birthPlace).toBe('Yaoundé');
    const verify = await http().get(`/verify/${dup.body.verificationCode}`).expect(200);
    expect(verify.body).toMatchObject({ valid: true, duplicateOf: 'CE-2026-2027-0001' });
    expect(
      await prisma.auditLog.count({
        where: { action: 'documents.duplicated', entityId: dup.body.id },
      }),
    ).toBe(1);
  });

  it('refuse un élève non inscrit cette année', async () => {
    const other = await enrollStudent(app, s.secretariat, { firstName: 'Luc', lastName: 'Abena' });
    const res = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: other.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(409);
    expect(res.body.message).toMatch(/pas inscrit/);
    expect(await prisma.counter.count({ where: { key: { startsWith: 'document:' } } })).toBe(0);
  });

  it('applique le modèle de l’école sans modifier les documents déjà délivrés', async () => {
    const before = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    await http()
      .put('/documents/templates/SCHOOL_CERTIFICATE')
      .set(s.secretariat.auth)
      .send({ signatoryName: 'M. Abena' })
      .expect(403);
    const saved = await http()
      .put('/documents/templates/SCHOOL_CERTIFICATE')
      .set(s.direction.auth)
      .send({
        signatoryName: 'Mme Ngo Bassa',
        signatoryTitle: 'La Principale',
        headerLines: ['RÉPUBLIQUE DU CAMEROUN', 'Paix – Travail – Patrie', ''],
        mentions: 'Délivré pour constitution de dossier.',
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      customized: true,
      signatoryName: 'Mme Ngo Bassa',
      headerLines: ['RÉPUBLIQUE DU CAMEROUN', 'Paix – Travail – Patrie'],
      title: 'CERTIFICAT DE SCOLARITÉ',
    });
    await http().put('/documents/templates/INCONNU').set(s.direction.auth).send({}).expect(400);
    const templates = await http().get('/documents/templates').set(s.secretariat.auth).expect(200);
    expect(templates.body).toHaveLength(3);
    expect(templates.body.find((t: { type: string }) => t.type === 'STUDENT_CARD').customized).toBe(
      false,
    );

    const after = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    const [oldDoc, newDoc] = await Promise.all([
      prisma.adminDocument.findUniqueOrThrow({ where: { id: before.body.id } }),
      prisma.adminDocument.findUniqueOrThrow({ where: { id: after.body.id } }),
    ]);
    type T = { template: { signatoryName: string | null; signatoryTitle: string } };
    expect((oldDoc.data as T).template.signatoryName).toBeNull();
    expect((newDoc.data as T).template).toMatchObject({
      signatoryName: 'Mme Ngo Bassa',
      signatoryTitle: 'La Principale',
    });
    expect(await prisma.auditLog.count({ where: { action: 'documents.template_updated' } })).toBe(
      1,
    );
  });

  it('interdit de supprimer ou de réécrire un document délivré', async () => {
    const doc = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    await expect(prisma.adminDocument.delete({ where: { id: doc.body.id } })).rejects.toThrow(
      /ne peut pas être supprimé/,
    );
    await expect(
      prisma.adminDocument.update({ where: { id: doc.body.id }, data: { number: 'CS-FAUX' } }),
    ).rejects.toThrow(/figé/);
  });

  it('réserve les documents aux rôles autorisés et au module activé', async () => {
    await http().get('/documents').set(s.prof.auth).expect(403);
    await http().get('/documents').set(s.compta.auth).expect(403);
    await http()
      .post('/documents')
      .set(s.surveillant.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(403);
    await prisma.school.update({
      where: { id: f.schoolId },
      data: { modules: ['students', 'attendance'] },
    });
    await http().get('/documents').set(s.direction.auth).expect(403);
  });
});

describe('isolation des documents entre écoles', () => {
  it('une école ne voit, n’annule ni n’imprime les documents d’une autre et numérote à part', async () => {
    const doc = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    const g = await seedSchool('autre', 'AU');
    await enableDocuments(g.schoolId);
    const o = await sessions(app, 'autre');
    const list = await http().get('/documents').set(o.direction.auth).expect(200);
    expect(list.body.total).toBe(0);
    await http().get(`/documents/${doc.body.id}`).set(o.direction.auth).expect(404);
    await http().get(`/documents/${doc.body.id}/pdf`).set(o.direction.auth).expect(404);
    await http()
      .post(`/documents/${doc.body.id}/cancel`)
      .set(o.direction.auth)
      .send({ reason: 'Tentative inter-écoles' })
      .expect(404);
    await http().post(`/documents/${doc.body.id}/duplicate`).set(o.direction.auth).expect(404);
    // Un élève d'une autre école ne peut pas recevoir de document ici.
    await http()
      .post('/documents')
      .set(o.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(404);
    await http()
      .put('/documents/templates/SCHOOL_CERTIFICATE')
      .set(o.direction.auth)
      .send({ signatoryName: 'Autre direction' })
      .expect(200);
    const mine = await http().get('/documents/templates').set(s.direction.auth).expect(200);
    expect(mine.body[0].signatoryName).toBeNull();

    const otherStudent = await enrollStudent(app, o.secretariat, {
      firstName: 'Awa',
      lastName: 'Bello',
      classId: g.class4AId,
    });
    const theirs = await http()
      .post('/documents')
      .set(o.secretariat.auth)
      .send({ studentId: otherStudent.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    expect(theirs.body.number).toBe('CS-2026-2027-0001');
    const stillOk = await http().get(`/documents/${doc.body.id}`).set(s.direction.auth).expect(200);
    expect(stillOk.body.status).toBe('ISSUED');
  });
});
