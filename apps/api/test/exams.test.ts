import type { INestApplication } from '@nestjs/common';
import { isValidAnonymityCode } from '@ecole/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, requestOtp, resetDb, toSession, type Session } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());

const ALL_MODULES = [
  'students',
  'attendance',
  'grades',
  'finance',
  'communication',
  'portal',
  'timetable',
  'exams',
];

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

async function enableExams(schoolId: string) {
  await prisma.school.update({ where: { id: schoolId }, data: { modules: ALL_MODULES } });
}

async function room(session: Session, name: string, capacity?: number) {
  const res = await http()
    .post('/timetable/rooms')
    .set(session.auth)
    .send({ name, ...(capacity ? { capacity } : {}) })
    .expect(201);
  return res.body.id as string;
}

async function createSession(session: Session, body: Record<string, unknown>) {
  const res = await http().post('/exams/sessions').set(session.auth).send(body);
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

function addPaper(session: Session, sessionId: string, body: Record<string, unknown>) {
  return http().post(`/exams/sessions/${sessionId}/papers`).set(session.auth).send(body);
}

/** Session de 4e A + 4e B (maths commune, français en 4e A), deux salles. */
async function plannedSession() {
  const students: Record<string, string> = {};
  for (const [first, last, cls] of [
    ['Marie', 'Ngono', f.class4AId],
    ['Paul', 'Atangana', f.class4AId],
    ['Estelle', 'Bilong', f.class4AId],
    ['Kevin', 'Tchana', f.class4BId],
    ['Joël', 'Mvondo', f.class4BId],
  ] as const) {
    students[last] = (
      await enrollStudent(app, s.secretariat, { firstName: first, lastName: last, classId: cls })
    ).id;
  }
  const b12 = await room(s.direction, 'B12', 3);
  const b14 = await room(s.direction, 'B14');
  const sessionId = await createSession(s.censeur, {
    name: 'Composition de la séquence 2',
    kind: 'SEQUENCE',
    sequenceId: f.seq2Id,
    startDate: '2026-11-16',
    endDate: '2026-11-18',
    classIds: [f.class4AId, f.class4BId],
    mixClasses: true,
  });
  const maths = await addPaper(s.censeur, sessionId, {
    subjectId: f.subjects.maths,
    date: '2026-11-16',
    startTime: '08:00',
    durationMinutes: 120,
  }).expect(201);
  const francais = await addPaper(s.censeur, sessionId, {
    subjectId: f.subjects.francais,
    date: '2026-11-16',
    startTime: '10:30',
    durationMinutes: 120,
    maxScore: 40,
  }).expect(201);
  return {
    students,
    b12,
    b14,
    sessionId,
    mathsId: maths.body.id as string,
    francaisId: francais.body.id as string,
  };
}

describe('module Examens', () => {
  beforeEach(async () => {
    await resetDb();
    f = await seedSchool();
    await enableExams(f.schoolId);
    s = await sessions(app);
  });

  it('refuse l’accès si le module n’est pas activé', async () => {
    await prisma.school.update({
      where: { id: f.schoolId },
      data: { modules: ALL_MODULES.filter((m) => m !== 'exams') },
    });
    await http().get('/exams/sessions').set(s.censeur.auth).expect(403);
  });

  it('planifie le calendrier et refuse les conflits de classe et de salle', async () => {
    const p = await plannedSession();
    expect(p.mathsId).toBeTruthy();
    // Par défaut, le français n'est proposé qu'aux classes qui l'étudient.
    const detail = await http()
      .get(`/exams/sessions/${p.sessionId}`)
      .set(s.censeur.auth)
      .expect(200);
    const fr = detail.body.papers.find((x: { id: string }) => x.id === p.francaisId);
    expect(fr.classes.map((c: { name: string }) => c.name)).toEqual(['4e A']);
    expect(fr.endTime).toBe('12:30');

    // La 4e A compose déjà les maths de 8 h à 10 h.
    const clash = await addPaper(s.censeur, p.sessionId, {
      subjectId: f.subjects.anglais,
      date: '2026-11-16',
      startTime: '09:00',
      durationMinutes: 60,
    }).expect(409);
    expect(clash.body.conflicts[0].kind).toBe('class');
    expect(clash.body.message).toContain('4e A');
    // Hors des dates de la session.
    await addPaper(s.censeur, p.sessionId, {
      subjectId: f.subjects.anglais,
      date: '2026-11-20',
      startTime: '09:00',
      durationMinutes: 60,
    }).expect(400);

    // Salle partagée par deux sessions au même moment.
    await http()
      .post(`/exams/sessions/${p.sessionId}/rooms`)
      .set(s.censeur.auth)
      .send({ roomId: p.b12 })
      .expect(201);
    const other = await createSession(s.censeur, {
      name: 'Examen blanc 6e',
      kind: 'MOCK',
      startDate: '2026-11-16',
      endDate: '2026-11-16',
      classIds: [f.class6AId],
    });
    await http()
      .post(`/exams/sessions/${other}/rooms`)
      .set(s.censeur.auth)
      .send({ roomId: p.b12 })
      .expect(201);
    // La 6e A n'étudie pas l'anglais : classes explicites refusées hors session, puis matière absente.
    await addPaper(s.censeur, other, {
      subjectId: f.subjects.anglais,
      date: '2026-11-16',
      startTime: '09:00',
      durationMinutes: 60,
    }).expect(400);
    await prisma.classSubject.create({
      data: {
        schoolId: f.schoolId,
        classId: f.class6AId,
        subjectId: f.subjects.anglais,
        coefficient: 2,
      },
    });
    const roomClash = await addPaper(s.censeur, other, {
      subjectId: f.subjects.anglais,
      date: '2026-11-16',
      startTime: '09:00',
      durationMinutes: 60,
    }).expect(409);
    expect(roomClash.body.conflicts[0].kind).toBe('room');
    await addPaper(s.censeur, other, {
      subjectId: f.subjects.anglais,
      date: '2026-11-16',
      startTime: '14:00',
      durationMinutes: 60,
    }).expect(201);
  });

  it('répartit les candidats, ajuste à la main et affecte les surveillants sans conflit', async () => {
    const p = await plannedSession();
    await http()
      .post(`/exams/sessions/${p.sessionId}/rooms`)
      .set(s.censeur.auth)
      .send({ roomId: p.b12 })
      .expect(201);
    // Capacité insuffisante : 3 places pour 5 candidats.
    const full = await http()
      .post(`/exams/sessions/${p.sessionId}/seating`)
      .set(s.censeur.auth)
      .send({});
    expect(full.status).toBe(409);
    expect(full.body.message).toContain('Capacité insuffisante');
    // La salle B14 n'a pas de capacité enregistrée : elle doit être précisée.
    await http()
      .post(`/exams/sessions/${p.sessionId}/rooms`)
      .set(s.censeur.auth)
      .send({ roomId: p.b14 })
      .expect(400);
    await http()
      .post(`/exams/sessions/${p.sessionId}/rooms`)
      .set(s.censeur.auth)
      .send({ roomId: p.b14, capacity: 4 })
      .expect(201);
    const seated = await http()
      .post(`/exams/sessions/${p.sessionId}/seating`)
      .set(s.censeur.auth)
      .send({})
      .expect(201);
    expect(seated.body).toEqual({ candidates: 5, added: 5 });

    const plan = await http()
      .get(`/exams/sessions/${p.sessionId}/seating`)
      .set(s.censeur.auth)
      .expect(200);
    const all = plan.body.rooms.flatMap((r: { candidates: unknown[] }) => r.candidates);
    expect(all).toHaveLength(5);
    expect(plan.body.unseated).toEqual([]);
    for (const r of plan.body.rooms) expect(r.candidates.length).toBeLessThanOrEqual(r.capacity);
    // Le plan de salle ne divulgue pas les numéros d'anonymat.
    expect(JSON.stringify(plan.body)).not.toMatch(/anonymity|code/i);

    // Échange de places : la place prise est libérée pour l'autre candidat.
    const [first, second] = plan.body.rooms[0].candidates;
    const target = plan.body.rooms[1].candidates[0];
    const moved = await http()
      .put(`/exams/candidates/${first.id}/seat`)
      .set(s.censeur.auth)
      .send({ roomId: p.b14, seat: target.seat })
      .expect(200);
    expect(moved.body.swapped).toBe(true);
    await http()
      .put(`/exams/candidates/${second.id}/seat`)
      .set(s.censeur.auth)
      .send({ roomId: p.b14, seat: 9 })
      .expect(400);
    const after = await http()
      .get(`/exams/sessions/${p.sessionId}/seating`)
      .set(s.censeur.auth)
      .expect(200);
    const roomOf = (id: string) =>
      after.body.rooms.find((r: { candidates: { id: string }[] }) =>
        r.candidates.some((c) => c.id === id),
      )?.id;
    expect(roomOf(first.id)).toBe(p.b14);
    expect(roomOf(target.id)).toBe(p.b12);

    // Répartition des surveillants : équilibre et aucun surveillant dans deux salles à la fois.
    const auto = await http()
      .post(`/exams/sessions/${p.sessionId}/supervisors/auto`)
      .set(s.censeur.auth)
      .expect(201);
    expect(auto.body.unfilled).toBe(0);
    const detail = await http()
      .get(`/exams/sessions/${p.sessionId}`)
      .set(s.censeur.auth)
      .expect(200);
    expect(detail.body.conflicts).toEqual([]);
    for (const paper of detail.body.papers) {
      const users = paper.rooms.flatMap((r: { supervisors: { userId: string }[] }) =>
        r.supervisors.map((x) => x.userId),
      );
      expect(new Set(users).size).toBe(users.length);
      for (const r of paper.rooms) expect(r.supervisors).toHaveLength(1);
    }
    const staff = await http().get('/exams/staff').set(s.censeur.auth).expect(200);
    const loads = staff.body.map((x: { loadMinutes: number }) => x.loadMinutes);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(120);

    // Affectation manuelle en conflit : le même enseignant dans l'autre salle au même moment.
    const mathsRooms = detail.body.papers.find((x: { id: string }) => x.id === p.mathsId).rooms;
    const busy = mathsRooms[0].supervisors[0].userId;
    const clash = await http()
      .post('/exams/supervisions')
      .set(s.censeur.auth)
      .send({ paperId: p.mathsId, roomId: mathsRooms[1].id, userId: busy })
      .expect(409);
    expect(clash.body.conflicts[0].kind).toBe('supervisor');

    // Chaque enseignant voit ses surveillances.
    const mine = await http().get('/exams/my-supervisions').set(s.prof.auth).expect(200);
    const prof2 = await http().get('/exams/my-supervisions').set(s.prof2.auth).expect(200);
    expect(mine.body.supervisions.length + prof2.body.supervisions.length).toBe(
      detail.body.papers.reduce((n: number, x: { rooms: unknown[] }) => n + x.rooms.length, 0),
    );
    // Liste d'émargement : le surveillant obtient celle de sa salle, pas celle d'une autre.
    const sup = mine.body.supervisions[0];
    if (sup) {
      const pdf = await http()
        .get(
          `/exams/sessions/${p.sessionId}/attendance-sheet.pdf?paperId=${sup.paperId}&roomId=${sup.roomId}`,
        )
        .set(s.prof.auth)
        .expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      await http()
        .get(`/exams/sessions/${p.sessionId}/attendance-sheet.pdf?paperId=${sup.paperId}`)
        .set(s.prof.auth)
        .expect(403);
    }
    const sheets = await http()
      .get(`/exams/sessions/${p.sessionId}/attendance-sheet.pdf?paperId=${p.mathsId}`)
      .set(s.censeur.auth)
      .expect(200);
    expect(sheets.body.length).toBeGreaterThan(1000);
    // Convocations : par lot de classe et par élève, réservées à l'administration.
    const batch = await http()
      .get(`/exams/sessions/${p.sessionId}/convocations.pdf?classId=${f.class4AId}`)
      .set(s.secretariat.auth)
      .expect(200);
    expect(batch.headers['content-type']).toBe('application/pdf');
    await http()
      .get(`/exams/sessions/${p.sessionId}/convocations.pdf?studentId=${p.students.Ngono}`)
      .set(s.secretariat.auth)
      .expect(200);
    await http()
      .get(`/exams/sessions/${p.sessionId}/convocations.pdf`)
      .set(s.prof.auth)
      .expect(403);
  });

  it('saisit les notes par numéro d’anonymat, publie et reporte dans la séquence', async () => {
    const p = await plannedSession();
    await http()
      .post(`/exams/sessions/${p.sessionId}/rooms`)
      .set(s.censeur.auth)
      .send({ roomId: p.b14, capacity: 10 })
      .expect(201);
    await http()
      .post(`/exams/sessions/${p.sessionId}/seating`)
      .set(s.censeur.auth)
      .send({})
      .expect(201);

    // L'enseignant de maths voit l'épreuve de maths, pas celle de français.
    const grading = await http().get('/exams/grading').set(s.prof.auth).expect(200);
    expect(grading.body.map((x: { id: string }) => x.id)).toEqual([p.mathsId]);
    await http().get(`/exams/papers/${p.francaisId}/scores`).set(s.prof.auth).expect(403);

    const maths = await http()
      .get(`/exams/papers/${p.mathsId}/scores`)
      .set(s.prof.auth)
      .expect(200);
    expect(maths.body.rows).toHaveLength(5);
    // Grille anonyme : aucun nom, aucune classe.
    expect(JSON.stringify(maths.body)).not.toMatch(/Ngono|Tchana|4e A/);
    const codes: string[] = maths.body.rows.map((r: { code: string }) => r.code);
    for (const c of codes) expect(isValidAnonymityCode(c)).toBe(true);
    expect(new Set(codes).size).toBe(5);

    // Faute de frappe sur un numéro : refusée.
    const typo = codes[0]!.slice(0, -1) + (codes[0]!.endsWith('2') ? '3' : '2');
    const bad = await http()
      .put(`/exams/papers/${p.mathsId}/scores`)
      .set(s.prof.auth)
      .send({ scores: [{ code: typo, value: '12' }] })
      .expect(400);
    expect(bad.body.errors[0].message).toContain('anonymat');
    await http()
      .put(`/exams/papers/${p.mathsId}/scores`)
      .set(s.prof.auth)
      .send({ scores: [{ code: codes[0], value: '25' }] })
      .expect(400);

    const values = ['15', '12,5', 'abs', '8', '17.25'];
    await http()
      .put(`/exams/papers/${p.mathsId}/scores`)
      .set(s.prof.auth)
      .send({
        scores: codes.map((code, i) => ({
          code: i === 0 ? `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase() : code,
          value: values[i],
        })),
      })
      .expect(200);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'exams.scores_updated' } });
    expect(audit).toBeTruthy();

    // Publication refusée tant que des notes manquent (français de la 4e A).
    const early = await http()
      .post(`/exams/sessions/${p.sessionId}/publish`)
      .set(s.censeur.auth)
      .send({})
      .expect(409);
    expect(early.body.message).toContain('Notes manquantes');

    // Avant publication, les résultats ne désignent les candidats que par leur numéro.
    const anon = await http()
      .get(`/exams/sessions/${p.sessionId}/results`)
      .set(s.censeur.auth)
      .expect(200);
    expect(anon.body.published).toBe(false);
    expect(
      anon.body.rows.every((r: { name: string | null; code: string }) => r.name === null && r.code),
    ).toBe(true);

    const fr = await http()
      .get(`/exams/papers/${p.francaisId}/scores`)
      .set(s.prof2.auth)
      .expect(200);
    expect(fr.body.rows).toHaveLength(3);
    await http()
      .put(`/exams/papers/${p.francaisId}/scores`)
      .set(s.prof2.auth)
      .send({
        scores: fr.body.rows.map((r: { code: string }, i: number) => ({
          code: r.code,
          value: ['30', '24', '36'][i],
        })),
      })
      .expect(200);

    // Un enseignant ne publie pas.
    await http()
      .post(`/exams/sessions/${p.sessionId}/publish`)
      .set(s.prof.auth)
      .send({})
      .expect(403);
    const outboxBefore = await prisma.notificationOutbox.count();
    const published = await http()
      .post(`/exams/sessions/${p.sessionId}/publish`)
      .set(s.censeur.auth)
      .send({ transferToSequence: true, weight: 2 })
      .expect(201);
    expect(published.body.transfer.created).toHaveLength(3);
    expect(await prisma.notificationOutbox.count()).toBe(outboxBefore + 5);
    const sms = await prisma.notificationOutbox.findFirst({
      where: { template: 'examResultsPublished' },
    });
    expect(sms?.body).toContain('Composition de la séquence 2');

    // Report dans la séquence : évaluations en brouillon, notes en centièmes, circuit habituel.
    const evals = await prisma.evaluation.findMany({
      where: { sequenceId: f.seq2Id },
      include: { grades: true },
    });
    expect(evals).toHaveLength(3);
    for (const e of evals) {
      expect(e.status).toBe('DRAFT');
      expect(e.type).toBe('EXAM');
      expect(e.weight).toBe(2);
    }
    const frEval = evals.find((e) => e.maxScore === 40)!;
    expect(frEval.grades.map((g) => g.valueCenti).sort()).toEqual([2400, 3000, 3600]);
    const sheet = await http()
      .get(`/grades/sheet?classSubjectId=${f.cs.maths4A}&sequenceId=${f.seq2Id}`)
      .set(s.prof.auth)
      .expect(200);
    expect(sheet.body.evaluations).toHaveLength(1);
    expect(sheet.body.missing).toBe(0);
    await http()
      .post('/grades/sheet/submit')
      .set(s.prof.auth)
      .send({ classSubjectId: f.cs.maths4A, sequenceId: f.seq2Id })
      .expect(201);
    await http()
      .post('/grades/sheet/validate')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.maths4A, sequenceId: f.seq2Id })
      .expect(201);
    // Un second report ne crée rien de plus.
    const again = await http()
      .post(`/exams/sessions/${p.sessionId}/transfer`)
      .set(s.censeur.auth)
      .send({})
      .expect(201);
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped.every((x: { reason: string }) => x.reason === 'Déjà reporté')).toBe(
      true,
    );

    // Après publication : noms visibles, notes figées.
    const results = await http()
      .get(`/exams/sessions/${p.sessionId}/results`)
      .set(s.censeur.auth)
      .expect(200);
    expect(results.body.published).toBe(true);
    expect(results.body.missing).toBe(0);
    const ngono = results.body.rows.find((r: { name: string }) => r.name?.startsWith('Ngono'));
    expect(ngono.averageCenti).not.toBeNull();
    expect(ngono.rank).toBeTruthy();
    await http()
      .put(`/exams/papers/${p.mathsId}/scores`)
      .set(s.prof.auth)
      .send({ scores: [{ code: codes[0], value: '20' }] })
      .expect(409);
    await http()
      .post(`/exams/sessions/${p.sessionId}/papers`)
      .set(s.censeur.auth)
      .send({
        subjectId: f.subjects.anglais,
        date: '2026-11-17',
        startTime: '08:00',
        durationMinutes: 60,
      })
      .expect(409);
  });

  it('réserve la levée de l’anonymat à la direction et au censeur, et la journalise', async () => {
    const p = await plannedSession();
    await http()
      .post(`/exams/sessions/${p.sessionId}/rooms`)
      .set(s.censeur.auth)
      .send({ roomId: p.b14, capacity: 10 })
      .expect(201);
    await http()
      .post(`/exams/sessions/${p.sessionId}/seating`)
      .set(s.censeur.auth)
      .send({})
      .expect(201);

    for (const who of [s.prof, s.secretariat, s.surveillant, s.compta] as const) {
      await http()
        .post(`/exams/sessions/${p.sessionId}/anonymity/reveal`)
        .set(who.auth)
        .send({ reason: 'Vérification des copies' })
        .expect(403);
    }
    expect(await prisma.auditLog.count({ where: { action: 'exams.anonymity_revealed' } })).toBe(0);
    await http()
      .post(`/exams/sessions/${p.sessionId}/anonymity/reveal`)
      .set(s.censeur.auth)
      .send({})
      .expect(400);
    const revealed = await http()
      .post(`/exams/sessions/${p.sessionId}/anonymity/reveal`)
      .set(s.censeur.auth)
      .send({ reason: 'Copie sans numéro à rattacher' })
      .expect(201);
    expect(revealed.body).toHaveLength(5);
    expect(revealed.body[0]).toHaveProperty('code');
    expect(revealed.body.map((r: { name: string }) => r.name.split(' ')[0]).sort()).toEqual([
      'Atangana',
      'Bilong',
      'Mvondo',
      'Ngono',
      'Tchana',
    ]);
    await http()
      .post(`/exams/sessions/${p.sessionId}/anonymity/reveal`)
      .set(s.direction.auth)
      .send({ reason: 'Contrôle de la direction' })
      .expect(201);
    const logs = await prisma.auditLog.findMany({ where: { action: 'exams.anonymity_revealed' } });
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.reason)).toContain('Copie sans numéro à rattacher');
    expect(logs.every((l) => l.actorId && l.schoolId === f.schoolId)).toBe(true);

    // Résultats non publiés : invisibles pour un enseignant.
    await http().get(`/exams/sessions/${p.sessionId}/results`).set(s.prof.auth).expect(403);
    // Un enseignant ne voit le plan de salle que s'il surveille la session.
    await http().get(`/exams/sessions/${p.sessionId}/seating`).set(s.prof.auth).expect(403);
  });

  it('montre les résultats au parent seulement après publication', async () => {
    const p = await plannedSession();
    await http()
      .post(`/exams/sessions/${p.sessionId}/rooms`)
      .set(s.censeur.auth)
      .send({ roomId: p.b14, capacity: 10 })
      .expect(201);
    await http()
      .post(`/exams/sessions/${p.sessionId}/seating`)
      .set(s.censeur.auth)
      .send({})
      .expect(201);
    const guardian = await prisma.studentGuardian.findFirstOrThrow({
      where: { studentId: p.students.Tchana },
      include: { guardian: true },
    });
    const phone = guardian.guardian.phone.replace('+237', '');
    const code = await requestOtp(app, phone);
    const parent = toSession(
      await http().post('/auth/otp/verify').send({ phone, code }).expect(200),
    );

    const scores = await http()
      .get(`/exams/papers/${p.mathsId}/scores`)
      .set(s.censeur.auth)
      .expect(200);
    await http()
      .put(`/exams/papers/${p.mathsId}/scores`)
      .set(s.censeur.auth)
      .send({
        scores: scores.body.rows.map((r: { code: string }) => ({ code: r.code, value: '14' })),
      })
      .expect(200);
    const fr = await http()
      .get(`/exams/papers/${p.francaisId}/scores`)
      .set(s.censeur.auth)
      .expect(200);
    await http()
      .put(`/exams/papers/${p.francaisId}/scores`)
      .set(s.censeur.auth)
      .send({ scores: fr.body.rows.map((r: { code: string }) => ({ code: r.code, value: '20' })) })
      .expect(200);

    const before = await http()
      .get(`/portal/children/${p.students.Tchana}/exams`)
      .set(parent.auth)
      .expect(200);
    expect(before.body).toEqual([]);
    // Pas d'accès aux enfants des autres.
    await http().get(`/portal/children/${p.students.Ngono}/exams`).set(parent.auth).expect(404);

    await http()
      .post(`/exams/sessions/${p.sessionId}/publish`)
      .set(s.censeur.auth)
      .send({})
      .expect(201);
    const after = await http()
      .get(`/portal/children/${p.students.Tchana}/exams`)
      .set(parent.auth)
      .expect(200);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].name).toBe('Composition de la séquence 2');
    expect(after.body[0].averageCenti).toBe(1400);
    expect(after.body[0].papers).toEqual([
      expect.objectContaining({ subjectName: 'Mathématiques', value: '14,00', maxScore: 20 }),
    ]);
    expect(after.body[0].rank).toBe('1er ex/2');
  });
});

describe('isolation des établissements (examens)', () => {
  let a: SchoolFixture;
  let b: SchoolFixture;
  let sa: Awaited<ReturnType<typeof sessions>>;
  let sb: Awaited<ReturnType<typeof sessions>>;

  beforeEach(async () => {
    await resetDb();
    a = await seedSchool('alpha', 'AL');
    b = await seedSchool('beta', 'BE');
    await enableExams(a.schoolId);
    await enableExams(b.schoolId);
    sa = await sessions(app, 'alpha');
    sb = await sessions(app, 'beta');
  });

  it('une école ne voit ni ne modifie les examens d’une autre', async () => {
    const roomA = await room(sa.direction, 'Salle A', 30);
    const idA = await createSession(sa.censeur, {
      name: 'Examen blanc',
      kind: 'MOCK',
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      classIds: [a.class4AId],
    });
    const paper = await addPaper(sa.censeur, idA, {
      subjectId: a.subjects.maths,
      date: '2026-12-01',
      startTime: '08:00',
      durationMinutes: 120,
    }).expect(201);

    const list = await http().get('/exams/sessions').set(sb.censeur.auth).expect(200);
    expect(list.body).toEqual([]);
    await http().get(`/exams/sessions/${idA}`).set(sb.censeur.auth).expect(404);
    await http().get(`/exams/sessions/${idA}/results`).set(sb.direction.auth).expect(404);
    await http()
      .post(`/exams/sessions/${idA}/anonymity/reveal`)
      .set(sb.direction.auth)
      .send({ reason: 'Tentative inter-école' })
      .expect(404);
    await addPaper(sb.censeur, idA, {
      subjectId: b.subjects.maths,
      date: '2026-12-01',
      startTime: '10:00',
      durationMinutes: 60,
    }).expect(404);
    await http().delete(`/exams/papers/${paper.body.id}`).set(sb.censeur.auth).expect(404);
    await http().delete(`/exams/sessions/${idA}`).set(sb.censeur.auth).expect(404);
    await http().get(`/exams/papers/${paper.body.id}/scores`).set(sb.censeur.auth).expect(404);
    // Une école ne peut ni créer une session sur les classes d'une autre, ni utiliser ses salles.
    await http()
      .post('/exams/sessions')
      .set(sb.censeur.auth)
      .send({
        name: 'Intrus',
        kind: 'MOCK',
        startDate: '2026-12-01',
        endDate: '2026-12-01',
        classIds: [a.class4AId],
      })
      .expect(400);
    const idB = await createSession(sb.censeur, {
      name: 'Examen blanc B',
      kind: 'MOCK',
      startDate: '2026-12-01',
      endDate: '2026-12-01',
      classIds: [b.class4AId],
    });
    await http()
      .post(`/exams/sessions/${idB}/rooms`)
      .set(sb.censeur.auth)
      .send({ roomId: roomA })
      .expect(400);
    // Les données de l'école A sont intactes.
    expect(await prisma.examPaper.count({ where: { sessionId: idA } })).toBe(1);
    expect(await prisma.examSession.count({ where: { schoolId: a.schoolId } })).toBe(1);
  });
});
