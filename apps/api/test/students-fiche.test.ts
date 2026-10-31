import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

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

const newStudent = (guardian: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  firstName: 'Brice Junior',
  lastName: 'Ngono',
  gender: 'M',
  birthDate: '2016-09-09',
  classId: f.class6AId,
  guardians: [{ relationship: 'FATHER', isPrimary: true, ...guardian }],
  ...extra,
});

describe('inscription : numéro de parent déjà connu', () => {
  async function pierreNgono() {
    return http()
      .post('/students')
      .set(s.secretariat.auth)
      .send({
        firstName: 'Marie-Claire',
        lastName: 'Ngono',
        gender: 'F',
        birthDate: '2012-03-12',
        classId: f.class4AId,
        guardians: [
          {
            firstName: 'Pierre',
            lastName: 'Ngono',
            phone: '677123456',
            relationship: 'FATHER',
            isPrimary: true,
          },
        ],
      })
      .expect(201);
  }

  it('refuse le rattachement silencieux quand le nom diffère, puis rattache sur choix explicite', async () => {
    const sister = await pierreNgono();
    const known = await http()
      .post('/students/check-guardian-phones')
      .set(s.secretariat.auth)
      .send({ phones: ['6 77 12 34 56', '699000000'] })
      .expect(201);
    expect(known.body).toEqual([
      expect.objectContaining({
        phone: '+237677123456',
        firstName: 'Pierre',
        lastName: 'Ngono',
        label: 'Pierre Ngono (parent de Marie-Claire)',
      }),
    ]);

    const refused = await http()
      .post('/students')
      .set(s.secretariat.auth)
      .send(newStudent({ firstName: 'Jacques', lastName: 'Ngono', phone: '677123456' }))
      .expect(409);
    expect(refused.body).toMatchObject({
      code: 'GUARDIAN_PHONE_TAKEN',
      message:
        'Ce numéro appartient déjà à Pierre Ngono (parent de Marie-Claire). Rattachez l’élève à ce parent ou corrigez le numéro.',
      conflicts: [
        {
          index: 0,
          phone: '+237677123456',
          existing: { firstName: 'Pierre', lastName: 'Ngono' },
        },
      ],
    });
    expect(await prisma.student.count()).toBe(1);

    const linked = await http()
      .post('/students')
      .set(s.secretariat.auth)
      .send(
        newStudent({
          firstName: 'Jacques',
          lastName: 'Ngono',
          phone: '677123456',
          linkExistingGuardian: true,
        }),
      )
      .expect(201);
    const overview = await http().get(`/students/${linked.body.id}`).set(s.direction.auth);
    // Le parent existant garde son identité : jamais de renommage d'un autre parent.
    expect(overview.body.guardians[0]).toMatchObject({ firstName: 'Pierre', lastName: 'Ngono' });
    const guardians = await prisma.guardian.findMany();
    expect(guardians).toHaveLength(1);
    const links = await prisma.studentGuardian.findMany({
      where: { guardianId: guardians[0]!.id },
    });
    expect(links.map((l) => l.studentId).sort()).toEqual([sister.body.id, linked.body.id].sort());
  });

  it('rattache sans question un frère ou une sœur quand le nom du parent est le même', async () => {
    await pierreNgono();
    // Accents, casse et ordre des mots ne comptent pas.
    await http()
      .post('/students')
      .set(s.secretariat.auth)
      .send(newStudent({ firstName: 'NGONO', lastName: 'pierre', phone: '+237 677 12 34 56' }))
      .expect(201);
    expect(await prisma.guardian.count()).toBe(1);
  });

  it('applique la même règle à l’ajout d’un parent depuis la fiche', async () => {
    await pierreNgono();
    const other = await enrollStudent(app, s.secretariat, {
      firstName: 'Junior',
      lastName: 'Tchoupo',
      classId: f.class4BId,
    });
    const res = await http()
      .post(`/students/${other.id}/guardians`)
      .set(s.secretariat.auth)
      .send({ firstName: 'Paul', lastName: 'Tchoupo', phone: '677123456', relationship: 'TUTOR' })
      .expect(409);
    expect(res.body.code).toBe('GUARDIAN_PHONE_TAKEN');
  });

  it('affiche les erreurs de validation en français', async () => {
    const res = await http()
      .post('/students')
      .set(s.secretariat.auth)
      .send(
        newStudent(
          { firstName: 'Jean-Paul', lastName: 'Mballa', phone: '699112233', email: 'jp.mballa@' },
          { birthDate: '' },
        ),
      )
      .expect(400);
    const errors = Object.fromEntries(
      res.body.errors.map((e: { path: string; message: string }) => [e.path, e.message]),
    );
    expect(errors['guardians.0.email']).toBe('Adresse e-mail invalide');
    expect(errors.birthDate).toBe('Champ obligatoire');
    expect(JSON.stringify(res.body)).not.toMatch(/Invalid|Required|Expected/);
  });
});

describe('fiche élève : changement de classe, transfert, sortie, identité', () => {
  async function enrollmentOf(studentId: string) {
    return prisma.enrollment.findFirstOrThrow({ where: { studentId } });
  }

  it('enregistre un transfert vers un autre établissement, visible dans le filtre « Transférés »', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Aurélie Grâce',
      lastName: 'Mballa',
      classId: f.class4AId,
    });
    const enrollment = await enrollmentOf(st.id);
    const missing = await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.secretariat.auth)
      .send({ status: 'TRANSFERRED', exitDate: '2026-10-30', exitReason: 'Mutation du père' })
      .expect(400);
    expect(missing.body.errors).toEqual([
      { path: 'destinationSchool', message: 'Indiquez l’établissement d’accueil' },
    ]);
    const outside = await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.secretariat.auth)
      .send({
        status: 'TRANSFERRED',
        exitDate: '2026-08-01',
        exitReason: 'Mutation du père',
        destinationSchool: 'Lycée de Garoua',
      })
      .expect(400);
    expect(outside.body.errors[0].message).toBe(
      'La date de sortie doit se situer dans l’année scolaire 2026-2027',
    );
    await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.secretariat.auth)
      .send({
        status: 'TRANSFERRED',
        exitDate: '2026-10-30',
        exitReason: 'Mutation du père',
        destinationSchool: 'Lycée de Garoua',
      })
      .expect(200);

    const transferred = await http()
      .get('/students?status=TRANSFERRED')
      .set(s.secretariat.auth)
      .expect(200);
    expect(transferred.body.items.map((i: { id: string }) => i.id)).toEqual([st.id]);
    expect(transferred.body.counts).toMatchObject({ TRANSFERRED: 1 });
    const overview = await http().get(`/students/${st.id}`).set(s.secretariat.auth).expect(200);
    expect(overview.body.enrollments[0]).toMatchObject({
      status: 'TRANSFERRED',
      exitDate: '2026-10-30',
      exitReason: 'Mutation du père',
      destinationSchool: 'Lycée de Garoua',
    });
    // Motif réservé à qui gère les inscriptions (le censeur voit la sortie, pas son motif).
    const censorView = await http().get(`/students/${st.id}`).set(s.censeur.auth).expect(200);
    expect(censorView.body.enrollments[0]).toMatchObject({
      exitDate: '2026-10-30',
      exitReason: null,
      destinationSchool: 'Lycée de Garoua',
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'enrollments.transferred', entityId: enrollment.id },
    });
    expect(audit.reason).toBe('Mutation du père');
    expect(audit.after).toMatchObject({
      status: 'TRANSFERRED',
      destinationSchool: 'Lycée de Garoua',
      exitDate: '2026-10-30',
    });
    // L'élève transféré quitte la liste d'appel de sa classe.
    const roster = await http()
      .get(`/students?classId=${f.class4AId}&status=ENROLLED`)
      .set(s.secretariat.auth);
    expect(roster.body.items).toHaveLength(0);
  });

  it('enregistre une sortie, interdit alors le changement de classe, puis réintègre', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Kevin',
      lastName: 'Tchana',
      classId: f.class4AId,
    });
    const enrollment = await enrollmentOf(st.id);
    await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.secretariat.auth)
      .send({ status: 'LEFT', exitDate: '2026-10-15', exitReason: 'Départ à l’étranger' })
      .expect(200);
    const left = await http().get('/students?status=LEFT').set(s.secretariat.auth).expect(200);
    expect(left.body.items.map((i: { id: string }) => i.id)).toEqual([st.id]);
    const stored = await enrollmentOf(st.id);
    expect(stored.destinationSchool).toBeNull();
    await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.secretariat.auth)
      .send({ classId: f.class4BId })
      .expect(409);
    await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.secretariat.auth)
      .send({ status: 'ENROLLED' })
      .expect(200);
    const back = await enrollmentOf(st.id);
    expect(back).toMatchObject({ status: 'ENROLLED', exitDate: null, exitReason: null });
    expect(
      await prisma.auditLog.count({
        where: { action: { in: ['enrollments.left', 'enrollments.reinstated'] } },
      }),
    ).toBe(2);
  });

  it('change de classe en cours d’année avec trace de l’ancienne et de la nouvelle classe', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Estelle',
      lastName: 'Bilong',
      classId: f.class4AId,
    });
    const enrollment = await enrollmentOf(st.id);
    await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.secretariat.auth)
      .send({ classId: f.class4BId })
      .expect(200);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'enrollments.class_changed', entityId: enrollment.id },
    });
    expect(audit.before).toMatchObject({ className: '4e A', classId: f.class4AId });
    expect(audit.after).toMatchObject({ className: '4e B', classId: f.class4BId });
  });

  it('réserve ces changements au secrétariat et à la direction, dans leur établissement', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Estelle',
      lastName: 'Bilong',
      classId: f.class4AId,
    });
    const enrollment = await enrollmentOf(st.id);
    const body = { status: 'LEFT', exitDate: '2026-10-15', exitReason: 'Déménagement' };
    await http().patch(`/enrollments/${enrollment.id}`).set(s.prof.auth).send(body).expect(403);
    await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.surveillant.auth)
      .send(body)
      .expect(403);
    await http()
      .patch(`/students/${st.id}`)
      .set(s.surveillant.auth)
      .send({ firstName: 'X' })
      .expect(403);
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(other.direction.auth)
      .send(body)
      .expect(404);
    expect((await enrollmentOf(st.id)).status).toBe('ENROLLED');
  });

  it('corrige l’identité et ne journalise que les champs modifiés', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Aurelie',
      lastName: 'Mbala',
      classId: f.class4AId,
      gender: 'M',
    });
    await http()
      .patch(`/students/${st.id}`)
      .set(s.secretariat.auth)
      .send({
        lastName: 'Mballa',
        firstName: 'Aurélie Grâce',
        gender: 'F',
        birthDate: '2012-05-04',
        birthPlace: '',
      })
      .expect(200);
    const overview = await http().get(`/students/${st.id}`).set(s.secretariat.auth).expect(200);
    expect(overview.body).toMatchObject({
      lastName: 'Mballa',
      firstName: 'Aurélie Grâce',
      gender: 'F',
      birthDate: '2012-05-04',
      birthPlace: null,
    });
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'students.updated', entityId: st.id },
    });
    expect(log.before).toMatchObject({ lastName: 'Mbala', gender: 'M', birthPlace: 'Yaoundé' });
    expect(log.after).toEqual({
      lastName: 'Mballa',
      firstName: 'Aurélie Grâce',
      gender: 'F',
      birthDate: '2012-05-04',
      birthPlace: null,
    });
    const invalid = await http()
      .patch(`/students/${st.id}`)
      .set(s.secretariat.auth)
      .send({ lastName: '', birthDate: '2012-02-30' })
      .expect(400);
    expect(invalid.body.errors).toEqual(
      expect.arrayContaining([
        { path: 'lastName', message: 'Champ obligatoire' },
        { path: 'birthDate', message: 'Date invalide' },
      ]),
    );
  });

  it('marque la pièce « Photo d’identité » fournie quand la photo est déposée', async () => {
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
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    await http()
      .post(`/students/${st.id}/photo`)
      .set(s.secretariat.auth)
      .attach('file', png, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);
    const overview = await http().get(`/students/${st.id}`).set(s.secretariat.auth).expect(200);
    const pieces = Object.fromEntries(
      overview.body.documents.map((d: { type: string; status: string }) => [d.type, d.status]),
    );
    expect(pieces['Photo d’identité']).toBe('RECEIVED');
    expect(pieces['Acte de naissance']).toBe('MISSING');
    expect(
      await prisma.auditLog.count({
        where: { action: 'students.document', reason: 'Photo d’identité déposée' },
      }),
    ).toBe(1);
  });
});

describe('recherche d’élèves', () => {
  beforeEach(async () => {
    for (const [lastName, firstName, classId] of [
      ['Kouam', 'Cédric', f.class4AId],
      ['Mballa', 'Aurélie Grâce', f.class4AId],
      ['Ngono', 'Paul-Henri', f.class6AId],
      ['Ngono', 'Marie-Claire', f.class4AId],
      ['Ékotto', 'Mireille', f.class4BId],
    ] as const)
      await enrollStudent(app, s.secretariat, { firstName, lastName, classId });
  });

  const names = async (search: string, auth = s.secretariat.auth) => {
    const res = await http()
      .get(`/students?search=${encodeURIComponent(search)}`)
      .set(auth)
      .expect(200);
    return res.body.items.map((i: { lastName: string; firstName: string }) =>
      `${i.lastName} ${i.firstName}`.trim(),
    );
  };

  it('ignore accents et casse, et accepte « nom prénom » dans les deux ordres', async () => {
    expect(await names('Cedric')).toEqual(['Kouam Cédric']);
    expect(await names('AURELIE')).toEqual(['Mballa Aurélie Grâce']);
    expect(await names('mballa aurélie')).toEqual(['Mballa Aurélie Grâce']);
    expect(await names('Aurelie Mballa')).toEqual(['Mballa Aurélie Grâce']);
    expect(await names('Ngono Paul')).toEqual(['Ngono Paul-Henri']);
    expect(await names('paul henri')).toEqual(['Ngono Paul-Henri']);
    expect(await names('Kouam Cédric')).toEqual(['Kouam Cédric']);
    expect(await names('ekotto')).toEqual(['Ékotto Mireille']);
    expect(await names('Ngono')).toEqual(['Ngono Marie-Claire', 'Ngono Paul-Henri']);
    expect(await names('Kouam Paul')).toEqual([]);
    // Caractères spéciaux sans effet de motif.
    expect(await names('%')).toEqual([]);
    expect(await names('_')).toEqual([]);
  });

  it('cherche aussi par matricule, et garde la limite de l’enseignant à ses classes', async () => {
    const st = await prisma.student.findFirstOrThrow({ where: { lastName: 'Kouam' } });
    expect(await names(st.matricule.toLowerCase())).toEqual(['Kouam Cédric']);
    // Professeur de 4e A : Ngono Paul-Henri (6e A) reste invisible.
    expect(await names('ngono', s.prof.auth)).toEqual(['Ngono Marie-Claire']);
  });

  it('ne trouve rien dans un autre établissement (Row-Level Security)', async () => {
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    expect(await names('cedric', other.direction.auth)).toEqual([]);
  });
});

describe('import : rapport en français', () => {
  const header =
    'nom;prenoms;sexe;date_naissance;lieu_naissance;parent_nom;parent_prenom;parent_telephone;lien';

  it('nomme les colonnes et affiche la valeur lue, sans message technique', async () => {
    const csv = [
      header,
      'Essomba;Brice;M;04/07/2013;Yaoundé;Essomba;Joseph;677000101;Père',
      'Tchoumi;Arielle;X;31/02/2013;;Tchoumi;Luc;12345;Tonton',
      ';;;;;;;;',
      'Onana;Sandrine;;;;;Rose;699000102;Mère',
    ].join('\n');
    const res = await http()
      .post('/students/import')
      .set(s.secretariat.auth)
      .send({ csv, classId: f.class4AId, dryRun: true })
      .expect(201);
    expect(res.body.errors).toEqual([
      {
        line: 3,
        messages: [
          'Sexe : indiquez F ou M (valeur lue : X)',
          'Date de naissance : date invalide, attendue au format JJ/MM/AAAA (valeur lue : 31/02/2013)',
          'Téléphone du parent : numéro de téléphone camerounais invalide (valeur lue : 12345)',
        ],
      },
      {
        line: 5,
        messages: [
          'Sexe : champ obligatoire',
          'Date de naissance : champ obligatoire',
          'Nom du parent : champ obligatoire',
        ],
      },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /Invalid|Expected|received|gender|birthDate|guardians|\(phone\)/,
    );
  });

  it('signale un numéro de parent déjà attribué à un autre parent, en base ou dans le fichier', async () => {
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    });
    const csv = [
      header,
      'Essomba;Brice;M;04/07/2013;Yaoundé;Essomba;Joseph;677123456;Père',
      'Ngono;Brice;M;04/07/2014;Yaoundé;Ngono;Parent;677123456;Père',
      'Atangana;Cédric;M;04/07/2013;;Atangana;Joseph;699000101;Père',
      'Atangana;Line;F;05/08/2014;;Abena;Rose;699000101;Mère',
    ].join('\n');
    const res = await http()
      .post('/students/import')
      .set(s.secretariat.auth)
      .send({ csv, dryRun: false })
      .expect(201);
    expect(res.body.created).toBe(0);
    expect(res.body.errors).toEqual([
      {
        line: 2,
        messages: [
          'Téléphone du parent : ce numéro appartient déjà à Parent Ngono (parent de Marie-Claire) ; reprenez le nom de ce parent ou corrigez le numéro',
        ],
      },
      {
        line: 5,
        messages: [
          'Téléphone du parent : même numéro qu’à la ligne 4, pour un autre parent (Joseph Atangana)',
        ],
      },
    ]);
  });
});

describe('structure : coefficient et retrait d’une matière de classe', () => {
  it('corrige un coefficient, retire une affectation vide et protège celle qui a des notes', async () => {
    await http()
      .patch(`/academic/class-subjects/${f.cs.maths4B}`)
      .set(s.censeur.auth)
      .send({ coefficient: 5 })
      .expect(200);
    expect(
      (await prisma.classSubject.findUniqueOrThrow({ where: { id: f.cs.maths4B } })).coefficient,
    ).toBe(5);
    await http()
      .delete(`/academic/class-subjects/${f.cs.maths4B}`)
      .set(s.secretariat.auth)
      .expect(403);
    await http().delete(`/academic/class-subjects/${f.cs.maths4B}`).set(s.censeur.auth).expect(200);
    expect(await prisma.classSubject.count({ where: { id: f.cs.maths4B } })).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'academic.subject_removed', entityId: f.cs.maths4B },
    });
    expect(audit.before).toMatchObject({ coefficient: 5 });

    await prisma.evaluation.create({
      data: {
        schoolId: f.schoolId,
        classSubjectId: f.cs.maths4A,
        sequenceId: f.seq1Id,
        name: 'Interrogation 1',
        type: 'QUIZ',
        weight: 1,
        createdById: f.users.teacher,
      },
    });
    const refused = await http()
      .delete(`/academic/class-subjects/${f.cs.maths4A}`)
      .set(s.censeur.auth)
      .expect(409);
    expect(refused.body.message).toBe(
      'Impossible de retirer Mathématiques (4e A) : des évaluations y sont déjà saisies',
    );
    expect(await prisma.evaluation.count()).toBe(1);

    // Cloisonnement : une autre école ne retire rien.
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    await http()
      .delete(`/academic/class-subjects/${f.cs.francais4A}`)
      .set(other.direction.auth)
      .expect(404);
    expect(await prisma.classSubject.count({ where: { id: f.cs.francais4A } })).toBe(1);
  });
});
