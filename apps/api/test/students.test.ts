import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, login, prisma, resetDb, type Session } from './helpers';

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

describe('structure académique', () => {
  it('crée une année, ses trimestres et la définit comme année en cours', async () => {
    const year = await http()
      .post('/academic/years')
      .set(s.direction.auth)
      .send({ name: '2027-2028', startDate: '2027-09-06', endDate: '2028-06-30' })
      .expect(201);
    await http()
      .post('/academic/terms')
      .set(s.direction.auth)
      .send({
        academicYearId: year.body.id,
        name: '1er trimestre',
        order: 1,
        startDate: '2027-09-06',
        endDate: '2027-12-17',
        sequences: [
          { name: 'Séquence 1', order: 1 },
          { name: 'Séquence 2', order: 2 },
        ],
      })
      .expect(201);
    await http().post(`/academic/years/${year.body.id}/current`).set(s.direction.auth).expect(201);
    const years = await http().get('/academic/years').set(s.direction.auth).expect(200);
    expect(
      years.body
        .filter((y: { isCurrent: boolean }) => y.isCurrent)
        .map((y: { name: string }) => y.name),
    ).toEqual(['2027-2028']);
    const structure = await http()
      .get(`/academic/years/${year.body.id}/structure`)
      .set(s.direction.auth)
      .expect(200);
    expect(structure.body.terms[0].sequences).toHaveLength(2);
    expect(structure.body.startDate).toBe('2027-09-06');
  });

  it("refuse d'affecter deux fois la même matière à une classe", async () => {
    const res = await http()
      .post('/academic/class-subjects')
      .set(s.censeur.auth)
      .send({ classId: f.class4AId, subjectId: f.subjects.maths, coefficient: 4 })
      .expect(409);
    expect(res.body.message).toMatch(/déjà affectée/);
  });

  it("refuse une affectation qui dépasse la charge horaire maximale de l'enseignant", async () => {
    await prisma.membership.updateMany({
      where: { userId: f.users.teacher },
      data: { maxWeeklyHours: 8 },
    });
    const res = await http()
      .post('/academic/class-subjects')
      .set(s.censeur.auth)
      .send({
        classId: f.class4BId,
        subjectId: f.subjects.svt,
        coefficient: 2,
        teacherId: f.users.teacher,
        weeklyHours: 4,
      })
      .expect(409);
    expect(res.body.message).toBe('Charge horaire maximale dépassée : 9 h pour 8 h autorisées');
  });

  it('interdit la structure académique aux rôles non habilités', async () => {
    await http()
      .post('/academic/classes')
      .set(s.compta.auth)
      .send({ academicYearId: f.yearId, levelId: f.level4Id, name: '4e C' })
      .expect(403);
    await http()
      .post('/academic/classes')
      .set(s.prof.auth)
      .send({ academicYearId: f.yearId, levelId: f.level4Id, name: '4e C' })
      .expect(403);
  });

  it("copie la structure d'une année sur la suivante (assistant de rentrée)", async () => {
    const next = await prisma.academicYear.create({
      data: {
        schoolId: f.schoolId,
        name: '2027-2028',
        startDate: new Date('2027-09-06'),
        endDate: new Date('2028-06-30'),
      },
    });
    const res = await http()
      .post(`/academic/years/${next.id}/rollover`)
      .set(s.direction.auth)
      .send({ fromYearId: f.yearId })
      .expect(201);
    expect(res.body).toEqual({ classes: 3, subjects: 4, feeItems: 5 });
    const fee = await prisma.feeItem.findFirstOrThrow({
      where: { academicYearId: next.id, name: 'Tranche 2' },
    });
    expect(fee.dueDate.toISOString().slice(0, 10)).toBe('2027-11-15');
    await http()
      .post(`/academic/years/${next.id}/rollover`)
      .set(s.direction.auth)
      .send({ fromYearId: f.yearId })
      .expect(409);
  });
});

describe('personnel', () => {
  it('crée un membre du personnel avec plusieurs rôles', async () => {
    const res = await http()
      .post('/staff')
      .set(s.direction.auth)
      .send({
        firstName: 'Paul',
        lastName: 'Mbarga',
        email: 'mbarga@demo.cm',
        password: 'motdepasse-mbarga',
        roles: ['TEACHER', 'SUPERVISOR'],
      })
      .expect(201);
    expect(res.body.roles).toEqual(['TEACHER', 'SUPERVISOR']);
    const list = await http().get('/staff').set(s.direction.auth).expect(200);
    expect(list.body.map((u: { email: string }) => u.email)).toContain('mbarga@demo.cm');
    await http()
      .post('/staff')
      .set(s.prof.auth)
      .send({
        firstName: 'X',
        lastName: 'Y',
        email: 'x@demo.cm',
        password: 'motdepasse-xxxx',
        roles: ['TEACHER'],
      })
      .expect(403);
  });

  it('invite le compte d’une autre école sans rien révéler, rattaché après acceptation', async () => {
    // Une enseignante du collège « autre » a déjà un compte.
    const other = await seedSchool('autre', 'AU');
    await prisma.user.update({
      where: { id: other.users.teacher },
      data: { firstName: 'Béatrice', lastName: 'Essomba', phone: '+237699112233' },
    });
    const res = await http()
      .post('/staff')
      .set(s.direction.auth)
      .send({
        firstName: 'Nom',
        lastName: 'Inventé',
        email: 'prof@autre.cm',
        password: 'motdepasse-ignore',
        roles: ['TEACHER'],
      })
      .expect(201);
    // Ni nom, ni téléphone, ni identifiant du compte existant.
    expect(res.body).toEqual({
      status: 'INVITED',
      email: 'prof@autre.cm',
      roles: ['TEACHER'],
      customRoleIds: [],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/Essomba|699112233/);
    const staff = await http().get('/staff').set(s.direction.auth).expect(200);
    expect(staff.body.map((u: { email: string }) => u.email)).not.toContain('prof@autre.cm');
    expect(
      await prisma.membership.count({
        where: { userId: other.users.teacher, schoolId: f.schoolId },
      }),
    ).toBe(0);
    const pending = await http().get('/staff/invitations').set(s.direction.auth).expect(200);
    expect(pending.body).toEqual([expect.objectContaining({ email: 'prof@autre.cm' })]);
    expect(JSON.stringify(pending.body)).not.toMatch(/Essomba|699112233/);
    // Une seconde demande ne crée pas de doublon.
    await http()
      .post('/staff')
      .set(s.direction.auth)
      .send({
        firstName: 'Nom',
        lastName: 'Inventé',
        email: 'prof@autre.cm',
        password: 'motdepasse-ignore',
        roles: ['TEACHER'],
      })
      .expect(201);
    expect(await prisma.staffInvitation.count()).toBe(1);

    // L'école d'origine ne peut ni annuler ni consulter l'invitation d'une autre école.
    const otherDirection = await login(app, 'direction@autre.cm');
    await http()
      .post(`/staff/invitations/${pending.body[0].id}/cancel`)
      .set(otherDirection.auth)
      .expect(404);

    // À sa connexion, l'enseignante voit l'invitation et l'accepte.
    const prof = await login(app, 'prof@autre.cm');
    const me = await http().get('/auth/me').set(prof.auth).expect(200);
    expect(me.body.invitations).toEqual([
      expect.objectContaining({
        school: expect.objectContaining({ name: 'Collège demo' }),
        roles: ['TEACHER'],
      }),
    ]);
    // Une autre personne ne peut pas y répondre.
    await http()
      .post(`/auth/invitations/${me.body.invitations[0].id}/accept`)
      .set(s.prof.auth)
      .expect(404);
    await http()
      .post(`/auth/invitations/${me.body.invitations[0].id}/accept`)
      .set(prof.auth)
      .expect(201);
    expect(
      await prisma.membership.count({
        where: { userId: other.users.teacher, schoolId: f.schoolId },
      }),
    ).toBe(1);
    const after = await http().get('/staff').set(s.direction.auth).expect(200);
    expect(after.body.map((u: { email: string }) => u.email)).toContain('prof@autre.cm');
    expect(await prisma.auditLog.count({ where: { action: 'staff.invitation_accepted' } })).toBe(1);
    // L'école d'origine ne voit pas les invitations des autres écoles.
    const otherPending = await http()
      .get('/staff/invitations')
      .set(otherDirection.auth)
      .expect(200);
    expect(otherPending.body).toEqual([]);
  });

  it('ne donne aux enseignants que le nom de leurs collègues', async () => {
    const res = await http().get('/staff/teachers').set(s.prof.auth).expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const t of res.body) {
      expect(Object.keys(t).sort()).toEqual(['firstName', 'id', 'lastName', 'maxWeeklyHours']);
    }
  });

  it('empêche le dernier directeur de retirer son propre rôle', async () => {
    await http()
      .patch(`/staff/${f.users.director}/roles`)
      .set(s.direction.auth)
      .send({ roles: ['TEACHER'] })
      .expect(409);
  });

  it('coupe immédiatement l’accès d’un membre désactivé', async () => {
    await http().post(`/staff/${f.users.teacher}/deactivate`).set(s.direction.auth).expect(201);
    await http().get('/grades/class-subjects').set(s.prof.auth).expect(403);
  });
});

describe('inscription des élèves', () => {
  it('attribue un matricule séquentiel et crée parents, pièces et échéancier', async () => {
    const a = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    });
    const b = await enrollStudent(app, s.secretariat, {
      firstName: 'Junior',
      lastName: 'Tchoupo',
      classId: f.class4BId,
    });
    const year = new Date(Date.now() + 3600_000).getUTCFullYear();
    expect(a.matricule).toBe(`CD-${year}-0001`);
    expect(b.matricule).toBe(`CD-${year}-0002`);
    const overview = await http().get(`/students/${a.id}`).set(s.direction.auth).expect(200);
    expect(overview.body.guardians[0]).toMatchObject({
      phone: '+237677123456',
      isPrimary: true,
      relationship: 'FATHER',
    });
    expect(overview.body.documents.map((d: { status: string }) => d.status)).toEqual([
      'MISSING',
      'MISSING',
      'MISSING',
      'MISSING',
    ]);
    expect(overview.body.enrollments[0]).toMatchObject({
      status: 'ENROLLED',
      isCurrent: true,
      class: { name: '4e A' },
    });
    // 25 000 + 70 000 + 50 000 + 30 000 + frais de laboratoire de 4e (10 000)
    expect(overview.body.finance.totals.due).toBe(185000);
    const ledger = await prisma.ledgerEntry.aggregate({
      where: { studentId: a.id },
      _sum: { amount: true },
    });
    expect(ledger._sum.amount).toBe(185000);
  });

  it('applique la grille du niveau : pas de frais de laboratoire en 6e', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Ibrahim',
      lastName: 'Bello',
      classId: f.class6AId,
      gender: 'M',
    });
    const account = await http()
      .get(`/finance/students/${st.id}/account`)
      .set(s.compta.auth)
      .expect(200);
    expect(account.body.totals.due).toBe(175000);
    expect(account.body.lines.map((l: { label: string }) => l.label)).toEqual([
      'Inscription',
      'Tranche 1',
      'Tranche 2',
      'Tranche 3',
    ]);
  });

  it('détecte un doublon probable et permet de passer outre en le journalisant', async () => {
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      birthDate: '2012-03-12',
    });
    const payload = {
      firstName: 'Marie Claire',
      lastName: 'NGONO',
      gender: 'F',
      birthDate: '2012-03-12',
      guardians: [
        {
          firstName: 'Thérèse',
          lastName: 'Abena',
          phone: '699887766',
          relationship: 'MOTHER',
          isPrimary: true,
        },
      ],
    };
    const dup = await http().post('/students').set(s.secretariat.auth).send(payload).expect(409);
    expect(dup.body.code).toBe('POSSIBLE_DUPLICATE');
    expect(dup.body.candidates[0]).toMatchObject({
      lastName: 'Ngono',
      reasons: expect.arrayContaining(['same_name', 'same_birth_date']),
    });
    const created = await http()
      .post('/students')
      .set(s.secretariat.auth)
      .send({ ...payload, confirmNotDuplicate: true })
      .expect(201);
    const log = await prisma.auditLog.findFirst({
      where: { action: 'students.duplicate_dismissed', entityId: created.body.id },
    });
    expect(log).not.toBeNull();
  });

  it('partage la fiche du parent entre frères et sœurs', async () => {
    const a = await enrollStudent(app, s.secretariat, {
      firstName: 'Paul-Henri',
      lastName: 'Ngono',
      classId: f.class6AId,
      phone: '677123456',
      gender: 'M',
    });
    const b = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '+237 677 12 34 56',
    });
    const guardians = await prisma.guardian.findMany({ where: { phone: '+237677123456' } });
    expect(guardians).toHaveLength(1);
    const links = await prisma.studentGuardian.findMany({
      where: { guardianId: guardians[0]!.id },
    });
    expect(links.map((l) => l.studentId).sort()).toEqual([a.id, b.id].sort());
  });

  it('refuse des données invalides avec le détail des champs', async () => {
    const res = await http()
      .post('/students')
      .set(s.secretariat.auth)
      .send({
        firstName: '',
        lastName: 'X',
        gender: 'Z',
        birthDate: '2012-02-30',
        guardians: [{ firstName: 'A', lastName: 'B', phone: '12', relationship: 'FATHER' }],
      })
      .expect(400);
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['firstName', 'gender', 'birthDate', 'guardians.0.phone']),
    );
  });

  it('liste, filtre et recherche les élèves (y compris par téléphone du parent)', async () => {
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    });
    await enrollStudent(app, s.secretariat, {
      firstName: 'Junior',
      lastName: 'Tchoupo',
      classId: f.class4BId,
    });
    await enrollStudent(app, s.secretariat, {
      firstName: 'Grâce',
      lastName: 'Abena',
      classId: f.class4AId,
    });
    const all = await http().get('/students').set(s.direction.auth).expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((i: { lastName: string }) => i.lastName)).toEqual([
      'Abena',
      'Ngono',
      'Tchoupo',
    ]);
    expect(all.body.counts).toEqual({ ENROLLED: 3 });
    const byClass = await http()
      .get(`/students?classId=${f.class4AId}`)
      .set(s.direction.auth)
      .expect(200);
    expect(byClass.body.total).toBe(2);
    const byPhone = await http()
      .get('/students?search=6%2077%2012%2034%2056')
      .set(s.direction.auth)
      .expect(200);
    expect(byPhone.body.items.map((i: { lastName: string }) => i.lastName)).toEqual(['Ngono']);
    const paged = await http().get('/students?pageSize=2&page=2').set(s.direction.auth).expect(200);
    expect(paged.body.items).toHaveLength(1);
  });

  it('limite un enseignant aux élèves de ses classes, sans données financières', async () => {
    const mine = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
    });
    const other = await enrollStudent(app, s.secretariat, {
      firstName: 'Ibrahim',
      lastName: 'Bello',
      classId: f.class6AId,
    });
    const list = await http().get('/students').set(s.prof.auth).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
    expect(list.body.items[0].overdue).toBeNull();
    const detail = await http().get(`/students/${mine.id}`).set(s.prof.auth).expect(200);
    expect(detail.body.finance).toBeNull();
    await http().get(`/students/${other.id}`).set(s.prof.auth).expect(404);
    await http().get(`/finance/students/${mine.id}/account`).set(s.prof.auth).expect(403);
  });

  it("n'expose pas les élèves d'un autre établissement", async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
    });
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    await http().get(`/students/${st.id}`).set(other.direction.auth).expect(404);
    const list = await http().get('/students').set(other.direction.auth).expect(200);
    expect(list.body.total).toBe(0);
    await http()
      .patch(`/students/${st.id}`)
      .set(other.direction.auth)
      .send({ firstName: 'Piraté' })
      .expect(404);
  });

  it('modifie une fiche en gardant la trace avant/après, puis la supprime logiquement', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
    });
    await http()
      .patch(`/students/${st.id}`)
      .set(s.secretariat.auth)
      .send({ birthPlace: 'Douala' })
      .expect(200);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'students.updated', entityId: st.id },
    });
    expect((log.before as { birthPlace: string }).birthPlace).toBe('Yaoundé');
    expect((log.after as { birthPlace: string }).birthPlace).toBe('Douala');
    await http()
      .delete(`/students/${st.id}`)
      .set(s.secretariat.auth)
      .send({ reason: 'Inscription en double' })
      .expect(200);
    await http().get(`/students/${st.id}`).set(s.direction.auth).expect(404);
    expect(await prisma.student.count({ where: { id: st.id } })).toBe(1);
  });

  it('gère redoublement et changement de classe', async () => {
    const st = await enrollStudent(app, s.secretariat, { firstName: 'Brenda', lastName: 'Eyenga' });
    await http()
      .post('/enrollments')
      .set(s.secretariat.auth)
      .send({ studentId: st.id, classId: f.class4AId, status: 'REPEATING' })
      .expect(201);
    await http()
      .post('/enrollments')
      .set(s.secretariat.auth)
      .send({ studentId: st.id, classId: f.class4BId })
      .expect(409);
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { studentId: st.id } });
    await http()
      .patch(`/enrollments/${enrollment.id}`)
      .set(s.secretariat.auth)
      .send({ classId: f.class4BId })
      .expect(200);
    const detail = await http().get(`/students/${st.id}`).set(s.direction.auth).expect(200);
    expect(detail.body.enrollments[0]).toMatchObject({
      status: 'REPEATING',
      class: { name: '4e B' },
    });
  });

  it('suit les pièces du dossier', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
    });
    const detail = await http().get(`/students/${st.id}`).set(s.secretariat.auth).expect(200);
    const doc = detail.body.documents.find((d: { type: string }) => d.type === 'Acte de naissance');
    await http()
      .patch(`/students/${st.id}/documents/${doc.id}`)
      .set(s.secretariat.auth)
      .send({ status: 'RECEIVED' })
      .expect(200);
    const after = await http().get(`/students/${st.id}`).set(s.secretariat.auth).expect(200);
    expect(after.body.documents.find((d: { id: string }) => d.id === doc.id).status).toBe(
      'RECEIVED',
    );
  });
});

describe('import CSV', () => {
  const csv = [
    'nom;prenoms;sexe;date_naissance;lieu_naissance;parent_nom;parent_prenom;parent_telephone;lien',
    'Atangana;Cédric;M;04/07/2013;Yaoundé;Atangana;Joseph;677000101;Père',
    'Bilong;Estelle;F;2012-11-02;Douala;Bilong;Rose;699000102;Mère',
  ].join('\n');

  it('prévisualise sans rien enregistrer puis importe', async () => {
    const preview = await http()
      .post('/students/import')
      .set(s.secretariat.auth)
      .send({ csv, classId: f.class4AId, dryRun: true })
      .expect(201);
    expect(preview.body).toMatchObject({ total: 2, valid: 2, errors: [], created: 0 });
    expect(await prisma.student.count()).toBe(0);
    const done = await http()
      .post('/students/import')
      .set(s.secretariat.auth)
      .send({ csv, classId: f.class4AId, dryRun: false })
      .expect(201);
    expect(done.body.created).toBe(2);
    const enrolled = await prisma.enrollment.count({ where: { classId: f.class4AId } });
    expect(enrolled).toBe(2);
    const cedric = await prisma.student.findFirstOrThrow({ where: { firstName: 'Cédric' } });
    expect(cedric.birthDate.toISOString().slice(0, 10)).toBe('2013-07-04');
  });

  it('rapporte les erreurs ligne par ligne et refuse un import partiel', async () => {
    const bad = [
      'nom;prenoms;sexe;date_naissance;lieu_naissance;parent_nom;parent_prenom;parent_telephone;lien',
      'Atangana;Cédric;M;04/07/2013;Yaoundé;Atangana;Joseph;677000101;Père',
      ';Sans nom;F;2012-01-01;;X;Y;699000103;Mère',
      'Owona;Patricia;F;31/02/2012;;Owona;Luc;123;Père',
      'Atangana;Cédric;M;04/07/2013;Yaoundé;Atangana;Joseph;677000101;Père',
    ].join('\n');
    const res = await http()
      .post('/students/import')
      .set(s.secretariat.auth)
      .send({ csv: bad, dryRun: false })
      .expect(201);
    expect(res.body.total).toBe(4);
    expect(res.body.created).toBe(0);
    expect(res.body.errors.map((e: { line: number }) => e.line)).toEqual([3, 4, 5]);
    expect(res.body.errors[2].messages).toEqual(['Doublon de la ligne 2']);
    expect(await prisma.student.count()).toBe(0);
  });
});

describe('fiche santé', () => {
  let nurse: Session;
  beforeEach(async () => {
    const { createStaff, login } = await import('./helpers');
    await createStaff(f.schoolId, 'infirmerie@demo.cm', ['NURSE']);
    nurse = await login(app, 'infirmerie@demo.cm');
  });

  it('chiffre la fiche, exige un motif et journalise chaque consultation', async () => {
    const st = await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
    });
    await http()
      .put(`/students/${st.id}/health`)
      .set(nurse.auth)
      .send({ allergies: 'Arachide' })
      .expect(200);
    const stored = await prisma.healthRecord.findUniqueOrThrow({ where: { studentId: st.id } });
    expect(stored.encryptedPayload).not.toContain('Arachide');
    await http().get(`/students/${st.id}/health`).set(nurse.auth).expect(400);
    const read = await http()
      .get(`/students/${st.id}/health?reason=Malaise%20en%20cours%20d%27EPS`)
      .set(nurse.auth)
      .expect(200);
    expect(read.body.allergies).toBe('Arachide');
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'health.read', entityId: st.id },
    });
    expect(log.reason).toBe("Malaise en cours d'EPS");
    await http()
      .get(`/students/${st.id}/health?reason=curiosite`)
      .set(s.direction.auth)
      .expect(403);
  });
});
