import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createStaff, login, prisma, type Session } from './helpers';

export interface SchoolFixture {
  schoolId: string;
  yearId: string;
  term1Id: string;
  seq1Id: string;
  seq2Id: string;
  cycleId: string;
  level4Id: string;
  level6Id: string;
  class4AId: string;
  class4BId: string;
  class6AId: string;
  subjects: { maths: string; francais: string; anglais: string; svt: string };
  cs: { maths4A: string; francais4A: string; anglais4A: string; maths4B: string };
  users: { director: string; censor: string; teacher: string; teacher2: string; accountant: string; supervisor: string; secretary: string };
}

/** Établissement complet : année 2026-2027, trimestre 1 (2 séquences), classes, matières, personnel, frais. */
export async function seedSchool(slug = 'demo', prefix = 'CD'): Promise<SchoolFixture> {
  const school = await prisma.school.create({
    data: {
      name: `Collège ${slug}`,
      slug,
      city: 'Yaoundé',
      matriculePrefix: prefix,
      modules: ['students', 'attendance', 'grades', 'finance', 'communication', 'portal', 'timetable'],
    },
  });
  const schoolId = school.id;
  const year = await prisma.academicYear.create({
    data: { schoolId, name: '2026-2027', startDate: new Date('2026-09-07'), endDate: new Date('2027-06-30'), isCurrent: true },
  });
  const term1 = await prisma.term.create({
    data: { schoolId, academicYearId: year.id, name: '1er trimestre', order: 1, startDate: new Date('2026-09-07'), endDate: new Date('2026-12-18') },
  });
  const seq1 = await prisma.sequence.create({ data: { schoolId, termId: term1.id, name: 'Séquence 1', order: 1 } });
  const seq2 = await prisma.sequence.create({ data: { schoolId, termId: term1.id, name: 'Séquence 2', order: 2 } });
  const cycle = await prisma.cycle.create({ data: { schoolId, name: 'Premier cycle', order: 1 } });
  const level6 = await prisma.level.create({ data: { schoolId, cycleId: cycle.id, name: '6e', order: 1 } });
  const level4 = await prisma.level.create({ data: { schoolId, cycleId: cycle.id, name: '4e', order: 3 } });
  const [class4A, class4B, class6A] = await Promise.all([
    prisma.class.create({ data: { schoolId, academicYearId: year.id, levelId: level4.id, name: '4e A' } }),
    prisma.class.create({ data: { schoolId, academicYearId: year.id, levelId: level4.id, name: '4e B' } }),
    prisma.class.create({ data: { schoolId, academicYearId: year.id, levelId: level6.id, name: '6e A' } }),
  ]);
  const [maths, francais, anglais, svt] = await Promise.all([
    prisma.subject.create({ data: { schoolId, name: 'Mathématiques', code: 'MATH', group: 'SCIENTIFIC' } }),
    prisma.subject.create({ data: { schoolId, name: 'Français', code: 'FR', group: 'LITERARY' } }),
    prisma.subject.create({ data: { schoolId, name: 'Anglais', code: 'ANG', group: 'LITERARY' } }),
    prisma.subject.create({ data: { schoolId, name: 'SVT', code: 'SVT', group: 'SCIENTIFIC' } }),
  ]);
  const director = await createStaff(schoolId, `direction@${slug}.cm`, ['DIRECTOR']);
  const censor = await createStaff(schoolId, `censeur@${slug}.cm`, ['CENSOR']);
  const teacher = await createStaff(schoolId, `prof@${slug}.cm`, ['TEACHER']);
  const teacher2 = await createStaff(schoolId, `prof2@${slug}.cm`, ['TEACHER']);
  const accountant = await createStaff(schoolId, `compta@${slug}.cm`, ['ACCOUNTANT']);
  const supervisor = await createStaff(schoolId, `surveillant@${slug}.cm`, ['SUPERVISOR']);
  const secretary = await createStaff(schoolId, `secretariat@${slug}.cm`, ['SECRETARY']);
  await prisma.class.update({ where: { id: class4A.id }, data: { mainTeacherId: teacher.id } });
  const [maths4A, francais4A, anglais4A, maths4B] = await Promise.all([
    prisma.classSubject.create({ data: { schoolId, classId: class4A.id, subjectId: maths.id, coefficient: 4, teacherId: teacher.id, weeklyHours: 5 } }),
    prisma.classSubject.create({ data: { schoolId, classId: class4A.id, subjectId: francais.id, coefficient: 4, teacherId: teacher2.id, weeklyHours: 5 } }),
    prisma.classSubject.create({ data: { schoolId, classId: class4A.id, subjectId: anglais.id, coefficient: 3, teacherId: teacher2.id, weeklyHours: 4 } }),
    prisma.classSubject.create({ data: { schoolId, classId: class4B.id, subjectId: maths.id, coefficient: 4, teacherId: teacher2.id, weeklyHours: 5 } }),
  ]);
  await prisma.feeItem.createMany({
    data: [
      { schoolId, academicYearId: year.id, name: 'Inscription', amount: 25000, dueDate: new Date('2026-09-07'), order: 1 },
      { schoolId, academicYearId: year.id, name: 'Tranche 1', amount: 70000, dueDate: new Date('2026-09-30'), order: 2 },
      { schoolId, academicYearId: year.id, name: 'Tranche 2', amount: 50000, dueDate: new Date('2026-11-15'), order: 3 },
      { schoolId, academicYearId: year.id, name: 'Tranche 3', amount: 30000, dueDate: new Date('2027-01-15'), order: 4 },
      { schoolId, academicYearId: year.id, name: 'Frais de laboratoire 4e', amount: 10000, dueDate: new Date('2026-09-30'), levelId: level4.id, order: 5 },
    ],
  });
  return {
    schoolId,
    yearId: year.id,
    term1Id: term1.id,
    seq1Id: seq1.id,
    seq2Id: seq2.id,
    cycleId: cycle.id,
    level4Id: level4.id,
    level6Id: level6.id,
    class4AId: class4A.id,
    class4BId: class4B.id,
    class6AId: class6A.id,
    subjects: { maths: maths.id, francais: francais.id, anglais: anglais.id, svt: svt.id },
    cs: { maths4A: maths4A.id, francais4A: francais4A.id, anglais4A: anglais4A.id, maths4B: maths4B.id },
    users: {
      director: director.id,
      censor: censor.id,
      teacher: teacher.id,
      teacher2: teacher2.id,
      accountant: accountant.id,
      supervisor: supervisor.id,
      secretary: secretary.id,
    },
  };
}

export async function sessions(app: INestApplication, slug = 'demo') {
  const entries = await Promise.all(
    (['direction', 'censeur', 'prof', 'prof2', 'compta', 'surveillant', 'secretariat'] as const).map(async (k) => [k, await login(app, `${k}@${slug}.cm`)] as const),
  );
  return Object.fromEntries(entries) as Record<(typeof entries)[number][0], Session>;
}

let phoneSeq = 0;

/** Inscrit un élève par l'API (comme le secrétariat). */
export async function enrollStudent(
  app: INestApplication,
  s: Session,
  input: { firstName: string; lastName: string; classId?: string; birthDate?: string; phone?: string; gender?: 'F' | 'M' },
) {
  phoneSeq++;
  const res = await request(app.getHttpServer())
    .post('/students')
    .set(s.auth)
    .send({
      firstName: input.firstName,
      lastName: input.lastName,
      gender: input.gender ?? 'F',
      birthDate: input.birthDate ?? `2012-0${(phoneSeq % 9) + 1}-1${phoneSeq % 10}`,
      birthPlace: 'Yaoundé',
      classId: input.classId,
      guardians: [
        { firstName: 'Parent', lastName: input.lastName, phone: input.phone ?? `6${String(70000000 + phoneSeq).padStart(8, '0')}`, relationship: 'FATHER', isPrimary: true },
      ],
    });
  if (res.status !== 201) throw new Error(`Inscription impossible : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; matricule: string };
}
