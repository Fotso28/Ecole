import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { permissionsForRoles, type StaffRole } from '@ecole/shared';
import { PrismaClient } from '@prisma/client';
import { loadDotEnv } from '../config/env';
import { runAsSystem, runInContext, type StaffContext } from '../common/context';
import { toDbDate } from '../common/dates';

/**
 * Données volumineuses pour les tests de charge : N établissements de M élèves (par défaut
 * 5 × 1 500), créés par les services métier (factures, matricules, notes, bulletins publiés
 * du 1er trimestre). Écrit le fichier de correspondance lu par les scripts k6.
 *
 *   LOADTEST_SEED=oui node dist/loadtest/seed-volume.js [écoles] [élèves] [fichier.json]
 *
 * Refuse de tourner sans LOADTEST_SEED=oui : jamais sur une base de production réelle.
 */
export const LOADTEST_PASSWORD = 'Charge2026!test';

const LEVELS: [string, number][] = [
  ['6e', 5],
  ['5e', 5],
  ['4e', 5],
  ['3e', 5],
  ['2nde', 4],
  ['1re', 3],
  ['Tle', 3],
];
const SUBJECTS: [string, string, 'LITERARY' | 'SCIENTIFIC' | 'OTHER', number][] = [
  ['Français', 'FR', 'LITERARY', 4],
  ['Anglais', 'ANG', 'LITERARY', 3],
  ['Histoire-Géographie', 'HG', 'LITERARY', 2],
  ['Éducation à la citoyenneté', 'ECM', 'LITERARY', 2],
  ['Mathématiques', 'MATH', 'SCIENTIFIC', 4],
  ['Physique-Chimie-Technologie', 'PCT', 'SCIENTIFIC', 2],
  ['Sciences de la vie et de la Terre', 'SVT', 'SCIENTIFIC', 2],
  ['Éducation physique et sportive', 'EPS', 'OTHER', 2],
];
const FIRST = ['Grâce', 'Junior', 'Estelle', 'Cédric', 'Rachel', 'Franck', 'Aïcha', 'Brice'];
const LAST = ['Abena', 'Atangana', 'Bilong', 'Djoumessi', 'Ekotto', 'Fouda', 'Mballa', 'Owona'];
const TEACHERS_PER_SUBJECT = 3;

export interface LoadSchool {
  slug: string;
  director: string;
  secretaries: string[];
  accountants: string[];
  teachers: { email: string; classSubjectIds: string[] }[];
  classIds: string[];
  term1Id: string;
  /** Séquence ouverte à la saisie pendant le test (2e trimestre). */
  sequenceId: string;
  parents: { phone: string; studentId: string }[];
}

export interface LoadFixtures {
  password: string;
  schools: LoadSchool[];
}

/** Exécute `fn` sur chaque élément, `concurrency` à la fois. */
async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i] as T, i);
      }
    }),
  );
}

async function main(): Promise<void> {
  loadDotEnv();
  if (process.env.LOADTEST_SEED !== 'oui') {
    throw new Error('Générateur de charge : définir LOADTEST_SEED=oui (base de test uniquement)');
  }
  const schoolCount = Number(process.argv[2] ?? 5);
  const studentsPerSchool = Number(process.argv[3] ?? 1500);
  const output = process.argv[4] ?? 'loadtest-fixtures.json';
  const base = new PrismaClient();
  const { AppModule } = await import('../app.module');
  const { AuthService } = await import('../modules/auth/auth.service');
  const { StudentsService } = await import('../modules/students/students.service');
  const { FinanceService } = await import('../modules/finance/finance.service');
  const { GradesService } = await import('../modules/grades/grades.module');
  const { ReportCardsService } = await import('../modules/report-cards/report-cards.service');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const studentsSvc = app.get(StudentsService);
  const finance = app.get(FinanceService);
  const grades = app.get(GradesService);
  const cards = app.get(ReportCardsService);
  const passwordHash = await AuthService.hashPassword(LOADTEST_PASSWORD);
  const fixtures: LoadFixtures = { password: LOADTEST_PASSWORD, schools: [] };
  const started = Date.now();
  const log = (msg: string) =>
    console.log(`[${Math.round((Date.now() - started) / 1000)} s] ${msg}`);

  for (let s = 1; s <= schoolCount; s++) {
    const slug = `charge-${s}`;
    if (await base.school.findUnique({ where: { slug } })) {
      throw new Error(`L'établissement ${slug} existe déjà : utiliser une base vide`);
    }
    const school = await base.school.create({
      data: {
        name: `Lycée de charge ${s}`,
        slug,
        city: ['Yaoundé', 'Douala', 'Bafoussam', 'Garoua', 'Bamenda'][(s - 1) % 5] ?? 'Yaoundé',
        matriculePrefix: `L${s}`,
      },
    });
    const schoolId = school.id;
    const user = async (email: string, roles: StaffRole[]) => {
      const u = await base.user.create({
        data: { email, firstName: 'Personnel', lastName: `Charge ${s}`, passwordHash },
      });
      await base.membership.create({ data: { userId: u.id, schoolId, roles } });
      return u.id;
    };
    const ctx = (userId: string, roles: StaffRole[]): StaffContext => ({
      kind: 'staff',
      userId,
      schoolId,
      roles,
      permissions: permissionsForRoles(roles),
      isPlatformAdmin: false,
      breakGlass: false,
    });
    const director = await user(`direction@${slug}.cm`, ['DIRECTOR']);
    const secretaries: string[] = [];
    const accountants: string[] = [];
    for (let i = 1; i <= 3; i++) {
      await user(`secretariat${i}@${slug}.cm`, ['SECRETARY']);
      secretaries.push(`secretariat${i}@${slug}.cm`);
      await user(`compta${i}@${slug}.cm`, ['ACCOUNTANT']);
      accountants.push(`compta${i}@${slug}.cm`);
    }
    const secretaryCtx = ctx(
      (await base.user.findUniqueOrThrow({ where: { email: secretaries[0] } })).id,
      ['SECRETARY'],
    );

    const year = await base.academicYear.create({
      data: {
        schoolId,
        name: '2026-2027',
        startDate: toDbDate('2026-09-07'),
        endDate: toDbDate('2027-06-30'),
        isCurrent: true,
      },
    });
    const terms: string[] = [];
    const sequences: string[] = [];
    for (const [i, [start, end]] of [
      ['2026-09-07', '2026-12-18'],
      ['2027-01-04', '2027-03-26'],
      ['2027-04-06', '2027-06-30'],
    ].entries()) {
      const term = await base.term.create({
        data: {
          schoolId,
          academicYearId: year.id,
          name: `${i + 1}${i ? 'e' : 'er'} trimestre`,
          order: i + 1,
          startDate: toDbDate(start ?? ''),
          endDate: toDbDate(end ?? ''),
        },
      });
      terms.push(term.id);
      for (const o of [1, 2]) {
        const seq = await base.sequence.create({
          data: { schoolId, termId: term.id, name: `Séquence ${i * 2 + o}`, order: o },
        });
        sequences.push(seq.id);
      }
    }
    const cycle = await base.cycle.create({
      data: { schoolId, name: 'Enseignement général', order: 1 },
    });
    const classIds: string[] = [];
    for (const [i, [levelName, count]] of LEVELS.entries()) {
      const level = await base.level.create({
        data: { schoolId, cycleId: cycle.id, name: levelName, order: i + 1 },
      });
      for (let c = 0; c < count; c++) {
        const cls = await base.class.create({
          data: {
            schoolId,
            academicYearId: year.id,
            levelId: level.id,
            name: `${levelName} ${String.fromCharCode(65 + c)}`,
            capacity: 60,
          },
        });
        classIds.push(cls.id);
      }
    }
    // Enseignants : trois par matière, chacun dans un tiers des classes.
    const teachers: LoadSchool['teachers'] = [];
    const teacherIds: string[] = [];
    for (const [si, [, code]] of SUBJECTS.entries()) {
      for (let t = 0; t < TEACHERS_PER_SUBJECT; t++) {
        const email = `prof.${code.toLowerCase()}${t + 1}@${slug}.cm`;
        teacherIds[si * TEACHERS_PER_SUBJECT + t] = await user(email, ['TEACHER']);
        teachers.push({ email, classSubjectIds: [] });
      }
    }
    const classSubjects: { id: string; classId: string; teacher: number }[] = [];
    for (const [si, [name, code, group, coefficient]] of SUBJECTS.entries()) {
      const subject = await base.subject.create({ data: { schoolId, name, code, group } });
      for (const [ci, classId] of classIds.entries()) {
        const teacher = si * TEACHERS_PER_SUBJECT + (ci % TEACHERS_PER_SUBJECT);
        const cs = await base.classSubject.create({
          data: {
            schoolId,
            classId,
            subjectId: subject.id,
            coefficient,
            teacherId: teacherIds[teacher],
            weeklyHours: coefficient > 2 ? 4 : 2,
          },
        });
        classSubjects.push({ id: cs.id, classId, teacher });
        teachers[teacher]?.classSubjectIds.push(cs.id);
      }
    }
    for (const [i, [name, amount, dueDate]] of (
      [
        ['Inscription', 25000, '2026-09-07'],
        ['Tranche 1', 70000, '2026-09-30'],
        ['Tranche 2', 50000, '2026-11-15'],
        ['Tranche 3', 30000, '2027-01-15'],
        ['Cotisation APEE', 10000, '2026-09-30'],
      ] as const
    ).entries()) {
      await base.feeItem.create({
        data: {
          schoolId,
          academicYearId: year.id,
          name,
          amount,
          dueDate: toDbDate(dueDate),
          order: i + 1,
        },
      });
    }

    // Élèves inscrits par le service (matricule, facture, pièces du dossier), un parent chacun.
    const parents: LoadSchool['parents'] = [];
    const byClass = new Map<string, string[]>();
    await pool(
      Array.from({ length: studentsPerSchool }, (_, i) => i),
      6,
      async (i) => {
        const classId = classIds[i % classIds.length] ?? '';
        const phone = `+23767${String(s * 100000 + i).padStart(7, '0')}`;
        const female = i % 2 === 0;
        const st = await runInContext(secretaryCtx, () =>
          studentsSvc.create({
            firstName: FIRST[i % FIRST.length] ?? 'Élève',
            lastName: `${LAST[(i * 3) % LAST.length]} ${i}`,
            gender: female ? 'F' : 'M',
            birthDate: `2012-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
            birthPlace: 'Yaoundé',
            nationality: 'Camerounaise',
            photoConsent: false,
            classId,
            confirmNotDuplicate: true,
            guardians: [
              {
                firstName: 'Parent',
                lastName: `Charge ${i}`,
                phone,
                relationship: female ? 'MOTHER' : 'FATHER',
                isPrimary: true,
                isEmergencyContact: true,
                canPickUp: true,
              },
            ],
          }),
        );
        parents[i] = { phone, studentId: st.id };
        const list = byClass.get(classId) ?? [];
        list.push(st.id);
        byClass.set(classId, list);
      },
    );
    log(`${slug} : ${studentsPerSchool} élèves inscrits`);

    // Paiements de rentrée : deux familles sur trois ont versé inscription et tranche 1.
    await pool(parents, 6, async (p, i) => {
      if (i % 3 === 0) return;
      await runAsSystem(
        'loadtest-payment',
        () =>
          finance.createPayment({
            studentId: p.studentId,
            amount: i % 3 === 1 ? 95000 : 25000,
            method: 'BANK',
            bankName: 'Banque partenaire',
            bankReference: `VIR-${s}-${i}`,
            idempotencyKey: randomUUID(),
          }),
        schoolId,
      );
    });
    log(`${slug} : paiements enregistrés`);

    // Notes du 1er trimestre (séquences 1 et 2) : une composition par matière, soumise.
    await pool(classSubjects, 4, async (cs) => {
      const teacherCtx = ctx(teacherIds[cs.teacher] ?? '', ['TEACHER']);
      const ids = byClass.get(cs.classId) ?? [];
      for (const sequenceId of sequences.slice(0, 2)) {
        const ev = await runInContext(teacherCtx, () =>
          grades.createEvaluation({
            classSubjectId: cs.id,
            sequenceId,
            name: 'Composition',
            type: 'EXAM',
            weight: 1,
            maxScore: 20,
          }),
        );
        await runInContext(teacherCtx, () =>
          grades.upsertGrades(
            ev.id,
            ids.map((studentId, k) => ({
              studentId,
              value: String(5 + ((k * 7 + cs.teacher) % 15)),
            })),
          ),
        );
        await runInContext(teacherCtx, () => grades.submit(cs.id, sequenceId));
      }
    });
    log(`${slug} : notes du 1er trimestre saisies`);

    // Bulletins du 1er trimestre préparés puis publiés par la direction.
    const directorCtx = ctx(director, ['DIRECTOR']);
    for (const classId of classIds) {
      await runInContext(directorCtx, () => cards.generate(classId, terms[0] ?? ''));
      await runInContext(directorCtx, () =>
        cards.publish(classId, terms[0] ?? '', 'Jeu de données de charge'),
      );
    }
    log(`${slug} : bulletins publiés`);

    fixtures.schools.push({
      slug,
      director: `direction@${slug}.cm`,
      secretaries,
      accountants,
      teachers,
      classIds,
      term1Id: terms[0] ?? '',
      sequenceId: sequences[2] ?? '',
      parents,
    });
  }
  // Les SMS générés (avis de publication, reçus) ne partent pas : considérés comme envoyés.
  await base.notificationOutbox.updateMany({
    where: { status: 'PENDING' },
    data: { status: 'SENT', sentAt: new Date() },
  });
  writeFileSync(output, JSON.stringify(fixtures));
  log(`Terminé : ${schoolCount} établissements, fichier ${output}`);
  await app.close();
  await base.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
