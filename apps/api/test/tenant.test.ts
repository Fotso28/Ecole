import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runAsSystem,
  runInContext as runWithContext,
  type StaffContext,
} from '../src/common/context';
import { createDb } from '../src/common/prisma';
import { createSchool, prisma, resetDb } from './helpers';

const db = createDb(prisma);

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

beforeEach(async () => {
  await resetDb();
  a = (await createSchool('a', 'AA')).id;
  b = (await createSchool('b', 'BB')).id;
  await prisma.student.createMany({
    data: [student(a, 'AA-1'), student(a, 'AA-2'), student(b, 'BB-1')],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('isolation des établissements', () => {
  it('filtre automatiquement les lectures par établissement', async () => {
    const rows = await runWithContext(staffOf(a), () => db.student.findMany());
    expect(rows.map((r) => r.matricule).sort()).toEqual(['AA-1', 'AA-2']);
    const count = await runWithContext(staffOf(b), () => db.student.count());
    expect(count).toBe(1);
  });

  it("n'expose pas un enregistrement d'une autre école, même par son identifiant", async () => {
    const other = await prisma.student.findFirstOrThrow({ where: { schoolId: b } });
    const found = await runWithContext(staffOf(a), () =>
      db.student.findUnique({ where: { id: other.id } }),
    );
    expect(found).toBeNull();
    const firstOther = await runWithContext(staffOf(a), () =>
      db.student.findFirst({ where: { matricule: 'BB-1' } }),
    );
    expect(firstOther).toBeNull();
  });

  it("refuse de modifier ou supprimer l'enregistrement d'une autre école", async () => {
    const other = await prisma.student.findFirstOrThrow({ where: { schoolId: b } });
    await expect(
      runWithContext(staffOf(a), () =>
        db.student.update({ where: { id: other.id }, data: { firstName: 'Piraté' } }),
      ),
    ).rejects.toThrow();
    const updated = await runWithContext(staffOf(a), () =>
      db.student.updateMany({ data: { firstName: 'Tous' } }),
    );
    expect(updated.count).toBe(2);
    const untouched = await prisma.student.findUniqueOrThrow({ where: { id: other.id } });
    expect(untouched.firstName).toBe('Élève');
    const deleted = await runWithContext(staffOf(a), () =>
      db.student.deleteMany({ where: { matricule: 'BB-1' } }),
    );
    expect(deleted.count).toBe(0);
  });

  it('refuse une création pour une autre école', async () => {
    await expect(
      runWithContext(staffOf(a), () => db.student.create({ data: student(b, 'BB-2') })),
    ).rejects.toThrow(/inter-établissement/);
    await expect(
      runWithContext(staffOf(a), () =>
        db.student.createMany({ data: [student(a, 'AA-3'), student(b, 'BB-3')] }),
      ),
    ).rejects.toThrow(/inter-établissement/);
  });

  it('refuse de déplacer un enregistrement vers une autre école', async () => {
    const mine = await prisma.student.findFirstOrThrow({ where: { schoolId: a } });
    await expect(
      runWithContext(staffOf(a), () =>
        db.student.update({ where: { id: mine.id }, data: { schoolId: b } }),
      ),
    ).rejects.toThrow(/Changement d'établissement/);
  });

  it('refuse toute requête sans contexte', async () => {
    await expect(db.student.findMany()).rejects.toThrow(/sans établissement/);
    await expect(runWithContext({ kind: 'anonymous' }, () => db.student.count())).rejects.toThrow(
      /sans établissement/,
    );
    await expect(
      runWithContext({ kind: 'parent', userId: 'p' }, () => db.student.count()),
    ).rejects.toThrow(/sans établissement/);
  });

  it('autorise une tâche système explicite, limitée ou globale', async () => {
    const limited = await runAsSystem('test', () => db.student.count(), b);
    expect(limited).toBe(1);
    const global = await runAsSystem('test', () => db.student.count());
    expect(global).toBe(3);
  });

  it('applique le filtre dans les transactions interactives', async () => {
    const count = await runWithContext(staffOf(a), () =>
      db.$transaction(async (tx) => tx.student.count()),
    );
    expect(count).toBe(2);
  });

  it('laisse passer les modèles non cloisonnés', async () => {
    const schools = await db.school.count();
    expect(schools).toBe(2);
  });
});
