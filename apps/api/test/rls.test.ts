import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runAsSystem,
  runInContext as runWithContext,
  type StaffContext,
} from '../src/common/context';
import {
  createDb,
  RLS_EXEMPT_MODELS,
  RLS_MODELS,
  SYSTEM_ROLE,
  TENANT_MODELS,
} from '../src/common/prisma';
import { createSchool, prisma, resetDb } from './helpers';
import { TEST_APP_URL } from './setup-env';

/** Connexions avec le rôle applicatif (ecole_app), soumis à la Row-Level Security. */
const app = new PrismaClient({ datasourceUrl: TEST_APP_URL });
const db = createDb(app);
/** Une seule connexion : prouve qu'aucun réglage ne reste d'une requête à la suivante. */
const single = new PrismaClient({ datasourceUrl: `${TEST_APP_URL}?connection_limit=1` });
const singleDb = createDb(single);

function staffOf(schoolId: string): StaffContext {
  return {
    kind: 'staff',
    userId: 'u',
    schoolId,
    roles: ['DIRECTOR'],
    permissions: new Set(),
    isPlatformAdmin: false,
    breakGlass: false,
  };
}

const student = (schoolId: string, matricule: string) => ({
  schoolId,
  matricule,
  firstName: 'Élève',
  lastName: matricule,
  gender: 'F' as const,
  birthDate: new Date('2012-03-12'),
});

let a: string;
let b: string;
let otherId: string;

beforeAll(async () => {
  await app.$connect();
});

beforeEach(async () => {
  await resetDb();
  a = (await createSchool('a', 'AA')).id;
  b = (await createSchool('b', 'BB')).id;
  await prisma.student.createMany({
    data: [student(a, 'AA-1'), student(a, 'AA-2'), student(b, 'BB-1')],
  });
  otherId = (await prisma.student.findFirstOrThrow({ where: { schoolId: b } })).id;
});

afterAll(async () => {
  await Promise.all([app.$disconnect(), single.$disconnect(), prisma.$disconnect()]);
});

describe('Row-Level Security : requêtes SQL brutes', () => {
  it('sans contexte, une requête brute ne voit aucune ligne cloisonnée', async () => {
    const rows = await app.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Student"`;
    expect(rows[0]?.n).toBe(0);
    const updated = await app.$executeRaw`UPDATE "Student" SET "firstName" = 'Piraté'`;
    expect(updated).toBe(0);
    await expect(
      app.$executeRaw`INSERT INTO "Student" ("id", "schoolId", "matricule", "firstName", "lastName", "gender", "birthDate", "updatedAt")
        VALUES ('x', ${b}, 'BB-9', 'A', 'B', 'F', now(), now())`,
    ).rejects.toThrow(/row-level security/);
  });

  it("dans le contexte d'une école, une requête brute sans filtre ne voit que cette école", async () => {
    const rows = await runWithContext(
      staffOf(a),
      () => db.$queryRaw<{ matricule: string }[]>`SELECT "matricule" FROM "Student" ORDER BY 1`,
    );
    expect(rows.map((r) => r.matricule)).toEqual(['AA-1', 'AA-2']);
    const other = await runWithContext(
      staffOf(a),
      () => db.$queryRaw<unknown[]>`SELECT * FROM "Student" WHERE "id" = ${otherId}`,
    );
    expect(other).toHaveLength(0);
    const changed = await runWithContext(
      staffOf(a),
      () => db.$executeRaw`UPDATE "Student" SET "firstName" = 'Piraté' WHERE "schoolId" = ${b}`,
    );
    expect(changed).toBe(0);
    await expect(
      runWithContext(
        staffOf(a),
        () => db.$executeRaw`UPDATE "Student" SET "schoolId" = ${b} WHERE "matricule" = 'AA-1'`,
      ),
    ).rejects.toThrow(/row-level security/);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: otherId } })).firstName).toBe(
      'Élève',
    );
  });

  it('le mode système voit toutes les écoles, une tâche limitée à une école ne voit que la sienne', async () => {
    const all = await runAsSystem(
      'test',
      () => db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Student"`,
    );
    expect(all[0]?.n).toBe(3);
    const scoped = await runAsSystem(
      'test',
      () => db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Student"`,
      b,
    );
    expect(scoped[0]?.n).toBe(1);
  });

  it('les lignes sans établissement (codes de connexion) ne sont visibles qu’en mode système', async () => {
    await prisma.notificationOutbox.create({
      data: { channel: 'SMS', recipient: '+237690000000', template: 'otp', body: 'Code 123456' },
    });
    const asStaff = await runWithContext(staffOf(a), () => db.notificationOutbox.count());
    expect(asStaff).toBe(0);
    const asSystem = await runAsSystem('test', () => db.notificationOutbox.count());
    expect(asSystem).toBe(1);
  });

  it('le journal d’audit est en ajout seul, même en mode système', async () => {
    await runWithContext(staffOf(a), () =>
      db.auditLog.create({ data: { schoolId: a, action: 'test', entity: 'Student' } }),
    );
    await expect(
      runWithContext(staffOf(a), () =>
        db.auditLog.create({ data: { schoolId: b, action: 'test', entity: 'Student' } }),
      ),
    ).rejects.toThrow();
    await expect(runAsSystem('test', () => db.$executeRaw`DELETE FROM "AuditLog"`)).rejects.toThrow(
      /permission denied/,
    );
    expect(await prisma.auditLog.count()).toBe(1);
  });
});

describe('Row-Level Security : filet sous le filtre applicatif', () => {
  it("une erreur de filtre dans l'application est bloquée par la base", async () => {
    // Erreur volontaire : le modèle Student sort du filtre applicatif.
    const models = TENANT_MODELS as Set<string>;
    models.delete('Student');
    try {
      const rows = await runWithContext(staffOf(a), () =>
        db.student.findMany({ where: { schoolId: b } }),
      );
      expect(rows).toHaveLength(0);
      const found = await runWithContext(staffOf(a), () =>
        db.student.findUnique({ where: { id: otherId } }),
      );
      expect(found).toBeNull();
      const updated = await runWithContext(staffOf(a), () =>
        db.student.updateMany({ where: { schoolId: b }, data: { firstName: 'Piraté' } }),
      );
      expect(updated.count).toBe(0);
      await expect(
        runWithContext(staffOf(a), () => db.student.delete({ where: { id: otherId } })),
      ).rejects.toThrow();
      await expect(
        runWithContext(staffOf(a), () => db.student.create({ data: student(b, 'BB-2') })),
      ).rejects.toThrow(/row-level security/);
      // Lecture par une relation depuis une table non cloisonnée.
      const school = await runWithContext(staffOf(a), () =>
        db.school.findUnique({ where: { id: b }, include: { students: true } }),
      );
      expect(school?.students).toEqual([]);
    } finally {
      models.add('Student');
    }
    expect(await prisma.student.count({ where: { schoolId: b } })).toBe(1);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: otherId } })).firstName).toBe(
      'Élève',
    );
  });

  it('le réglage ne fuit pas d’une requête à l’autre sur une même connexion', async () => {
    const asA = await runWithContext(staffOf(a), () => singleDb.student.count());
    expect(asA).toBe(2);
    const setting = await single.$queryRaw<{ s: string | null; role: string }[]>`
      SELECT current_setting('app.school_id', true) AS s, current_user AS role`;
    expect(setting[0]?.s ?? '').toBe('');
    expect(setting[0]?.role).toBe('ecole_app');
    await runAsSystem('test', () => singleDb.student.count());
    const role = await single.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    expect(role[0]?.role).toBe('ecole_app');
    const after = await single.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Student"`;
    expect(after[0]?.n).toBe(0);
    await expect(
      runWithContext(staffOf(a), () =>
        singleDb.$transaction(async (tx) => {
          await tx.student.count();
          throw new Error('annulée');
        }),
      ),
    ).rejects.toThrow('annulée');
    const afterRollback = await single.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Student"`;
    expect(afterRollback[0]?.n).toBe(0);
  });

  it('transactions interactives : portée posée à l’ouverture, changée par runAsSystem, verrous consultatifs', async () => {
    const result = await runWithContext(staffOf(a), () =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rls-test'))`;
        const raw = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Student"`;
        const all = await runAsSystem('test', () => tx.student.count());
        const again = await tx.student.count();
        const other = await runAsSystem('test', () => tx.student.count(), b);
        return { raw: raw[0]?.n, all, again, other };
      }),
    );
    expect(result).toEqual({ raw: 2, all: 3, again: 2, other: 1 });
  });

  it('transactions par lot : portée posée en tête du lot', async () => {
    const [count, raw] = await runWithContext(staffOf(b), () =>
      db.$transaction([
        db.student.count(),
        db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Student"`,
      ]),
    );
    expect(count).toBe(1);
    expect(raw[0]?.n).toBe(1);
  });
});

describe('Row-Level Security : catalogue PostgreSQL', () => {
  it('toute table portant un schoolId a la RLS forcée et des politiques', async () => {
    const tables = await prisma.$queryRaw<
      { table: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'schoolId' AND NOT a.attisdropped)
      ORDER BY 1`;
    expect(tables.length).toBeGreaterThan(80);
    const unprotected = tables
      .filter((t) => !RLS_EXEMPT_MODELS.has(t.table))
      .filter((t) => !t.rls || !t.forced || t.policies === 0)
      .map((t) => t.table);
    expect(unprotected, 'tables sans Row-Level Security : ajouter une migration').toEqual([]);
    // Les listes de l'application et la base disent la même chose.
    const protectedTables = tables.filter((t) => t.rls).map((t) => t.table);
    expect(new Set(protectedTables)).toEqual(RLS_MODELS);
    for (const exempt of RLS_EXEMPT_MODELS) {
      expect(tables.map((t) => t.table)).toContain(exempt);
    }
  });

  it('le rôle système ne se connecte pas et ne sert qu’à travers le rôle applicatif', async () => {
    const [role] = await prisma.$queryRaw<
      { login: boolean; bypass: boolean; member: boolean; inherit: boolean }[]
    >`
      SELECT r.rolcanlogin AS login, r.rolbypassrls AS bypass,
             pg_has_role('ecole_app', r.oid, 'MEMBER') AS member,
             pg_has_role('ecole_app', r.oid, 'USAGE') AS inherit
      FROM pg_roles r WHERE r.rolname = ${SYSTEM_ROLE}`;
    expect(role).toEqual({ login: false, bypass: true, member: true, inherit: false });
  });

  it("le rôle applicatif n'est ni superutilisateur, ni BYPASSRLS, ni propriétaire des tables", async () => {
    const [role] = await app.$queryRaw<{ name: string; superuser: boolean; bypass: boolean }[]>`
      SELECT rolname AS name, rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user`;
    expect(role).toMatchObject({ superuser: false, bypass: false });
    const owned = await app.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`;
    expect(owned[0]?.n).toBe(0);
  });
});
