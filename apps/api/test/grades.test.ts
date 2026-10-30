import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createStaff, createTestApp, login, prisma, resetDb, type Session } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let ids: Record<'ngono' | 'ekotto' | 'bilong' | 'tchana', string>;
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
  ids = {
    ngono: (
      await enrollStudent(app, s.secretariat, {
        firstName: 'Marie-Claire',
        lastName: 'Ngono',
        classId: f.class4AId,
      })
    ).id,
    ekotto: (
      await enrollStudent(app, s.secretariat, {
        firstName: 'Mireille',
        lastName: 'Ekotto',
        classId: f.class4AId,
      })
    ).id,
    bilong: (
      await enrollStudent(app, s.secretariat, {
        firstName: 'Estelle',
        lastName: 'Bilong',
        classId: f.class4AId,
      })
    ).id,
    tchana: (
      await enrollStudent(app, s.secretariat, {
        firstName: 'Kevin',
        lastName: 'Tchana',
        classId: f.class4AId,
        gender: 'M',
      })
    ).id,
  };
});

async function evaluation(
  session: Session,
  classSubjectId: string,
  sequenceId: string,
  name: string,
  type: string,
  weight: number,
) {
  const res = await http()
    .post('/grades/evaluations')
    .set(session.auth)
    .send({ classSubjectId, sequenceId, name, type, weight })
    .expect(201);
  return res.body.id as string;
}

async function grades(
  session: Session,
  evaluationId: string,
  values: Record<string, string>,
  expected = 200,
) {
  return http()
    .put(`/grades/evaluations/${evaluationId}/grades`)
    .set(session.auth)
    .send({ grades: Object.entries(values).map(([studentId, value]) => ({ studentId, value })) })
    .expect(expected);
}

describe('saisie des notes', () => {
  it('calcule moyennes, rangs avec ex aequo et signale les notes manquantes', async () => {
    const interro = await evaluation(s.prof, f.cs.maths4A, f.seq2Id, 'Interrogation', 'QUIZ', 1);
    const devoir = await evaluation(s.prof, f.cs.maths4A, f.seq2Id, 'Devoir', 'HOMEWORK', 1);
    const compo = await evaluation(s.prof, f.cs.maths4A, f.seq2Id, 'Composition', 'EXAM', 2);
    await grades(s.prof, interro, {
      [ids.ngono]: '14',
      [ids.ekotto]: '14',
      [ids.bilong]: '16',
      [ids.tchana]: '10',
    });
    await grades(s.prof, devoir, {
      [ids.ngono]: '15',
      [ids.ekotto]: '15',
      [ids.bilong]: '17',
      [ids.tchana]: '11',
    });
    await grades(s.prof, compo, { [ids.ngono]: '16,5', [ids.ekotto]: '16.5', [ids.bilong]: '18' });

    const sheet = await http()
      .get(`/grades/sheet?classSubjectId=${f.cs.maths4A}&sequenceId=${f.seq2Id}`)
      .set(s.prof.auth)
      .expect(200);
    const row = (id: string) =>
      sheet.body.rows.find((r: { student: { id: string } }) => r.student.id === id);
    expect(row(ids.ngono)).toMatchObject({
      averageCenti: 1550,
      formula: '(14,00 + 15,00 + 16,50 × 2) ÷ 4',
      appreciation: 'Bien',
      rank: { rank: 2, tied: true, label: '2e ex' },
    });
    expect(row(ids.ekotto).rank.label).toBe('2e ex');
    expect(row(ids.bilong)).toMatchObject({
      averageCenti: 1725,
      rank: { label: '1er' },
      appreciation: 'Très bien',
    });
    expect(row(ids.tchana)).toMatchObject({ averageCenti: null, incomplete: true, rank: null });
    expect(row(ids.ngono).cells.map((c: { value: string }) => c.value)).toEqual([
      '14',
      '15',
      '16,5',
    ]);
    expect(sheet.body.missing).toBe(1);
    expect(sheet.body.stats).toMatchObject({ count: 3, maxCenti: 1725, minCenti: 1550 });

    const blocked = await http()
      .post('/grades/sheet/submit')
      .set(s.prof.auth)
      .send({ classSubjectId: f.cs.maths4A, sequenceId: f.seq2Id })
      .expect(409);
    expect(blocked.body.missing).toEqual(['Tchana Kevin']);

    // Une absence est exclue du calcul : (10 + 11) ÷ 2.
    await grades(s.prof, compo, { [ids.tchana]: 'abs' });
    const after = await http()
      .get(`/grades/sheet?classSubjectId=${f.cs.maths4A}&sequenceId=${f.seq2Id}`)
      .set(s.prof.auth)
      .expect(200);
    expect(
      after.body.rows.find((r: { student: { id: string } }) => r.student.id === ids.tchana)
        .averageCenti,
    ).toBe(1050);
  });

  it('refuse les notes invalides et les élèves hors classe, sans rien enregistrer', async () => {
    const ev = await evaluation(s.prof, f.cs.maths4A, f.seq1Id, 'Devoir', 'HOMEWORK', 1);
    const outsider = await enrollStudent(app, s.secretariat, {
      firstName: 'Ibrahim',
      lastName: 'Bello',
      classId: f.class6AId,
    });
    const res = await grades(
      s.prof,
      ev,
      { [ids.ngono]: '21', [ids.ekotto]: '12', [outsider.id]: '10' },
      400,
    );
    expect(res.body.errors).toEqual([
      { studentId: ids.ngono, message: 'Note invalide : entre 0 et 20, deux décimales au plus' },
      { studentId: outsider.id, message: 'Élève non inscrit dans la classe' },
    ]);
    expect(await prisma.grade.count()).toBe(0);
  });

  it('journalise chaque changement de note avec l’ancienne et la nouvelle valeur', async () => {
    const ev = await evaluation(s.prof, f.cs.maths4A, f.seq1Id, 'Devoir', 'HOMEWORK', 1);
    await grades(s.prof, ev, { [ids.ngono]: '12' });
    await grades(s.prof, ev, { [ids.ngono]: '13,5' });
    const logs = await prisma.auditLog.findMany({
      where: { action: 'grades.updated', entityId: ev },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => (l.after as { changes: unknown[] }).changes)).toEqual([
      [{ studentId: ids.ngono, before: '', after: '12' }],
      [{ studentId: ids.ngono, before: '12', after: '13,5' }],
    ]);
  });

  it("limite l'enseignant à ses matières", async () => {
    await http()
      .post('/grades/evaluations')
      .set(s.prof.auth)
      .send({
        classSubjectId: f.cs.francais4A,
        sequenceId: f.seq1Id,
        name: 'Dictée',
        type: 'QUIZ',
        weight: 1,
      })
      .expect(403);
    await http()
      .get(`/grades/sheet?classSubjectId=${f.cs.maths4A}&sequenceId=${f.seq1Id}`)
      .set(s.prof2.auth)
      .expect(403);
    const mine = await http().get('/grades/class-subjects').set(s.prof.auth).expect(200);
    expect(mine.body.classSubjects.map((c: { subjectName: string }) => c.subjectName)).toEqual([
      'Mathématiques',
    ]);
    expect(mine.body.sequences).toHaveLength(2);
  });

  it('suit le circuit brouillon → soumis → validé → rouvert', async () => {
    const ev = await evaluation(s.prof, f.cs.maths4A, f.seq1Id, 'Composition', 'EXAM', 2);
    await grades(s.prof, ev, {
      [ids.ngono]: '14',
      [ids.ekotto]: '12',
      [ids.bilong]: '16',
      [ids.tchana]: 'disp',
    });
    const body = { classSubjectId: f.cs.maths4A, sequenceId: f.seq1Id };
    await http().post('/grades/sheet/validate').set(s.censeur.auth).send(body).expect(409);
    await http().post('/grades/sheet/submit').set(s.prof.auth).send(body).expect(201);
    // Après soumission, l'enseignant ne modifie plus ; le censeur peut corriger.
    await grades(s.prof, ev, { [ids.ngono]: '15' }, 409);
    await grades(s.censeur, ev, { [ids.ngono]: '15' });
    await http()
      .post('/grades/evaluations')
      .set(s.prof.auth)
      .send({ ...body, name: 'Rattrapage', type: 'QUIZ', weight: 1 })
      .expect(409);
    await http().post('/grades/sheet/validate').set(s.prof.auth).send(body).expect(403);
    await http().post('/grades/sheet/validate').set(s.censeur.auth).send(body).expect(201);
    await grades(s.censeur, ev, { [ids.ngono]: '16' }, 409);
    await http().delete(`/grades/evaluations/${ev}`).set(s.prof.auth).expect(409);
    await http()
      .post('/grades/sheet/reopen')
      .set(s.censeur.auth)
      .send({ ...body, reason: 'Erreur de barème signalée' })
      .expect(201);
    await grades(s.prof, ev, { [ids.ngono]: '16' });
    const progress = await http()
      .get(`/grades/progress?sequenceId=${f.seq1Id}`)
      .set(s.censeur.auth)
      .expect(200);
    expect(
      progress.body.find((p: { classSubjectId: string }) => p.classSubjectId === f.cs.maths4A)
        .status,
    ).toBe('DRAFT');
  });
});

describe('périmètre des enseignants', () => {
  it('un enseignant également surveillant reste limité à ses matières pour les notes', async () => {
    await createStaff(f.schoolId, 'mixte@test.cm', ['TEACHER', 'SUPERVISOR']);
    const mixte = await login(app, 'mixte@test.cm');
    // Les mathématiques de 4e B sont enseignées par un collègue.
    await http()
      .post('/grades/evaluations')
      .set(mixte.auth)
      .send({
        classSubjectId: f.cs.maths4B,
        sequenceId: f.seq1Id,
        name: 'DS',
        type: 'EXAM',
        weight: 1,
      })
      .expect(403);
    await http()
      .get(`/grades/sheet?classSubjectId=${f.cs.maths4B}&sequenceId=${f.seq1Id}`)
      .set(mixte.auth)
      .expect(403);
    // Le censeur, lui, accède à toutes les classes.
    await http()
      .get(`/grades/sheet?classSubjectId=${f.cs.maths4B}&sequenceId=${f.seq1Id}`)
      .set(s.censeur.auth)
      .expect(200);
  });
});

describe('bulletins', () => {
  /** Une évaluation par matière et par séquence, saisie puis soumise par le bon enseignant. */
  async function fillTerm() {
    const plan: [string, Session, Record<string, [string, string]>][] = [
      [
        f.cs.maths4A,
        s.prof,
        { ngono: ['14,5', '15,5'], bilong: ['16', '16'], ekotto: ['10', '10'], tchana: ['8', '8'] },
      ],
      [
        f.cs.francais4A,
        s.prof2,
        { ngono: ['12,5', '13'], bilong: ['16', '16'], ekotto: ['10', '10'], tchana: ['8', '8'] },
      ],
      [
        f.cs.anglais4A,
        s.prof2,
        { ngono: ['10', '11,5'], bilong: ['16', '16'], ekotto: ['10', '10'], tchana: ['8', '8'] },
      ],
    ];
    for (const [cs, session, values] of plan) {
      for (const [i, seq] of [f.seq1Id, f.seq2Id].entries()) {
        const ev = await evaluation(session, cs, seq, 'Composition', 'EXAM', 1);
        await grades(
          session,
          ev,
          Object.fromEntries(
            Object.entries(values).map(([k, v]) => [ids[k as keyof typeof ids], v[i] ?? '']),
          ),
        );
        await http()
          .post('/grades/sheet/submit')
          .set(session.auth)
          .send({ classSubjectId: cs, sequenceId: seq })
          .expect(201);
      }
    }
  }

  it('refuse de générer sans notes soumises', async () => {
    await http()
      .post('/report-cards/generate')
      .set(s.censeur.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(409);
  });

  it('calcule le bulletin trimestriel, le publie, puis le fige', async () => {
    await fillTerm();
    // Une absence non justifiée de 07:30 à 09:20 pendant le trimestre.
    await http()
      .post('/attendance/sessions')
      .set(s.prof.auth)
      .send({
        classId: f.class4AId,
        date: '2026-10-28',
        startTime: '07:30',
        endTime: '09:20',
        records: Object.values(ids).map((id) => ({
          studentId: id,
          status: id === ids.ngono ? 'ABSENT' : 'PRESENT',
        })),
      })
      .expect(201);
    await http()
      .put('/report-cards/decisions')
      .set(s.censeur.auth)
      .send({
        studentId: ids.bilong,
        termId: f.term1Id,
        decision: 'HONOR_ROLL',
        comment: 'Excellent trimestre',
      })
      .expect(200);

    const gen = await http()
      .post('/report-cards/generate')
      .set(s.censeur.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(201);
    expect(gen.body.generated).toBe(4);
    const list = await http()
      .get(`/report-cards?classId=${f.class4AId}&termId=${f.term1Id}`)
      .set(s.direction.auth)
      .expect(200);
    expect(
      list.body.map((c: { student: string; rankLabel: string; status: string }) => [
        c.student,
        c.rankLabel,
        c.status,
      ]),
    ).toEqual([
      ['Bilong Estelle', '1er', 'DRAFT'],
      ['Ngono Marie-Claire', '2e', 'DRAFT'],
      ['Ekotto Mireille', '3e', 'DRAFT'],
      ['Tchana Kevin', '4e', 'DRAFT'],
    ]);

    const ngono = list.body.find((c: { studentId: string }) => c.studentId === ids.ngono);
    const card = await http().get(`/report-cards/${ngono.id}`).set(s.direction.auth).expect(200);
    const data = card.body.data;
    // (15,00 × 4 + 12,75 × 4 + 10,75 × 3) ÷ 11 = 13,0227… → 13,02
    expect(data.totals).toMatchObject({
      totalCoefficient: 11,
      totalPointsCenti: 14325,
      generalAverageCenti: 1302,
      rank: 2,
      ranked: 4,
    });
    expect(data.sequenceGeneralAverages).toEqual([1255, 1350]);
    expect(
      data.groups.map((g: { label: string; subjects: { name: string }[] }) => [
        g.label,
        g.subjects.map((x) => x.name),
      ]),
    ).toEqual([
      ['Enseignements littéraires', ['Anglais', 'Français']],
      ['Enseignements scientifiques', ['Mathématiques']],
    ]);
    const maths = data.groups[1].subjects[0];
    expect(maths).toMatchObject({
      sequenceAverages: [1450, 1550],
      averageCenti: 1500,
      totalCenti: 6000,
      coefficient: 4,
      appreciation: 'Bien',
      rank: '2e',
    });
    expect(data.attendance).toEqual({
      justifiedHours: 0,
      unjustifiedHours: 1.8,
      lates: 0,
      incidents: 0,
    });
    expect(data.classStats).toEqual({ averageCenti: 1176, minCenti: 800, maxCenti: 1600 });
    expect(data.class).toMatchObject({ name: '4e A', size: 4 });

    const bilongCard = await http()
      .get(`/report-cards/${list.body[0].id}`)
      .set(s.direction.auth)
      .expect(200);
    expect(bilongCard.body.data.decision).toEqual({
      type: 'HONOR_ROLL',
      label: "Tableau d'honneur",
      comment: 'Excellent trimestre',
    });

    const pdf = await http().get(`/report-cards/${ngono.id}/pdf`).set(s.direction.auth).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    // Publication : réservée à la direction, avec SMS aux parents.
    await http()
      .post('/report-cards/publish')
      .set(s.censeur.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(403);
    MemorySmsProvider.sent.length = 0;
    await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(201);
    const queued = await prisma.notificationOutbox.findMany({
      where: { template: 'reportCardPublished' },
    });
    expect(queued).toHaveLength(4);
    expect(queued.find((n) => n.body.includes('Marie-Claire'))?.body).toContain('moyenne 13,02/20');

    // Le contenu publié est figé au niveau de la base.
    await expect(
      prisma.reportCard.update({ where: { id: ngono.id }, data: { generalAverageCenti: 2000 } }),
    ).rejects.toThrow(/figé/);
    await expect(prisma.reportCard.delete({ where: { id: ngono.id } })).rejects.toThrow();
    for (const data of [
      { classSize: 40 },
      { verificationCode: 'FAUXCODE1234' },
      { rankTied: true },
    ])
      await expect(prisma.reportCard.update({ where: { id: ngono.id }, data })).rejects.toThrow(
        /figé/,
      );

    const verified = await http().get(`/verify/${card.body.verificationCode}`).expect(200);
    expect(verified.body).toMatchObject({
      type: 'report-card',
      valid: true,
      version: 1,
      generalAverage: '13,02',
      student: 'NGONO Marie-Claire',
    });
  });

  it('produit une nouvelle version pour toute correction après publication', async () => {
    await fillTerm();
    await http()
      .post('/report-cards/generate')
      .set(s.censeur.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(201);
    await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(201);
    const v1 = await prisma.reportCard.findFirstOrThrow({
      where: { studentId: ids.ngono, version: 1 },
    });

    await http()
      .post('/grades/sheet/reopen')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.maths4A, sequenceId: f.seq2Id, reason: 'Copie mal corrigée' })
      .expect(201);
    const ev = await prisma.evaluation.findFirstOrThrow({
      where: { classSubjectId: f.cs.maths4A, sequenceId: f.seq2Id },
    });
    await grades(s.prof, ev.id, { [ids.ngono]: '17,5' });
    await http()
      .post('/grades/sheet/submit')
      .set(s.prof.auth)
      .send({ classSubjectId: f.cs.maths4A, sequenceId: f.seq2Id })
      .expect(201);
    await http()
      .post('/report-cards/generate')
      .set(s.censeur.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(201);
    await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(201);

    const versions = await prisma.reportCard.findMany({
      where: { studentId: ids.ngono },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'PUBLISHED'],
    ]);
    expect(versions[0]?.generalAverageCenti).toBe(1302);
    // Maths : (14,50 + 17,50) ÷ 2 = 16,00 → (16 × 4 + 12,75 × 4 + 10,75 × 3) ÷ 11 = 13,39
    expect(versions[1]?.generalAverageCenti).toBe(1339);
    const old = await http().get(`/verify/${v1.verificationCode}`).expect(200);
    expect(old.body).toMatchObject({
      valid: false,
      status: 'SUPERSEDED',
      version: 1,
      latestVersion: 2,
    });
  });

  it('refuse de publier des bulletins incomplets sans motif, ou périmés', async () => {
    await fillTerm();
    // Le français de la séquence 2 est rouvert puis laissé en brouillon.
    await http()
      .post('/grades/sheet/reopen')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.francais4A, sequenceId: f.seq2Id, reason: 'Copie égarée' })
      .expect(201);
    const body = { classId: f.class4AId, termId: f.term1Id };
    const gen = await http()
      .post('/report-cards/generate')
      .set(s.censeur.auth)
      .send(body)
      .expect(201);
    expect(gen.body.issues).toEqual(['Français · Séquence 2 : saisie non soumise']);
    const check = await http()
      .get(`/report-cards/completeness?classId=${f.class4AId}&termId=${f.term1Id}`)
      .set(s.direction.auth)
      .expect(200);
    expect(check.body.issues).toEqual(gen.body.issues);
    const refused = await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send(body)
      .expect(409);
    expect(refused.body.issues).toEqual(gen.body.issues);

    // La saisie est terminée après la préparation : le brouillon est périmé.
    await http()
      .post('/grades/sheet/submit')
      .set(s.prof2.auth)
      .send({ classSubjectId: f.cs.francais4A, sequenceId: f.seq2Id })
      .expect(201);
    const stale = await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send({ ...body, overrideReason: 'Conseil de classe tenu hier' })
      .expect(409);
    expect(stale.body.message).toMatch(/préparez à nouveau/);

    // Une matière sans aucune note : publication possible avec un motif journalisé.
    await prisma.evaluation.deleteMany({
      where: { classSubjectId: f.cs.anglais4A, sequenceId: f.seq2Id },
    });
    const again = await http()
      .post('/report-cards/generate')
      .set(s.censeur.auth)
      .send(body)
      .expect(201);
    expect(again.body.issues).toEqual(['Anglais · Séquence 2 : aucune note']);
    await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send({ ...body, overrideReason: 'Absent' })
      .expect(400);
    await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send({ ...body, overrideReason: 'Enseignant d’anglais absent toute la séquence' })
      .expect(201);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'reportcards.published_incomplete' },
    });
    expect(log.after).toMatchObject({
      issues: ['Anglais · Séquence 2 : aucune note'],
      overrideReason: 'Enseignant d’anglais absent toute la séquence',
    });
  });

  it('impose de préparer à nouveau après une décision du conseil, et ignore un élève parti', async () => {
    await fillTerm();
    const body = { classId: f.class4AId, termId: f.term1Id };
    await http().post('/report-cards/generate').set(s.censeur.auth).send(body).expect(201);
    // Le conseil de classe statue après la préparation : le brouillon n'a pas la décision.
    await http()
      .put('/report-cards/decisions')
      .set(s.censeur.auth)
      .send({ studentId: ids.bilong, termId: f.term1Id, decision: 'HONOR_ROLL' })
      .expect(200);
    const stale = await http().post('/report-cards/publish').set(s.direction.auth).send(body);
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/préparez à nouveau/);

    // Un élève quitte la classe : la nouvelle préparation ne doit pas laisser son ancien brouillon
    // bloquer la publication.
    await prisma.enrollment.updateMany({
      where: { studentId: ids.tchana, classId: f.class4AId },
      data: { status: 'TRANSFERRED' },
    });
    const gen = await http().post('/report-cards/generate').set(s.censeur.auth).send(body);
    expect(gen.body.generated).toBe(3);
    await http().post('/report-cards/publish').set(s.direction.auth).send(body).expect(201);
    const published = await prisma.reportCard.findMany({ where: { termId: f.term1Id } });
    expect(published.map((r) => r.status).sort()).toEqual(['PUBLISHED', 'PUBLISHED', 'PUBLISHED']);
    const bilong = published.find((r) => r.studentId === ids.bilong)!;
    expect(JSON.stringify(bilong.data)).toContain('HONOR_ROLL');
  });

  it('ne divulgue rien pour un code inconnu ou un brouillon', async () => {
    await http().get('/verify/INCONNU123').expect(404);
    await http().get('/verify/abc').expect(404);
    await fillTerm();
    await http()
      .post('/report-cards/generate')
      .set(s.censeur.auth)
      .send({ classId: f.class4AId, termId: f.term1Id })
      .expect(201);
    const draft = await prisma.reportCard.findFirstOrThrow({ where: { studentId: ids.ngono } });
    await http().get(`/verify/${draft.verificationCode}`).expect(404);
  });
});
