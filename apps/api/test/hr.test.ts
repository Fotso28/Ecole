import type { INestApplication } from '@nestjs/common';
import { computePayslip, DEFAULT_PAYROLL_SCALE } from '@ecole/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedSchool, sessions, type SchoolFixture } from './fixtures';
import {
  createPlatformAdmin,
  createStaff,
  createTestApp,
  login,
  loginPlatformAdmin,
  prisma,
  resetDb,
  type Session,
} from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function enableHr(schoolId: string) {
  const school = await prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
  await prisma.school.update({
    where: { id: schoolId },
    data: { modules: [...school.modules, 'hr'] },
  });
}

async function createFile(
  session: Session,
  userId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await http()
    .post('/hr/employees')
    .set(session.auth)
    .send({ userId, position: 'Enseignant', hireDate: '2026-09-01', ...extra })
    .expect(201);
  return res.body.id as string;
}

async function addContract(session: Session, employeeId: string, body: Record<string, unknown>) {
  return http().post(`/hr/employees/${employeeId}/contracts`).set(session.auth).send(body);
}

/** Cours hebdomadaire de l'emploi du temps (lecture seule pour le module RH). */
async function weeklyLesson(classSubjectId: string, dayOfWeek: number, start: string, end: string) {
  const cs = await prisma.classSubject.findUniqueOrThrow({ where: { id: classSubjectId } });
  return prisma.timetableEntry.create({
    data: {
      schoolId: f.schoolId,
      academicYearId: f.yearId,
      classId: cs.classId,
      classSubjectId,
      teacherId: cs.teacherId,
      dayOfWeek,
      startTime: start,
      endTime: end,
    },
  });
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
  await enableHr(f.schoolId);
  s = await sessions(app);
});

describe('module RH : accès', () => {
  it('est refusé si le module n’est pas activé pour l’école', async () => {
    const school = await prisma.school.findUniqueOrThrow({ where: { id: f.schoolId } });
    await prisma.school.update({
      where: { id: f.schoolId },
      data: { modules: school.modules.filter((m) => m !== 'hr') },
    });
    const res = await http().get('/hr/employees').set(s.direction.auth).expect(403);
    expect(res.body.message).toBe('Module non activé pour cet établissement');
  });

  it('réserve les dossiers à la direction et à la comptabilité', async () => {
    await http().get('/hr/employees').set(s.prof.auth).expect(403);
    await http().get('/hr/employees').set(s.secretariat.auth).expect(403);
    await http().get('/hr/employees').set(s.censeur.auth).expect(403);
    await http().get('/hr/employees').set(s.compta.auth).expect(200);
    await http().get('/hr/employees').set(s.direction.auth).expect(200);
    // La comptabilité prépare, mais ne valide pas.
    await http().post('/hr/payroll/2026-10/validate').set(s.compta.auth).expect(403);
    await http()
      .post('/hr/scales')
      .set(s.compta.auth)
      .send({ ...DEFAULT_PAYROLL_SCALE, effectiveFrom: '2026-11-01' })
      .expect(403);
  });
});

describe('dossiers du personnel', () => {
  it('chiffre les données sensibles et journalise leur consultation', async () => {
    const id = await createFile(s.compta, f.users.teacher, {
      payoutMethod: 'BANK',
      diplomas: [
        { title: 'Licence de mathématiques', year: 2015, institution: 'Université de Yaoundé I' },
      ],
      sensitive: {
        cnpsNumber: '123456789012',
        idNumber: 'CNI 112233445',
        bankName: 'Afriland First Bank',
        bankAccount: '10005 00001 01234567890 12',
        address: 'Bastos, Yaoundé',
      },
    });
    const stored = await prisma.employeeFile.findUniqueOrThrow({ where: { id } });
    expect(stored.encryptedSensitive).toBeTruthy();
    expect(stored.encryptedSensitive).not.toContain('123456789012');
    expect(stored.encryptedSensitive).not.toContain('Afriland');

    const detail = await http().get(`/hr/employees/${id}`).set(s.direction.auth).expect(200);
    expect(detail.body.sensitive.cnpsNumber).toBe('•••• 9012');
    expect(detail.body.sensitive.bankAccount).toBe('•••• 9012');
    expect(detail.body.sensitive.filled).toEqual(
      expect.arrayContaining(['cnpsNumber', 'idNumber', 'bankName', 'bankAccount', 'address']),
    );
    expect(JSON.stringify(detail.body)).not.toContain('123456789012');
    expect(detail.body.diplomas).toEqual([
      { title: 'Licence de mathématiques', year: 2015, institution: 'Université de Yaoundé I' },
    ]);

    await http().post(`/hr/employees/${id}/sensitive`).set(s.direction.auth).send({}).expect(400);
    const plain = await http()
      .post(`/hr/employees/${id}/sensitive`)
      .set(s.direction.auth)
      .send({ reason: 'Déclaration CNPS du mois' })
      .expect(201);
    expect(plain.body.cnpsNumber).toBe('123456789012');
    expect(plain.body.bankAccount).toBe('10005 00001 01234567890 12');

    const reads = await prisma.auditLog.findMany({ where: { action: 'hr.sensitive_read' } });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      entityId: id,
      actorId: f.users.director,
      reason: 'Déclaration CNPS du mois',
    });
    // Le journal ne contient jamais la valeur en clair.
    const logs = await prisma.auditLog.findMany({ where: { entity: 'EmployeeFile' } });
    expect(JSON.stringify(logs)).not.toContain('123456789012');

    // Mise à jour partielle : les autres champs sensibles sont conservés.
    await http()
      .patch(`/hr/employees/${id}`)
      .set(s.compta.auth)
      .send({ position: 'Professeur de mathématiques', sensitive: { cnpsNumber: '999988887777' } })
      .expect(200);
    const after = await http()
      .post(`/hr/employees/${id}/sensitive`)
      .set(s.compta.auth)
      .send({ reason: 'Vérification après mise à jour' })
      .expect(201);
    expect(after.body.cnpsNumber).toBe('999988887777');
    expect(after.body.bankName).toBe('Afriland First Bank');
  });

  it('refuse un second dossier pour la même personne', async () => {
    await createFile(s.compta, f.users.teacher);
    await http()
      .post('/hr/employees')
      .set(s.compta.auth)
      .send({ userId: f.users.teacher, position: 'X', hireDate: '2026-09-01' })
      .expect(409);
    const candidates = await http().get('/hr/employees/candidates').set(s.compta.auth).expect(200);
    expect(candidates.body.map((c: { id: string }) => c.id)).not.toContain(f.users.teacher);
  });

  it('gère les contrats et alerte avant l’échéance d’un CDD', async () => {
    const id = await createFile(s.compta, f.users.teacher2);
    const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await addContract(s.compta, id, { type: 'CDD', startDate: '2026-09-01' }).then((r) =>
      expect(r.status).toBe(400),
    );
    const cdd = await addContract(s.compta, id, {
      type: 'CDD',
      startDate: '2026-09-01',
      endDate: soon,
      baseSalary: 150_000,
    });
    expect(cdd.status).toBe(201);
    expect(cdd.body.endingSoon).toBe(true);
    const alerts = await http().get('/hr/alerts').set(s.direction.auth).expect(200);
    expect(alerts.body).toHaveLength(1);
    // 20 jours à l'heure UTC, 19 ou 20 selon l'heure au Cameroun.
    expect(alerts.body[0].contract.daysLeft).toBeGreaterThanOrEqual(19);
    expect(alerts.body[0].contract.daysLeft).toBeLessThanOrEqual(20);

    // Renouvellement en CDI : le CDD prend fin la veille, l'alerte disparaît.
    const next = new Date(Date.parse(soon) + 86_400_000).toISOString().slice(0, 10);
    const cdi = await addContract(s.compta, id, {
      type: 'CDI',
      startDate: next,
      baseSalary: 160_000,
    });
    expect(cdi.status).toBe(201);
    const detail = await http().get(`/hr/employees/${id}`).set(s.compta.auth).expect(200);
    expect(detail.body.contract.type).toBe('CDI');
    expect(detail.body.contracts).toHaveLength(2);
    expect(detail.body.contracts[1].endDate).toBe(soon);
    expect(detail.body.contracts[1].endedAt).toBeTruthy();
    expect((await http().get('/hr/alerts').set(s.direction.auth)).body).toHaveLength(0);
    const audit = await prisma.auditLog.count({ where: { action: 'hr.contract_created' } });
    expect(audit).toBe(2);
  });
});

describe('heures de cours', () => {
  it('compare les heures prévues et faites, avec motif des absences et heures supplémentaires', async () => {
    // Lundis d'octobre 2026 : 5, 12, 19 et 26.
    const entry = await weeklyLesson(f.cs.maths4A, 1, '08:00', '10:00');
    const month = () =>
      http().get(`/hr/hours?teacherId=${f.users.teacher}&month=2026-10`).set(s.compta.auth);
    const initial = await month().expect(200);
    expect(initial.body.lessons).toHaveLength(4);
    expect(initial.body.lessons[0]).toMatchObject({
      date: '2026-10-05',
      className: '4e A',
      subject: 'Mathématiques',
      minutes: 120,
      status: null,
    });
    expect(initial.body.totals.plannedMinutes).toBe(480);

    const mark = (date: string, body: Record<string, unknown>) =>
      http()
        .post('/hr/hours/lessons')
        .set(s.compta.auth)
        .send({ timetableEntryId: entry.id, date, ...body });
    await mark('2026-10-05', { status: 'DONE' }).expect(201);
    await mark('2026-10-12', { status: 'ABSENT' }).expect(400); // motif obligatoire
    await mark('2026-10-12', { status: 'ABSENT', reason: 'Absence sans prévenir' }).expect(201);
    await mark('2026-10-19', { status: 'ABSENT', justified: true, reason: 'Maladie' }).expect(201);
    await mark('2026-10-06', { status: 'DONE' }).expect(400); // pas de cours le mardi
    await mark('2027-03-01', { status: 'DONE' }).expect(400); // cours à venir
    await http().post('/hr/hours/lessons').set(s.prof.auth).send({}).expect(403);

    await http()
      .post('/hr/hours/overtime')
      .set(s.compta.auth)
      .send({
        teacherId: f.users.teacher,
        date: '2026-10-24',
        minutes: 90,
        reason: 'Cours de rattrapage',
      })
      .expect(201);

    const after = await month().expect(200);
    expect(after.body.totals).toEqual({
      plannedMinutes: 480,
      doneMinutes: 120,
      absentJustifiedMinutes: 120,
      absentUnjustifiedMinutes: 120,
      unmarkedMinutes: 120,
      overtimeMinutes: 90,
    });
    expect(after.body.lessons[1]).toMatchObject({
      status: 'ABSENT',
      reason: 'Absence sans prévenir',
    });

    const confirmed = await http()
      .post('/hr/hours/confirm')
      .set(s.compta.auth)
      .send({ teacherId: f.users.teacher, month: '2026-10' })
      .expect(201);
    expect(confirmed.body.count).toBe(1);
    expect((await month()).body.totals.doneMinutes).toBe(240);
    const logs = await prisma.auditLog.count({ where: { action: { startsWith: 'hr.' } } });
    expect(logs).toBeGreaterThanOrEqual(5);
  });

  it('exclut les jours fériés du calendrier', async () => {
    await weeklyLesson(f.cs.maths4A, 1, '08:00', '10:00');
    await prisma.schoolEvent.create({
      data: {
        schoolId: f.schoolId,
        title: 'Congé',
        category: 'HOLIDAY',
        scope: 'SCHOOL',
        startDate: new Date('2026-10-12'),
        endDate: new Date('2026-10-13'),
        authorId: f.users.director,
      },
    });
    const res = await http()
      .get(`/hr/hours?teacherId=${f.users.teacher}&month=2026-10`)
      .set(s.compta.auth)
      .expect(200);
    expect(res.body.lessons.map((l: { date: string }) => l.date)).toEqual([
      '2026-10-05',
      '2026-10-19',
      '2026-10-26',
    ]);
  });
});

describe('paie mensuelle', () => {
  let teacherFile: string;
  let vacataireFile: string;
  let director2: Session;

  beforeEach(async () => {
    await createStaff(f.schoolId, 'direction2@demo.cm', ['DIRECTOR']);
    director2 = await login(app, 'direction2@demo.cm');
    teacherFile = await createFile(s.compta, f.users.teacher, {
      payoutMethod: 'BANK',
      sensitive: { cnpsNumber: '111122223333', bankName: 'SGC', bankAccount: 'CM21 0001 2345' },
    });
    vacataireFile = await createFile(s.compta, f.users.teacher2, {
      position: 'Vacataire de français',
      payoutMethod: 'MOBILE_MONEY',
      sensitive: { mobileMoneyNumber: '677123456', mobileMoneyOperator: 'MTN' },
    });
    expect(
      (
        await addContract(s.compta, teacherFile, {
          type: 'CDI',
          startDate: '2026-09-01',
          baseSalary: 200_000,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await addContract(s.compta, vacataireFile, {
          type: 'HOURLY',
          startDate: '2026-09-01',
          hourlyRate: 2500,
        })
      ).status,
    ).toBe(201);
    const maths = await weeklyLesson(f.cs.maths4A, 1, '08:00', '10:00');
    await weeklyLesson(f.cs.francais4A, 3, '10:00', '12:00');
    // Enseignant salarié : un cours fait, une absence non justifiée (1/4 des heures prévues).
    for (const [date, body] of [
      ['2026-10-05', { status: 'DONE' }],
      ['2026-10-12', { status: 'ABSENT', reason: 'Absence sans prévenir' }],
    ] as const) {
      await http()
        .post('/hr/hours/lessons')
        .set(s.compta.auth)
        .send({ timetableEntryId: maths.id, date, ...body })
        .expect(201);
    }
    // Vacataire : 4 mercredis faits (8 h) et 1 h 30 supplémentaire.
    await http()
      .post('/hr/hours/confirm')
      .set(s.compta.auth)
      .send({ teacherId: f.users.teacher2, month: '2026-10' })
      .expect(201);
    await http()
      .post('/hr/hours/overtime')
      .set(s.compta.auth)
      .send({ teacherId: f.users.teacher2, date: '2026-10-17', minutes: 90, reason: 'Soutien' })
      .expect(201);
  });

  const slipOf = (body: { payslips: { employeeId: string }[] }, employeeId: string) =>
    body.payslips.find((p) => p.employeeId === employeeId) as unknown as {
      id: string;
      gross: number;
      net: number;
      result: ReturnType<typeof computePayslip>;
    };

  it('calcule, fait valider par une autre personne, puis fige la paie', async () => {
    // Avance : demandée par la comptabilité, accordée par la direction.
    const adv = await http()
      .post('/hr/advances')
      .set(s.compta.auth)
      .send({
        employeeId: teacherFile,
        amount: 60_000,
        installments: 2,
        firstMonth: '2026-10',
        reason: 'Frais médicaux',
      })
      .expect(201);
    await http()
      .post(`/hr/advances/${adv.body.id}/approve`)
      .set(s.compta.auth)
      .send({})
      .expect(403);
    await http()
      .post(`/hr/advances/${adv.body.id}/approve`)
      .set(s.direction.auth)
      .send({})
      .expect(201);
    // Versée par la comptabilité : elle se rembourse dès lors par retenue sur la paie.
    await http()
      .post(`/hr/advances/${adv.body.id}/pay`)
      .set(s.compta.auth)
      .send({ date: '2026-10-02', method: 'CASH' })
      .expect(201);

    const computed = await http()
      .post('/hr/payroll/2026-10/compute')
      .set(s.compta.auth)
      .expect(201);
    expect(computed.body.status).toBe('DRAFT');
    expect(computed.body.payslips).toHaveLength(2);

    const teacher = slipOf(computed.body, teacherFile);
    const expectedTeacher = computePayslip(
      {
        contractType: 'CDI',
        baseEarned: 200_000,
        overtimePay: 0,
        absenceDeduction: 50_000, // 2 h non justifiées sur 8 h prévues
        elements: [],
        advanceDue: 30_000,
      },
      DEFAULT_PAYROLL_SCALE,
    );
    expect(teacher.result).toEqual(expectedTeacher);
    expect(teacher.result.advanceDeduction).toBe(30_000);

    const vacataire = slipOf(computed.body, vacataireFile);
    expect(vacataire.result.baseEarned).toBe(20_000); // 8 h × 2 500
    expect(vacataire.result.overtimePay).toBe(3750); // 1 h 30 au taux horaire
    expect(vacataire.result.employee.irpp).toBe(0);

    // Prime saisie par la comptabilité : recalcul du bulletin.
    const updated = await http()
      .put(`/hr/payroll/2026-10/payslips/${vacataire.id}`)
      .set(s.compta.auth)
      .send({
        elements: [
          { kind: 'BONUS', label: 'Prime de surveillance', amount: 5000, taxable: true },
          { kind: 'ALLOWANCE', label: 'Transport', amount: 3000, taxable: false },
        ],
        absenceDays: 0,
      })
      .expect(200);
    expect(updated.body.result.grossTaxable).toBe(28_750);
    expect(updated.body.gross).toBe(31_750);

    // Pas d'état des virements avant validation.
    await http().get('/hr/payroll/2026-10/transfers').set(s.compta.auth).expect(409);
    await http().get('/hr/payroll/2026-10/summary').set(s.compta.auth).expect(409);

    // Soumission par la comptabilité : la direction est prévenue par la table d'envoi.
    await http().post('/hr/payroll/2026-10/validate').set(s.direction.auth).expect(409);
    const submitted = await http()
      .post('/hr/payroll/2026-10/submit')
      .set(s.compta.auth)
      .expect(201);
    expect(submitted.body.status).toBe('PREPARED');
    const outbox = await prisma.notificationOutbox.findMany({
      where: { template: 'payrollSubmitted' },
    });
    expect(outbox.length).toBe(2); // les deux directeurs
    await http()
      .put(`/hr/payroll/2026-10/payslips/${vacataire.id}`)
      .set(s.compta.auth)
      .send({ elements: [], absenceDays: 0 })
      .expect(409);

    // Renvoi motivé, nouvelle soumission, puis validation.
    await http()
      .post('/hr/payroll/2026-10/reject')
      .set(s.direction.auth)
      .send({ reason: 'Vérifier la prime' })
      .expect(201);
    expect((await http().get('/hr/payroll/2026-10').set(s.compta.auth)).body).toMatchObject({
      status: 'DRAFT',
      rejectReason: 'Vérifier la prime',
    });
    await http().post('/hr/payroll/2026-10/submit').set(s.compta.auth).expect(201);
    const validated = await http()
      .post('/hr/payroll/2026-10/validate')
      .set(s.direction.auth)
      .expect(201);
    expect(validated.body.status).toBe('VALIDATED');
    expect(validated.body.validatedBy).toContain('direction');
    expect(validated.body.payslips.map((p: { number: string }) => p.number).sort()).toEqual([
      'PAIE-2026-10-0001',
      'PAIE-2026-10-0002',
    ]);

    // Paie figée : ni recalcul, ni saisie, ni heures du mois, ni modification directe en base.
    await http().post('/hr/payroll/2026-10/compute').set(s.compta.auth).expect(409);
    await http()
      .put(`/hr/payroll/2026-10/payslips/${vacataire.id}`)
      .set(s.compta.auth)
      .send({ elements: [], absenceDays: 0 })
      .expect(409);
    await http()
      .post('/hr/hours/overtime')
      .set(s.compta.auth)
      .send({
        teacherId: f.users.teacher2,
        date: '2026-10-20',
        minutes: 60,
        reason: 'Ajout tardif',
      })
      .expect(409);
    await expect(
      prisma.payslip.update({ where: { id: vacataire.id }, data: { net: 1 } }),
    ).rejects.toThrow(/figé/);
    await expect(
      prisma.payrollRun.updateMany({ where: { month: '2026-10' }, data: { status: 'DRAFT' } }),
    ).rejects.toThrow(/figée/);
    await expect(prisma.payslip.delete({ where: { id: vacataire.id } })).rejects.toThrow(/figé/);

    // Avance : première mensualité remboursée, ajout seul.
    const repayments = await prisma.advanceRepayment.findMany();
    expect(repayments).toEqual([expect.objectContaining({ amount: 30_000, month: '2026-10' })]);
    await expect(
      prisma.advanceRepayment.update({ where: { id: repayments[0]!.id }, data: { amount: 1 } }),
    ).rejects.toThrow(/ajout seul/);

    // Bulletins en PDF et état des virements, journalisés.
    const pdf = await http()
      .get('/hr/payroll/2026-10/payslips.pdf')
      .set(s.direction.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const one = await http()
      .get(`/hr/payroll/2026-10/payslips/${teacher.id}/pdf`)
      .set(s.compta.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(one.headers['content-type']).toBe('application/pdf');

    const csv = await http()
      .get('/hr/payroll/2026-10/transfers?format=csv')
      .set(s.compta.auth)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('aucun virement');
    expect(csv.text).toContain('CM21 0001 2345');
    expect(csv.text).toContain('677123456');
    expect(csv.text).toContain(`;${teacher.net}`);
    const xlsx = await http()
      .get('/hr/payroll/2026-10/transfers?format=xlsx')
      .set(s.compta.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    await http().get('/hr/payroll/2026-10/transfers').set(s.direction.auth).expect(200);
    const exported = await prisma.auditLog.findMany({ where: { action: 'hr.transfers_exported' } });
    expect(exported).toHaveLength(3);
    for (const action of [
      'hr.payroll_submitted',
      'hr.payroll_validated',
      'hr.payroll_rejected',
      'hr.payslips_printed',
      'hr.payslip_printed',
      'hr.advance_approved',
    ])
      expect(await prisma.auditLog.count({ where: { action } }), action).toBeGreaterThan(0);
    expect(await prisma.notificationOutbox.count({ where: { template: 'payrollValidated' } })).toBe(
      1,
    );

    // Récapitulatif pour la comptabilité générale.
    const summary = await http().get('/hr/payroll/2026-10/summary').set(s.compta.auth).expect(200);
    expect(summary.body.headcount).toBe(2);
    expect(summary.body.net).toBe(validated.body.totals.net);
    expect(summary.body.advances).toBe(30_000);
    expect(summary.body.gross).toBe(
      summary.body.employee.total + summary.body.advances + summary.body.net,
    );

    // Mois suivant : seconde mensualité retenue, rappel négatif pour corriger octobre.
    await http().post('/hr/payroll/2026-11/compute').set(s.compta.auth).expect(201);
    const nov = await http().get('/hr/payroll/2026-11').set(s.compta.auth).expect(200);
    const novTeacher = slipOf(nov.body, teacherFile);
    expect(novTeacher.result.advanceDeduction).toBe(30_000);
    const recall = await http()
      .put(`/hr/payroll/2026-11/payslips/${novTeacher.id}`)
      .set(s.compta.auth)
      .send({
        elements: [
          {
            kind: 'RECALL',
            label: 'Rappel octobre 2026 : trop-perçu',
            amount: -5000,
            taxable: true,
          },
        ],
        absenceDays: 0,
      })
      .expect(200);
    expect(recall.body.result.grossTaxable).toBe(195_000);
    await http().post('/hr/payroll/2026-11/submit').set(s.compta.auth).expect(201);
    await http().post('/hr/payroll/2026-11/validate').set(director2.auth).expect(201);
    const advance = await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: adv.body.id } });
    expect(advance.status).toBe('REPAID');
  });

  it('ne retient pas une avance accordée mais pas encore versée', async () => {
    // Cas d'Eyenga : 50 000 FCFA en 2 × 25 000 dès octobre, accordés mais jamais versés.
    const adv = await http()
      .post('/hr/advances')
      .set(s.compta.auth)
      .send({
        employeeId: teacherFile,
        amount: 50_000,
        installments: 2,
        firstMonth: '2026-10',
        reason: 'Frais de scolarité des enfants',
      })
      .expect(201);
    await http()
      .post(`/hr/advances/${adv.body.id}/approve`)
      .set(s.direction.auth)
      .send({})
      .expect(201);
    const computed = await http()
      .post('/hr/payroll/2026-10/compute')
      .set(s.compta.auth)
      .expect(201);
    const teacher = slipOf(computed.body, teacherFile);
    expect(teacher.result.advanceDeduction).toBe(0);
    await http().post('/hr/payroll/2026-10/submit').set(s.compta.auth).expect(201);
    await http().post('/hr/payroll/2026-10/validate').set(s.direction.auth).expect(201);
    expect(await prisma.advanceRepayment.count()).toBe(0);
    const listed = await http().get('/hr/advances').set(s.compta.auth).expect(200);
    expect(listed.body[0]).toMatchObject({ status: 'APPROVED', repaid: 0, payout: null });

    // Une fois versée (après la paie d'octobre), la première mensualité est retenue en novembre.
    await http()
      .post(`/hr/advances/${adv.body.id}/pay`)
      .set(s.compta.auth)
      .send({ date: '2026-10-30', method: 'MTN_MOMO' })
      .expect(201);
    const nov = await http().post('/hr/payroll/2026-11/compute').set(s.compta.auth).expect(201);
    expect(slipOf(nov.body, teacherFile).result.advanceDeduction).toBe(25_000);
  });

  it('avances : alerte au-delà du tiers du salaire, refus motivé, pas de retenue sur une paie figée', async () => {
    const ask = (body: Record<string, unknown>) =>
      http()
        .post('/hr/advances')
        .set(s.compta.auth)
        .send({
          employeeId: teacherFile,
          installments: 3,
          firstMonth: '2026-11',
          reason: 'Travaux',
          ...body,
        });
    // 900 000 FCFA en 3 mensualités de 300 000 sur un salaire de 200 000 : alerte.
    const big = await ask({ amount: 900_000 }).expect(201);
    const small = await ask({ amount: 90_000 }).expect(201);
    const listed = (await http().get('/hr/advances').set(s.direction.auth).expect(200)).body as {
      id: string;
      shareAlert: boolean;
      baseSalary: number | null;
    }[];
    expect(listed.find((a) => a.id === big.body.id)).toMatchObject({
      shareAlert: true,
      baseSalary: 200_000,
    });
    expect(listed.find((a) => a.id === small.body.id)?.shareAlert).toBe(false);

    // Refus : motif obligatoire, conservé et journalisé.
    const noReason = await http()
      .post(`/hr/advances/${big.body.id}/reject`)
      .set(s.direction.auth)
      .send({})
      .expect(400);
    expect(noReason.body.message).toBe('Motif : Champ obligatoire');
    await http()
      .post(`/hr/advances/${big.body.id}/reject`)
      .set(s.direction.auth)
      .send({ reason: 'Retenue trop lourde pour le salaire' })
      .expect(201);
    expect(
      await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: big.body.id } }),
    ).toMatchObject({ status: 'REJECTED', decisionNote: 'Retenue trop lourde pour le salaire' });
    expect(
      (await prisma.auditLog.findFirstOrThrow({ where: { action: 'hr.advance_rejected' } })).reason,
    ).toBe('Retenue trop lourde pour le salaire');

    // Paie d'octobre validée : la première retenue ne peut plus y tomber.
    await http().post('/hr/payroll/2026-10/compute').set(s.compta.auth).expect(201);
    await http().post('/hr/payroll/2026-10/submit').set(s.compta.auth).expect(201);
    const submitted = await ask({ amount: 30_000, firstMonth: '2026-10' }).expect(409);
    expect(submitted.body.message).toBe(
      'La paie d’octobre 2026 est déjà soumise à validation : choisissez un mois suivant pour la première retenue',
    );
    await http().post('/hr/payroll/2026-10/validate').set(s.direction.auth).expect(201);
    const validated = await ask({ amount: 30_000, firstMonth: '2026-10' }).expect(409);
    expect(validated.body.message).toMatch(/^La paie d’octobre 2026 est déjà validée/);
  });

  it('refuse que la même personne prépare et valide', async () => {
    await http().post('/hr/payroll/2026-10/compute').set(s.direction.auth).expect(201);
    await http().post('/hr/payroll/2026-10/submit').set(s.direction.auth).expect(201);
    const res = await http().post('/hr/payroll/2026-10/validate').set(s.direction.auth).expect(403);
    expect(res.body.message).toContain('autre personne');
    await http()
      .post('/hr/payroll/2026-10/reject')
      .set(s.direction.auth)
      .send({ reason: 'Moi-même' })
      .expect(403);
    await http().post('/hr/payroll/2026-10/validate').set(director2.auth).expect(201);
  });

  it('refuse la validation à qui a modifié un bulletin de la paie', async () => {
    const computed = await http()
      .post('/hr/payroll/2026-10/compute')
      .set(s.compta.auth)
      .expect(201);
    // La direction s'ajoute une prime sur un bulletin, puis la comptabilité soumet sans la voir.
    await http()
      .put(`/hr/payroll/2026-10/payslips/${slipOf(computed.body, teacherFile).id}`)
      .set(s.direction.auth)
      .send({
        elements: [{ kind: 'BONUS', label: 'Prime exceptionnelle', amount: 90_000, taxable: true }],
        absenceDays: 0,
      })
      .expect(200);
    await http().post('/hr/payroll/2026-10/submit').set(s.compta.auth).expect(201);
    const res = await http().post('/hr/payroll/2026-10/validate').set(s.direction.auth).expect(403);
    expect(res.body.message).toContain('autre personne');
    await http().post('/hr/payroll/2026-10/validate').set(director2.auth).expect(201);
  });

  it('refuse les bulletins imprimés en accès exceptionnel (numéros CNPS en clair)', async () => {
    await http().post('/hr/payroll/2026-10/compute').set(s.compta.auth).expect(201);
    await http().post('/hr/payroll/2026-10/submit').set(s.compta.auth).expect(201);
    await http().post('/hr/payroll/2026-10/validate').set(s.direction.auth).expect(201);
    await createPlatformAdmin();
    const admin = await loginPlatformAdmin(app);
    const access = await http()
      .post(`/platform/schools/${f.schoolId}/access`)
      .set(admin.auth)
      .send({ reason: 'Assistance demandée par la direction' })
      .expect(201);
    const bg = { Authorization: `Bearer ${access.body.accessToken}` };
    await http().get('/hr/payroll/2026-10').set(bg).expect(200);
    await http().get('/hr/payroll/2026-10/payslips.pdf').set(bg).expect(403);
  });

  it('applique le barème daté en vigueur pour le mois', async () => {
    await http()
      .post('/hr/scales')
      .set(s.direction.auth)
      .send({
        ...DEFAULT_PAYROLL_SCALE,
        effectiveFrom: '2026-11-01',
        label: 'Barème novembre (test)',
        cnps: { ...DEFAULT_PAYROLL_SCALE.cnps, employeeRate: 500 },
      })
      .expect(201);
    const oct = await http().post('/hr/payroll/2026-10/compute').set(s.compta.auth).expect(201);
    expect(oct.body.scale.label).toBe(DEFAULT_PAYROLL_SCALE.label);
    const nov = await http().post('/hr/payroll/2026-11/compute').set(s.compta.auth).expect(201);
    expect(nov.body.scale.label).toBe('Barème novembre (test)');
    expect(slipOf(nov.body, teacherFile).result.employee.cnps).toBe(10_000);
    await expect(prisma.payrollScale.updateMany({ data: { label: 'modifié' } })).rejects.toThrow(
      /ajout seul/,
    );
  });
});

describe('isolation entre écoles', () => {
  it('une école ne voit ni ne modifie les dossiers et la paie d’une autre', async () => {
    const id = await createFile(s.compta, f.users.teacher, {
      sensitive: { cnpsNumber: '123412341234' },
    });
    await addContract(s.compta, id, { type: 'CDI', startDate: '2026-09-01', baseSalary: 180_000 });
    await http().post('/hr/payroll/2026-10/compute').set(s.compta.auth).expect(201);

    const other = await seedSchool('autre', 'AU');
    await enableHr(other.schoolId);
    const o = await sessions(app, 'autre');

    expect((await http().get('/hr/employees').set(o.direction.auth).expect(200)).body).toEqual([]);
    await http().get(`/hr/employees/${id}`).set(o.direction.auth).expect(404);
    await http()
      .post(`/hr/employees/${id}/sensitive`)
      .set(o.direction.auth)
      .send({ reason: 'Tentative inter-école' })
      .expect(404);
    await http()
      .patch(`/hr/employees/${id}`)
      .set(o.compta.auth)
      .send({ position: 'Piraté' })
      .expect(404);
    await addContract(o.compta, id, { type: 'CDI', startDate: '2026-10-01', baseSalary: 1 }).then(
      (r) => expect(r.status).toBe(404),
    );
    // Dossier pour un membre d'une autre école : refusé.
    await http()
      .post('/hr/employees')
      .set(o.compta.auth)
      .send({ userId: f.users.teacher, position: 'X', hireDate: '2026-09-01' })
      .expect(400);
    const otherRun = await http().get('/hr/payroll/2026-10').set(o.compta.auth).expect(200);
    expect(otherRun.body.status).toBeNull();
    expect(otherRun.body.payslips).toEqual([]);
    const computed = await http()
      .post('/hr/payroll/2026-10/compute')
      .set(o.compta.auth)
      .expect(201);
    expect(computed.body.payslips).toEqual([]);
    expect((await http().get('/hr/payroll/2026-10').set(s.compta.auth)).body.payslips).toHaveLength(
      1,
    );
    const file = await prisma.employeeFile.findUniqueOrThrow({ where: { id } });
    expect(file.position).toBe('Enseignant');
  });
});
