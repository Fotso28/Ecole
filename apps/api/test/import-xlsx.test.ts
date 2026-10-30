import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Élèves');
  sheet.addRow([
    'Nom',
    'Prénoms',
    'Sexe',
    'Date naissance',
    'Lieu naissance',
    'Parent nom',
    'Parent prénom',
    'Parent téléphone',
    'Lien',
  ]);
  for (const r of rows) sheet.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
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

describe('import Excel des élèves', () => {
  it('fournit un modèle de fichier relisible', async () => {
    const res = await http()
      .get('/students/import/template.xlsx')
      .set(s.secretariat.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const header = wb.worksheets[0]!.getRow(1).values as string[];
    expect(header.slice(1)).toEqual([
      'nom',
      'prenoms',
      'sexe',
      'date_naissance',
      'lieu_naissance',
      'parent_nom',
      'parent_prenom',
      'parent_telephone',
      'lien',
    ]);
    // Le modèle tel quel passe la vérification.
    const check = await http()
      .post('/students/import/xlsx')
      .set(s.secretariat.auth)
      .attach('file', res.body as Buffer, 'modele.xlsx')
      .field('dryRun', 'true')
      .expect(201);
    expect(check.body).toMatchObject({ total: 1, valid: 1, errors: [], created: 0 });
  });

  it('vérifie ligne par ligne, puis importe avec matricule et inscription', async () => {
    const bad = await workbook([
      [
        'Atangana',
        'Cédric',
        'M',
        new Date(Date.UTC(2013, 6, 4)),
        'Yaoundé',
        'Atangana',
        'Joseph',
        677000101,
        'Père',
      ],
      [],
      ['Bilong', 'Sandrine', '', '12/05/2013', 'Douala', 'Bilong', 'Marthe', '12', 'Mère'],
    ]);
    const report = await http()
      .post('/students/import/xlsx')
      .set(s.secretariat.auth)
      .attach('file', bad, 'eleves.xlsx')
      .field('dryRun', 'true')
      .field('classId', f.class4AId)
      .expect(201);
    expect(report.body.total).toBe(2);
    expect(report.body.valid).toBe(1);
    // Numéro de ligne réel dans le classeur (ligne vide ignorée).
    expect(report.body.errors).toHaveLength(1);
    expect(report.body.errors[0].line).toBe(4);
    expect(report.body.errors[0].messages.join(' ')).toMatch(/téléphone/i);

    // Une erreur restante bloque l'import réel.
    const refused = await http()
      .post('/students/import/xlsx')
      .set(s.secretariat.auth)
      .attach('file', bad, 'eleves.xlsx')
      .field('dryRun', 'false')
      .expect(201);
    expect(refused.body.created).toBe(0);
    expect(await prisma.student.count()).toBe(0);

    const good = await workbook([
      [
        'Atangana',
        'Cédric',
        'M',
        new Date(Date.UTC(2013, 6, 4)),
        'Yaoundé',
        'Atangana',
        'Joseph',
        677000101,
        'Père',
      ],
      ['Bilong', 'Sandrine', 'F', '12/05/2013', 'Douala', 'Bilong', 'Marthe', '699000202', 'Mère'],
    ]);
    const done = await http()
      .post('/students/import/xlsx')
      .set(s.secretariat.auth)
      .attach('file', good, 'eleves.xlsx')
      .field('dryRun', 'false')
      .field('classId', f.class4AId)
      .expect(201);
    expect(done.body).toMatchObject({ total: 2, valid: 2, created: 2 });
    const cedric = await prisma.student.findFirstOrThrow({
      where: { lastName: 'Atangana' },
      include: { enrollments: true, guardians: { include: { guardian: true } } },
    });
    expect(cedric.birthDate.toISOString().slice(0, 10)).toBe('2013-07-04');
    expect(cedric.matricule).toMatch(/^CD-\d{4}-\d{4}$/);
    expect(cedric.enrollments[0]?.classId).toBe(f.class4AId);
    expect(cedric.guardians[0]?.guardian.phone).toBe('+237677000101');
    expect(await prisma.auditLog.count({ where: { action: 'students.imported' } })).toBe(1);

    // Réimporter le même fichier signale les élèves existants.
    const dup = await http()
      .post('/students/import/xlsx')
      .set(s.secretariat.auth)
      .attach('file', good, 'eleves.xlsx')
      .expect(201);
    expect(dup.body.errors[0].messages[0]).toMatch(/Existe déjà/);
  });

  it('refuse un fichier illisible, sans colonne nom ou absent', async () => {
    const res = await http()
      .post('/students/import/xlsx')
      .set(s.secretariat.auth)
      .attach('file', Buffer.from('nom;prenoms\nA;B'), 'eleves.xlsx')
      .expect(400);
    expect(res.body.message).toMatch(/illisible/);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('X').addRow(['autre', 'colonne']);
    const noName = await http()
      .post('/students/import/xlsx')
      .set(s.secretariat.auth)
      .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'x.xlsx')
      .expect(400);
    expect(noName.body.message).toMatch(/Colonne « nom »/);
    await http().post('/students/import/xlsx').set(s.secretariat.auth).expect(400);
  });

  it('réserve l’import au secrétariat et à la direction', async () => {
    const file = await workbook([]);
    await http()
      .post('/students/import/xlsx')
      .set(s.prof.auth)
      .attach('file', file, 'eleves.xlsx')
      .expect(403);
    await http().get('/students/import/template.xlsx').set(s.compta.auth).expect(403);
  });
});
