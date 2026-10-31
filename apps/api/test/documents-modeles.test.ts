import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { binary, createTestApp, pdfText, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let student: { id: string; matricule: string };
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
  const school = await prisma.school.findUniqueOrThrow({ where: { id: f.schoolId } });
  await prisma.school.update({
    where: { id: f.schoolId },
    data: { modules: [...school.modules, 'documents'] },
  });
  s = await sessions(app);
  student = await enrollStudent(app, s.secretariat, {
    firstName: 'Grâce',
    lastName: 'Essomba',
    classId: f.class4AId,
    gender: 'F',
  });
});

const cardTemplate = {
  title: 'CARTE D’IDENTITÉ SCOLAIRE',
  headerLines: ['MINESEC', 'Délégation régionale du Centre'],
  signatoryName: 'M. Jean Essomba',
  signatoryTitle: 'Le Principal',
  mentions: 'Carte personnelle.',
};

describe('modèles de documents : aperçu et carte d’élève', () => {
  it('affiche un aperçu du modèle saisi sans consommer de numéro du registre', async () => {
    const preview = await http()
      .post('/documents/templates/STUDENT_CARD/preview')
      .set(s.direction.auth)
      .send(cardTemplate)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(preview.headers['content-type']).toBe('application/pdf');
    const text = pdfText(preview.body as Buffer);
    expect(text).toContain('SPÉCIMEN');
    expect(text).toContain('MINESEC · Délégation régionale du Centre');
    expect(text).toContain('M. Jean Essomba');
    expect(text).toContain('CARTE D’IDENTITÉ SCOLAIRE');
    // Ni document, ni compteur, ni modèle enregistré.
    expect(await prisma.adminDocument.count()).toBe(0);
    expect(await prisma.counter.count({ where: { key: { startsWith: 'document:' } } })).toBe(0);
    expect(await prisma.documentTemplate.count()).toBe(0);
    // Réservé à qui configure les modèles.
    await http()
      .post('/documents/templates/STUDENT_CARD/preview')
      .set(s.secretariat.auth)
      .send(cardTemplate)
      .expect(403);
  });

  it('imprime l’en-tête et le nom du signataire sur la carte délivrée', async () => {
    await http()
      .put('/documents/templates/STUDENT_CARD')
      .set(s.direction.auth)
      .send(cardTemplate)
      .expect(200);
    const card = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'STUDENT_CARD' })
      .expect(201);
    const pdf = await http()
      .get(`/documents/${card.body.id}/pdf`)
      .set(s.secretariat.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    const text = pdfText(pdf.body as Buffer);
    expect(text).toContain('MINESEC · Délégation régionale du Centre');
    expect(text).toContain('M. Jean Essomba');
    expect(text).toContain('Le Principal');
    expect(text).not.toContain('SPÉCIMEN');
  });

  it('écrit « Je soussigné(e), le Chef d’établissement » avec une minuscule', async () => {
    const doc = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    const pdf = await http()
      .get(`/documents/${doc.body.id}/pdf`)
      .set(s.secretariat.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    // Texte justifié : les mots sont posés un à un, on compare sans les espaces.
    const text = pdfText(pdf.body as Buffer).replace(/\s+/g, '');
    expect(text).toContain('Jesoussigné(e),leChef');
    expect(text).not.toContain('Jesoussigné(e),LeChef');
  });
});

describe('vérification publique : code recopié à la main', () => {
  it('accepte minuscules, espaces et tirets pour un document et pour un reçu', async () => {
    const doc = await http()
      .post('/documents')
      .set(s.secretariat.auth)
      .send({ studentId: student.id, type: 'SCHOOL_CERTIFICATE' })
      .expect(201);
    const code = doc.body.verificationCode as string;
    const typed = `${code.slice(0, 4).toLowerCase()} ${code.slice(4, 8)}-${code.slice(8).toLowerCase()} `;
    const res = await http()
      .get(`/verify/${encodeURIComponent(typed)}`)
      .expect(200);
    expect(res.body).toMatchObject({ type: 'document', valid: true, number: 'CS-2026-2027-0001' });
    await http().get('/verify/inconnu123').expect(404);

    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const pay = await http()
      .post('/finance/payments')
      .set(s.compta.auth)
      .send({ studentId: student.id, amount: 25000, method: 'CASH', idempotencyKey: randomUUID() })
      .expect(201);
    const receiptCode = (pay.body.receipt.verificationCode as string).toLowerCase();
    const ok = await http()
      .get(`/verify/${encodeURIComponent(` ${receiptCode}`)}`)
      .expect(200);
    expect(ok.body).toMatchObject({ type: 'receipt', valid: true });
  });
});
