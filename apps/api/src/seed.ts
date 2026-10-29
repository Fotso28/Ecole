import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { permissionsForRoles, type StaffRole } from '@ecole/shared';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { loadDotEnv } from './config/env';
import { runAsSystem, runInContext, type StaffContext } from './common/context';
import { addDays, todayInCameroon, toDbDate } from './common/dates';

/**
 * Données de démonstration : « Collège Démo » (Yaoundé), année 2026-2027.
 * Mot de passe de tous les comptes du personnel : Ecole2026!demo
 * Parent de démonstration : 6 77 12 34 56 (code SMS affiché dans les journaux en développement).
 */
export const DEMO_PASSWORD = 'Ecole2026!demo';

const FIRST_F = [
  'Marie-Claire',
  'Grâce',
  'Estelle',
  'Mireille',
  'Rachel',
  'Patricia',
  'Lydie',
  'Nadège',
  'Carine',
  'Brenda',
  'Aïcha',
  'Ruth',
  'Sandrine',
  'Laure',
  'Christelle',
  'Danielle',
];
const FIRST_M = [
  'Junior',
  'Cédric',
  'Franck',
  'Brice',
  'Emmanuel',
  'Kevin',
  'Hervé',
  'Christian',
  'Yvan',
  'Samuel',
  'Ibrahim',
  'Lionel',
  'Paul',
  'Arnaud',
  'Boris',
  'Steve',
];
const LAST = [
  'Abena',
  'Atangana',
  'Bilong',
  'Djoumessi',
  'Ekotto',
  'Fouda',
  'Mballa',
  'Nji',
  'Owona',
  'Tchana',
  'Zambo',
  'Abessolo',
  'Biya',
  'Ebogo',
  'Mengue',
  'Kamga',
  'Tchoupo',
  'Eyenga',
  'Bello',
  'Nkoulou',
  'Ndzi',
  'Tagne',
  'Essomba',
  'Manga',
  'Etoa',
  'Ateba',
  'Ndongo',
  'Kouam',
  'Biyong',
  'Essama',
  'Nana',
  'Onana',
];

async function main(): Promise<void> {
  loadDotEnv();
  const logger = new Logger('Seed');
  const base = new PrismaClient();
  if (await base.school.findUnique({ where: { slug: 'college-demo' } })) {
    logger.log('Données de démonstration déjà présentes : rien à faire.');
    await base.$disconnect();
    return;
  }
  const { AppModule } = await import('./app.module');
  const { AuthService } = await import('./modules/auth/auth.service');
  const { StudentsService } = await import('./modules/students/students.service');
  const { FinanceService } = await import('./modules/finance/finance.service');
  const { GradesService } = await import('./modules/grades/grades.module');
  const { AttendanceService } = await import('./modules/attendance/attendance.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const students = app.get(StudentsService);
  const finance = app.get(FinanceService);
  const grades = app.get(GradesService);
  const attendance = app.get(AttendanceService);
  const passwordHash = await AuthService.hashPassword(DEMO_PASSWORD);

  await base.user.upsert({
    where: { email: 'admin@ecole.cm' },
    update: {},
    create: {
      email: 'admin@ecole.cm',
      firstName: 'Admin',
      lastName: 'Plateforme',
      isPlatformAdmin: true,
      passwordHash,
    },
  });
  const school = await base.school.create({
    data: {
      name: 'Collège Démo',
      slug: 'college-demo',
      city: 'Yaoundé',
      phone: '+237222234567',
      matriculePrefix: 'CD',
      modules: [
        'students',
        'attendance',
        'grades',
        'finance',
        'communication',
        'portal',
        'timetable',
        'documents',
      ],
      settings: { absenceAlertThreshold: 3, reminderOffsets: [5, 15, 30] },
    },
  });
  const schoolId = school.id;

  const staffDefs: [string, string, string, StaffRole[]][] = [
    ['direction@demo.cm', 'Alice', 'Ngo Bassa', ['DIRECTOR']],
    ['censeur@demo.cm', 'Samuel', 'Fouda', ['CENSOR']],
    ['surveillant@demo.cm', 'Martin', 'Belinga', ['SUPERVISOR']],
    ['secretariat@demo.cm', 'Odile', 'Tagne', ['SECRETARY']],
    ['compta@demo.cm', 'Robert', 'Etoa', ['ACCOUNTANT']],
    ['infirmerie@demo.cm', 'Clarisse', 'Nkeng', ['NURSE']],
    ['prof.maths@demo.cm', 'Paul', 'Mbarga', ['TEACHER']],
    ['prof.francais@demo.cm', 'Brigitte', 'Eyenga', ['TEACHER']],
    ['prof.anglais@demo.cm', 'Thomas', 'Nkeng', ['TEACHER']],
    ['prof.sciences@demo.cm', 'Rose', 'Ateba', ['TEACHER', 'SUPERVISOR']],
    ['prof.histoire@demo.cm', 'Jean', 'Owona', ['TEACHER']],
  ];
  const staff: Record<string, string> = {};
  for (const [email, firstName, lastName, roles] of staffDefs) {
    const user = await base.user.create({ data: { email, firstName, lastName, passwordHash } });
    await base.membership.create({
      data: {
        userId: user.id,
        schoolId,
        roles,
        maxWeeklyHours: roles.includes('TEACHER') ? 22 : null,
      },
    });
    staff[email] = user.id;
  }
  const staffCtx = (email: string, roles: StaffRole[]): StaffContext => ({
    kind: 'staff',
    userId: staff[email] ?? '',
    schoolId,
    roles,
    permissions: permissionsForRoles(roles),
    isPlatformAdmin: false,
    breakGlass: false,
  });

  const year = await base.academicYear.create({
    data: {
      schoolId,
      name: '2026-2027',
      startDate: toDbDate('2026-09-07'),
      endDate: toDbDate('2027-06-30'),
      isCurrent: true,
    },
  });
  const termDefs: [string, string, string][] = [
    ['1er trimestre', '2026-09-07', '2026-12-18'],
    ['2e trimestre', '2027-01-04', '2027-03-26'],
    ['3e trimestre', '2027-04-06', '2027-06-30'],
  ];
  const sequences: string[] = [];
  for (const [i, [name, start, end]] of termDefs.entries()) {
    const term = await base.term.create({
      data: {
        schoolId,
        academicYearId: year.id,
        name,
        order: i + 1,
        startDate: toDbDate(start),
        endDate: toDbDate(end),
      },
    });
    for (const o of [1, 2]) {
      const seq = await base.sequence.create({
        data: { schoolId, termId: term.id, name: `Séquence ${i * 2 + o}`, order: o },
      });
      sequences.push(seq.id);
    }
  }
  const cycle1 = await base.cycle.create({ data: { schoolId, name: 'Premier cycle', order: 1 } });
  const cycle2 = await base.cycle.create({ data: { schoolId, name: 'Second cycle', order: 2 } });
  const levels: Record<string, string> = {};
  for (const [i, n] of ['6e', '5e', '4e', '3e'].entries())
    levels[n] = (
      await base.level.create({ data: { schoolId, cycleId: cycle1.id, name: n, order: i + 1 } })
    ).id;
  for (const [i, n] of ['2nde', '1re', 'Tle'].entries())
    levels[n] = (
      await base.level.create({ data: { schoolId, cycleId: cycle2.id, name: n, order: i + 5 } })
    ).id;
  const classDefs: [string, string, number][] = [
    ['6e A', '6e', 10],
    ['5e A', '5e', 8],
    ['4e A', '4e', 30],
    ['4e B', '4e', 10],
    ['3e B', '3e', 8],
    ['2nde C', '2nde', 8],
    ['1re D', '1re', 6],
    ['Tle D', 'Tle', 6],
  ];
  const classes: Record<string, string> = {};
  for (const [name, level] of classDefs) {
    classes[name] = (
      await base.class.create({
        data: {
          schoolId,
          academicYearId: year.id,
          levelId: levels[level] ?? '',
          name,
          capacity: 50,
        },
      })
    ).id;
  }
  await base.class.update({
    where: { id: classes['4e A'] },
    data: { mainTeacherId: staff['prof.maths@demo.cm'] },
  });

  const subjectDefs: [string, string, 'LITERARY' | 'SCIENTIFIC' | 'OTHER', number, string][] = [
    ['Français', 'FR', 'LITERARY', 4, 'prof.francais@demo.cm'],
    ['Anglais', 'ANG', 'LITERARY', 3, 'prof.anglais@demo.cm'],
    ['Histoire-Géographie', 'HG', 'LITERARY', 2, 'prof.histoire@demo.cm'],
    ['Éducation à la citoyenneté', 'ECM', 'LITERARY', 2, 'prof.histoire@demo.cm'],
    ['Mathématiques', 'MATH', 'SCIENTIFIC', 4, 'prof.maths@demo.cm'],
    ['Physique-Chimie-Technologie', 'PCT', 'SCIENTIFIC', 2, 'prof.sciences@demo.cm'],
    ['Sciences de la vie et de la Terre', 'SVT', 'SCIENTIFIC', 2, 'prof.sciences@demo.cm'],
    ['Éducation physique et sportive', 'EPS', 'OTHER', 2, 'prof.histoire@demo.cm'],
  ];
  const classSubjects: Record<string, Record<string, string>> = {};
  for (const [name, code, group, coefficient, teacher] of subjectDefs) {
    const subject = await base.subject.create({ data: { schoolId, name, code, group } });
    for (const cls of ['4e A', '4e B', '3e B']) {
      const cs = await base.classSubject.create({
        data: {
          schoolId,
          classId: classes[cls] ?? '',
          subjectId: subject.id,
          coefficient,
          teacherId: staff[teacher],
          weeklyHours: coefficient > 2 ? 4 : 2,
        },
      });
      (classSubjects[cls] ??= {})[code] = cs.id;
    }
  }

  const today = todayInCameroon();
  const fees: [string, number, string, string | null][] = [
    ['Inscription', 25000, '2026-09-07', null],
    ['Tranche 1', 70000, '2026-09-30', null],
    ['Tranche 2', 50000, '2026-11-15', null],
    ['Tranche 3', 30000, '2027-01-15', null],
    ['Cotisation APEE', 10000, '2026-09-30', null],
  ];
  for (const [i, [name, amount, dueDate, levelId]] of fees.entries()) {
    await base.feeItem.create({
      data: {
        schoolId,
        academicYearId: year.id,
        name,
        amount,
        dueDate: toDbDate(dueDate),
        levelId,
        order: i + 1,
      },
    });
  }
  await base.room.createMany({
    data: ['B12', 'B14', 'Labo 1', 'Labo 2', 'Salle info'].map((name) => ({ schoolId, name })),
  });

  // Élèves : Marie-Claire Ngono (4e A) et son frère Paul-Henri (6e A) partagent le parent de démonstration.
  const secretary = staffCtx('secretariat@demo.cm', ['SECRETARY']);
  const created: Record<string, string[]> = {};
  let n = 0;
  const add = async (
    cls: string,
    firstName: string,
    lastName: string,
    gender: 'F' | 'M',
    phone: string,
    birthDate: string,
  ) => {
    const st = await runInContext(secretary, () =>
      students.create({
        firstName,
        lastName,
        gender,
        birthDate,
        birthPlace: n % 3 === 0 ? 'Douala' : 'Yaoundé',
        nationality: 'Camerounaise',
        photoConsent: true,
        classId: classes[cls],
        confirmNotDuplicate: true,
        guardians: [
          {
            firstName: gender === 'F' ? 'Pierre' : 'Thérèse',
            lastName,
            phone,
            relationship: n % 2 ? 'MOTHER' : 'FATHER',
            isPrimary: true,
            isEmergencyContact: true,
            canPickUp: true,
          },
        ],
      }),
    );
    (created[cls] ??= []).push(st.id);
    n++;
    return st.id;
  };
  const ngono = await add('4e A', 'Marie-Claire', 'Ngono', 'F', '+237677123456', '2012-03-12');
  await add('6e A', 'Paul-Henri', 'Ngono', 'M', '+237677123456', '2015-06-21');
  for (const [cls, , count] of classDefs) {
    const start = cls === '4e A' ? 1 : cls === '6e A' ? 1 : 0;
    for (let i = start; i < count; i++) {
      const female = (i + cls.length) % 2 === 0;
      const first = (female ? FIRST_F : FIRST_M)[(i * 7 + cls.length) % 16] ?? 'Élève';
      const last = LAST[(i * 5 + cls.charCodeAt(0)) % LAST.length] ?? 'Nom';
      const birthYear =
        2026 -
        12 -
        Number(['6e', '5e', '4e', '3e', '2nde', '1re', 'Tle'].indexOf(cls.split(' ')[0] ?? '6e'));
      const birthDate = `${birthYear - 1}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`;
      await add(
        cls,
        first,
        last,
        female ? 'F' : 'M',
        `+2376${String(77000000 + n * 137).slice(-8)}`,
        birthDate,
      );
    }
  }

  // Paiements (virements bancaires de rentrée) : environ deux tiers des familles ont payé inscription et tranche 1.
  const all = Object.values(created).flat();
  for (const [i, studentId] of all.entries()) {
    const amount = i % 3 === 0 ? 0 : i % 3 === 1 ? 105000 : 25000;
    if (amount === 0 && studentId !== ngono) continue;
    await runAsSystem(
      'seed-payment',
      () =>
        finance.createPayment({
          studentId,
          amount: studentId === ngono ? 120000 : amount,
          method: 'BANK',
          bankName: 'Banque partenaire',
          bankReference: `VIR-${1000 + i}`,
          idempotencyKey: randomUUID(),
        }),
      schoolId,
    );
  }

  // Notes de la séquence 1 en 4e A (mathématiques et français), soumises puis validées.
  const class4A = created['4e A'] ?? [];
  const gradePlan: [string, string, StaffRole[]][] = [
    ['MATH', 'prof.maths@demo.cm', ['TEACHER']],
    ['FR', 'prof.francais@demo.cm', ['TEACHER']],
  ];
  for (const [code, teacher, roles] of gradePlan) {
    const ctx = staffCtx(teacher, roles);
    const csId = classSubjects['4e A']?.[code] ?? '';
    const seq1 = sequences[0] ?? '';
    const evs = [
      ['Interrogation', 'QUIZ', 1],
      ['Devoir', 'HOMEWORK', 1],
      ['Composition', 'EXAM', 2],
    ] as const;
    for (const [k, [name, type, weight]] of evs.entries()) {
      const ev = await runInContext(ctx, () =>
        grades.createEvaluation({
          classSubjectId: csId,
          sequenceId: seq1,
          name,
          type,
          weight,
          maxScore: 20,
        }),
      );
      await runInContext(ctx, () =>
        grades.upsertGrades(
          ev.id,
          class4A.map((id, i) => ({
            studentId: id,
            value:
              id === ngono
                ? code === 'MATH'
                  ? (['14', '15', '14'][k] ?? '14')
                  : (['12', '13', '12,5'][k] ?? '12')
                : String(6 + ((i * 7 + k * 3 + code.length) % 13)),
          })),
        ),
      );
    }
    await runInContext(ctx, () => grades.submit(csId, seq1));
  }

  // Appels de la semaine en 4e A, avec quelques absences.
  const teacherCtx = staffCtx('prof.maths@demo.cm', ['TEACHER']);
  for (let d = 1; d <= 4; d++) {
    const date = addDays(today, -d);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    await runInContext(teacherCtx, () =>
      attendance.submit({
        classId: classes['4e A'] ?? '',
        classSubjectId: classSubjects['4e A']?.MATH,
        date,
        startTime: '07:30',
        endTime: '09:20',
        records: class4A.map((id, i) => ({
          studentId: id,
          status: (i + d) % 11 === 0 ? 'ABSENT' : (i + d) % 13 === 0 ? 'LATE' : 'PRESENT',
        })),
      }),
    );
  }

  // Emploi du temps de la 4e A (lundi et mardi).
  const slots: [number, string, string, string, string][] = [
    [1, '07:30', '09:20', 'FR', 'B12'],
    [1, '09:20', '10:15', 'MATH', 'B12'],
    [1, '10:30', '12:20', 'ANG', 'B12'],
    [2, '07:30', '09:20', 'MATH', 'B12'],
    [2, '09:20', '10:15', 'SVT', 'Labo 2'],
    [2, '10:30', '11:25', 'PCT', 'Labo 1'],
    [2, '11:25', '12:20', 'HG', 'B12'],
  ];
  const rooms = await base.room.findMany({ where: { schoolId } });
  for (const [day, start, end, code, room] of slots) {
    const csId = classSubjects['4e A']?.[code] ?? '';
    const cs = await base.classSubject.findUniqueOrThrow({ where: { id: csId } });
    await base.timetableEntry.create({
      data: {
        schoolId,
        academicYearId: year.id,
        classId: cs.classId,
        classSubjectId: cs.id,
        teacherId: cs.teacherId,
        roomId: rooms.find((r) => r.name === room)?.id,
        dayOfWeek: day,
        startTime: start,
        endTime: end,
      },
    });
  }
  await base.announcement.create({
    data: {
      schoolId,
      title: 'Réunion des parents',
      body: 'Samedi 7 novembre à 9 h, salle polyvalente : remise des résultats de la séquence 1.',
      scope: 'SCHOOL',
      authorId: staff['direction@demo.cm'] ?? '',
    },
  });
  // Les SMS générés par le jeu de démonstration ne doivent pas partir.
  await base.notificationOutbox.updateMany({
    where: { status: 'PENDING' },
    data: { status: 'FAILED', lastError: 'Jeu de démonstration' },
  });

  logger.log(
    `Collège Démo créé : ${all.length} élèves, ${staffDefs.length} comptes du personnel (mot de passe ${DEMO_PASSWORD}).`,
  );
  await app.close();
  await base.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
