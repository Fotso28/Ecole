import type { INestApplication } from '@nestjs/common';
import { LOCKED_DIRECTOR_PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '@ecole/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createStaff, createTestApp, login, prisma, resetDb, type Session } from './helpers';

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

const without = (list: readonly Permission[], ...removed: Permission[]) =>
  list.filter((p) => !removed.includes(p));

async function createRole(
  session: Session,
  body: {
    name: string;
    permissions: Permission[];
    classScoped?: boolean;
    lineScoped?: boolean;
  },
) {
  const res = await http().post('/roles/custom').set(session.auth).send(body).expect(201);
  return res.body.id as string;
}

/** Membre du personnel n'ayant qu'un rôle propre à l'école. */
async function staffWithCustomRole(email: string, customRoleIds: string[]) {
  const res = await http()
    .post('/staff')
    .set(s.direction.auth)
    .send({
      firstName: 'Awa',
      lastName: 'Ndi',
      email,
      password: 'motdepasse-test-1',
      customRoleIds,
    })
    .expect(201);
  return { id: res.body.id as string, session: await login(app, email) };
}

describe('rôles intégrés ajustés par l’école', () => {
  it('liste les rôles avec les valeurs par défaut du code', async () => {
    const res = await http().get('/roles').set(s.direction.auth).expect(200);
    const secretary = res.body.builtin.find((r: { key: string }) => r.key === 'SECRETARY');
    expect(secretary).toMatchObject({
      name: 'Secrétariat',
      customized: false,
      members: 1,
      adminAccess: true,
    });
    expect(secretary.permissions).toEqual(secretary.defaults);
    const director = res.body.builtin.find((r: { key: string }) => r.key === 'DIRECTOR');
    expect(director.locked).toEqual([...LOCKED_DIRECTOR_PERMISSIONS]);
    // Le censeur voit les rôles (gestion du personnel en lecture) sans pouvoir les modifier.
    await http().get('/roles').set(s.censeur.auth).expect(200);
    await http()
      .put('/roles/builtin/SECRETARY')
      .set(s.censeur.auth)
      .send({ permissions: [] })
      .expect(403);
    await http().get('/roles').set(s.prof.auth).expect(403);
  });

  it('refuse l’accès dès le retrait d’une permission, puis rétablit les valeurs par défaut', async () => {
    await http().get('/students').set(s.secretariat.auth).expect(200);
    const before = await http().get('/auth/me').set(s.secretariat.auth).expect(200);
    expect(before.body.permissions).toContain('students.read');

    const updated = await http()
      .put('/roles/builtin/SECRETARY')
      .set(s.direction.auth)
      .send({
        permissions: [...without(ROLE_PERMISSIONS.SECRETARY, 'students.read'), 'discipline.read'],
      })
      .expect(200);
    expect(updated.body.permissions).not.toContain('students.read');

    // Même jeton : la modification s'applique dès la requête suivante (cache invalidé).
    await http().get('/students').set(s.secretariat.auth).expect(403);
    await http().get('/discipline/incidents').set(s.secretariat.auth).expect(200);
    const after = await http().get('/auth/me').set(s.secretariat.auth).expect(200);
    expect(after.body.permissions).not.toContain('students.read');
    expect(after.body.permissions).toContain('discipline.read');

    const list = await http().get('/roles').set(s.direction.auth).expect(200);
    expect(list.body.builtin.find((r: { key: string }) => r.key === 'SECRETARY')).toMatchObject({
      customized: true,
    });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'roles.builtin_updated', entityId: 'SECRETARY' },
    });
    expect((audit.before as { permissions: string[] }).permissions).toContain('students.read');
    expect((audit.after as { permissions: string[] }).permissions).not.toContain('students.read');
    expect(audit.actorId).toBe(f.users.director);

    await http().post('/roles/builtin/SECRETARY/reset').set(s.direction.auth).expect(201);
    await http().get('/students').set(s.secretariat.auth).expect(200);
    expect(await prisma.roleOverride.count()).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'roles.builtin_reset', entityId: 'SECRETARY' },
      }),
    ).toBe(1);
  });

  it('invalide le cache à chaque modification', async () => {
    const version = async () =>
      (await prisma.school.findUniqueOrThrow({ where: { id: f.schoolId } })).rolesVersion;
    const v0 = await version();
    const perms = async () =>
      (await http().get('/auth/me').set(s.surveillant.auth).expect(200)).body
        .permissions as string[];
    expect(await perms()).toContain('attendance.justify');
    await http()
      .put('/roles/builtin/SUPERVISOR')
      .set(s.direction.auth)
      .send({ permissions: without(ROLE_PERMISSIONS.SUPERVISOR, 'attendance.justify') })
      .expect(200);
    expect(await version()).toBe(v0 + 1);
    expect(await perms()).not.toContain('attendance.justify');
    await http()
      .put('/roles/builtin/SUPERVISOR')
      .set(s.direction.auth)
      .send({ permissions: [...ROLE_PERMISSIONS.SUPERVISOR] })
      .expect(200);
    expect(await version()).toBe(v0 + 2);
    expect(await perms()).toContain('attendance.justify');
    // Revenir aux valeurs par défaut supprime l'adaptation.
    expect(await prisma.roleOverride.count()).toBe(0);
  });

  it('ne retire jamais à la direction la gestion du personnel, des rôles et des réglages', async () => {
    for (const p of LOCKED_DIRECTOR_PERMISSIONS) {
      await http()
        .put('/roles/builtin/DIRECTOR')
        .set(s.direction.auth)
        .send({ permissions: without(ROLE_PERMISSIONS.DIRECTOR, p) })
        .expect(409);
    }
    // Les autres droits de la direction restent ajustables.
    await http()
      .put('/roles/builtin/DIRECTOR')
      .set(s.direction.auth)
      .send({ permissions: without(ROLE_PERMISSIONS.DIRECTOR, 'finance.payments.create') })
      .expect(200);
    await http().post('/finance/cash-sessions/open').set(s.direction.auth).expect(403);
    await http().get('/roles').set(s.direction.auth).expect(200);
    await http().get('/settings').set(s.direction.auth).expect(200);
  });
});

describe('rôles propres à l’école', () => {
  it('crée un rôle, l’attribue et journalise chaque modification', async () => {
    const id = await createRole(s.direction, {
      name: 'Bibliothécaire',
      permissions: ['students.read', 'library.read', 'library.loans'],
    });
    const libr = await staffWithCustomRole('biblio@demo.cm', [id]);
    const me = await http().get('/auth/me').set(libr.session.auth).expect(200);
    expect(me.body.roles).toEqual([]);
    expect(me.body.customRoles).toEqual([{ id, name: 'Bibliothécaire' }]);
    expect([...me.body.permissions].sort()).toEqual(
      ['library.loans', 'library.read', 'students.read'].sort(),
    );
    expect(me.body.adminAccess).toBe(false);
    await http().get('/students').set(libr.session.auth).expect(200);
    await http().get('/finance/cash-sessions').set(libr.session.auth).expect(403);

    // Nom déjà pris, nom d'un rôle intégré.
    await http()
      .post('/roles/custom')
      .set(s.direction.auth)
      .send({ name: 'Bibliothécaire', permissions: ['library.read'] })
      .expect(409);
    await http()
      .post('/roles/custom')
      .set(s.direction.auth)
      .send({ name: 'enseignant', permissions: ['library.read'] })
      .expect(409);

    await http()
      .put(`/roles/custom/${id}`)
      .set(s.direction.auth)
      .send({ name: 'Bibliothécaire', permissions: ['library.read', 'library.loans'] })
      .expect(200);
    await http().get('/students').set(libr.session.auth).expect(403);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'roles.custom_updated', entityId: id },
    });
    expect(audit.before).toMatchObject({
      permissions: ['students.read', 'library.read', 'library.loans'],
    });
    expect(audit.after).toMatchObject({ permissions: ['library.read', 'library.loans'] });

    const staff = await http().get('/staff').set(s.direction.auth).expect(200);
    expect(staff.body.find((u: { id: string }) => u.id === libr.id).customRoleIds).toEqual([id]);

    // Suppression refusée tant que le rôle est attribué.
    await http().delete(`/roles/custom/${id}`).set(s.direction.auth).expect(409);
    await http()
      .patch(`/staff/${libr.id}/roles`)
      .set(s.direction.auth)
      .send({ roles: ['SECRETARY'], customRoleIds: [] })
      .expect(200);
    await http().delete(`/roles/custom/${id}`).set(s.direction.auth).expect(200);
    expect(await prisma.customRole.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'roles.custom_deleted' } })).toBe(1);
  });

  it('un rôle propre « limité à ses classes » ne voit que ses classes, même cumulé', async () => {
    const a = await enrollStudent(app, s.secretariat, {
      firstName: 'Alice',
      lastName: 'Atangana',
      classId: f.class4AId,
    });
    const b = await enrollStudent(app, s.secretariat, {
      firstName: 'Bruno',
      lastName: 'Biya',
      classId: f.class4BId,
    });
    const id = await createRole(s.direction, {
      name: 'Répétiteur',
      permissions: ['students.read', 'grades.read'],
      classScoped: true,
    });
    const tutor = await staffWithCustomRole('repetiteur@demo.cm', [id]);
    await prisma.class.update({ where: { id: f.class4BId }, data: { mainTeacherId: tutor.id } });
    const me = await http().get('/auth/me').set(tutor.session.auth).expect(200);
    expect(me.body.scopes).toEqual({ classes: true, lines: false });

    const ids = async (session: Session) =>
      (await http().get('/students').set(session.auth).expect(200)).body.items.map(
        (x: { id: string }) => x.id,
      );
    expect(await ids(tutor.session)).toEqual([b.id]);
    await http().get(`/students/${a.id}`).set(tutor.session.auth).expect(404);

    // Cumulé avec le rôle enseignant, la limite reste : aucun rôle sans limite n'accorde la lecture.
    await http()
      .patch(`/staff/${tutor.id}/roles`)
      .set(s.direction.auth)
      .send({ roles: ['TEACHER'] })
      .expect(200);
    expect(await ids(tutor.session)).toEqual([b.id]);

    // Sans la limite, la personne voit tous les élèves.
    await http()
      .put(`/roles/custom/${id}`)
      .set(s.direction.auth)
      .send({ name: 'Répétiteur', permissions: ['students.read', 'grades.read'] })
      .expect(200);
    expect((await ids(tutor.session)).sort()).toEqual([a.id, b.id].sort());

    // Les règles du rôle enseignant restent garanties.
    expect(await ids(s.prof)).toEqual([a.id]);
  });

  it('un rôle propre « limité à ses lignes » est signalé comme tel', async () => {
    const id = await createRole(s.direction, {
      name: 'Accompagnatrice',
      permissions: ['transport.rollcall'],
      lineScoped: true,
    });
    const escort = await staffWithCustomRole('accompagnatrice@demo.cm', [id]);
    const me = await http().get('/auth/me').set(escort.session.auth).expect(200);
    expect(me.body.scopes).toEqual({ classes: false, lines: true });
  });
});

describe('garde-fous', () => {
  it('au moins une personne active garde la gestion de l’école', async () => {
    // Seul directeur : il ne peut ni perdre son rôle ni le faire perdre.
    await http()
      .patch(`/staff/${f.users.director}/roles`)
      .set(s.direction.auth)
      .send({ roles: ['CENSOR'] })
      .expect(409);

    const admin = await createRole(s.direction, {
      name: 'Administrateur',
      permissions: [...LOCKED_DIRECTOR_PERMISSIONS, 'dashboard.read'],
    });
    expect(
      (await http().get('/roles').set(s.direction.auth).expect(200)).body.custom[0].adminAccess,
    ).toBe(true);
    await http()
      .patch(`/staff/${f.users.accountant}/roles`)
      .set(s.direction.auth)
      .send({ roles: ['ACCOUNTANT'], customRoleIds: [admin] })
      .expect(200);
    // Une autre personne garde la gestion : le directeur peut changer de rôle.
    await http()
      .patch(`/staff/${f.users.director}/roles`)
      .set(s.direction.auth)
      .send({ roles: ['CENSOR'] })
      .expect(200);
    // Le rôle propre ne peut plus perdre ses droits de gestion ni être retiré au dernier titulaire.
    await http()
      .put(`/roles/custom/${admin}`)
      .set(s.compta.auth)
      .send({ name: 'Administrateur', permissions: ['dashboard.read', 'staff.read'] })
      .expect(409);
    await http()
      .patch(`/staff/${f.users.accountant}/roles`)
      .set(s.compta.auth)
      .send({ roles: ['ACCOUNTANT'], customRoleIds: [] })
      .expect(409);
    // Réattribuer la direction puis désactiver l'autre accès reste possible.
    await http()
      .patch(`/staff/${f.users.director}/roles`)
      .set(s.compta.auth)
      .send({ roles: ['DIRECTOR'] })
      .expect(200);
    await http().post(`/staff/${f.users.accountant}/deactivate`).set(s.direction.auth).expect(201);
  });

  it('empêche d’accorder des droits que l’on n’a pas', async () => {
    const hr = await createRole(s.direction, {
      name: 'Gestion du personnel',
      permissions: ['staff.read', 'staff.write'],
    });
    const manager = await staffWithCustomRole('gestion@demo.cm', [hr]);
    await http()
      .patch(`/staff/${f.users.teacher}/roles`)
      .set(manager.session.auth)
      .send({ roles: ['DIRECTOR'] })
      .expect(403);
    await http()
      .patch(`/staff/${f.users.teacher}/roles`)
      .set(manager.session.auth)
      .send({ roles: ['TEACHER'], customRoleIds: [hr] })
      .expect(200);
  });

  it('les contrôles à quatre yeux restent appliqués quelles que soient les permissions', async () => {
    await http()
      .put('/roles/builtin/ACCOUNTANT')
      .set(s.direction.auth)
      .send({ permissions: [...ROLE_PERMISSIONS.ACCOUNTANT, 'finance.cash.approve'] })
      .expect(200);
    const session = await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/close`)
      .set(s.compta.auth)
      .send({ countedAmount: 0 })
      .expect(201);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/approve`)
      .set(s.compta.auth)
      .expect(403);
    await http()
      .post(`/finance/cash-sessions/${session.body.id}/approve`)
      .set(s.direction.auth)
      .expect(201);
  });

  it('exige la double authentification pour tout rôle accordant des droits administratifs', async () => {
    // Rôle sans droit administratif : pas d'exigence.
    const library = await createRole(s.direction, {
      name: 'Bibliothécaire',
      permissions: ['students.read', 'library.read'],
    });
    const cashier = await createRole(s.direction, {
      name: 'Caissier',
      permissions: ['students.read', 'finance.read', 'finance.payments.create'],
    });
    await http()
      .put('/roles/builtin/TEACHER')
      .set(s.direction.auth)
      .send({ permissions: [...ROLE_PERMISSIONS.TEACHER, 'finance.payments.create'] })
      .expect(200);
    await prisma.school.update({
      where: { id: f.schoolId },
      data: { settings: { mfaRequired: true } },
    });
    const biblioUser = await createStaff(f.schoolId, 'biblio@demo.cm', []);
    await prisma.membership.update({
      where: { userId_schoolId: { userId: biblioUser.id, schoolId: f.schoolId } },
      data: { customRoleIds: [library] },
    });
    const biblio = await login(app, 'biblio@demo.cm');
    await http().get('/students').set(biblio.auth).expect(200);

    const cashierUser = await createStaff(f.schoolId, 'caisse@demo.cm', []);
    await prisma.membership.update({
      where: { userId_schoolId: { userId: cashierUser.id, schoolId: f.schoolId } },
      data: { customRoleIds: [cashier] },
    });
    const caisse = await login(app, 'caisse@demo.cm');
    const refused = await http().get('/students').set(caisse.auth).expect(403);
    expect(refused.body.code).toBe('MFA_SETUP_REQUIRED');
    const me = await http().get('/auth/me').set(caisse.auth).expect(200);
    expect(me.body.adminAccess).toBe(true);

    // Un rôle intégré enrichi de droits sur l'argent l'exige aussi.
    expect((await http().get('/students').set(s.prof.auth).expect(403)).body.code).toBe(
      'MFA_SETUP_REQUIRED',
    );
  });
});

describe('isolation entre écoles', () => {
  it('une école ne voit ni ne modifie les rôles d’une autre', async () => {
    const g = await seedSchool('autre', 'AU');
    const t = await sessions(app, 'autre');
    const id = await createRole(s.direction, {
      name: 'Bibliothécaire',
      permissions: ['library.read'],
    });
    await http()
      .put('/roles/builtin/SECRETARY')
      .set(s.direction.auth)
      .send({ permissions: without(ROLE_PERMISSIONS.SECRETARY, 'students.read') })
      .expect(200);

    // L'autre école garde les valeurs par défaut et ne voit pas le rôle propre.
    await http().get('/students').set(t.secretariat.auth).expect(200);
    const list = await http().get('/roles').set(t.direction.auth).expect(200);
    expect(list.body.custom).toEqual([]);
    expect(list.body.builtin.find((r: { key: string }) => r.key === 'SECRETARY').customized).toBe(
      false,
    );
    // Elle ne peut ni modifier, ni supprimer, ni attribuer ce rôle.
    await http()
      .put(`/roles/custom/${id}`)
      .set(t.direction.auth)
      .send({ name: 'Piraté', permissions: ['library.read'] })
      .expect(404);
    await http().delete(`/roles/custom/${id}`).set(t.direction.auth).expect(404);
    await http()
      .patch(`/staff/${g.users.teacher}/roles`)
      .set(t.direction.auth)
      .send({ roles: ['TEACHER'], customRoleIds: [id] })
      .expect(400);
    // Le même nom est libre dans l'autre école.
    await http()
      .post('/roles/custom')
      .set(t.direction.auth)
      .send({ name: 'Bibliothécaire', permissions: ['library.read'] })
      .expect(201);
    expect((await prisma.customRole.findUniqueOrThrow({ where: { id } })).name).toBe(
      'Bibliothécaire',
    );
    // Les modifications de l'une n'incrémentent pas la version de l'autre.
    expect(
      (await prisma.school.findUniqueOrThrow({ where: { id: g.schoolId } })).rolesVersion,
    ).toBe(1);
  });
});
