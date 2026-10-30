import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, requestOtp, resetDb, type Session, toSession } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let ids: Record<'ngono' | 'ekotto' | 'bilong' | 'tchana', string>;
/** Trimestres de l'année et leurs séquences : T1 (fixture), T2 et T3 créés ici. */
let terms: { id: string; seqs: [string, string] }[];
const http = () => request(app.getHttpServer());

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

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
  terms = [{ id: f.term1Id, seqs: [f.seq1Id, f.seq2Id] }];
  for (const order of [2, 3]) {
    const term = await prisma.term.create({
      data: {
        schoolId: f.schoolId,
        academicYearId: f.yearId,
        name: order === 2 ? '2e trimestre' : '3e trimestre',
        order,
        startDate: new Date(order === 2 ? '2027-01-04' : '2027-04-05'),
        endDate: new Date(order === 2 ? '2027-03-26' : '2027-06-18'),
      },
    });
    const seqs = await Promise.all(
      [1, 2].map((o) =>
        prisma.sequence.create({
          data: {
            schoolId: f.schoolId,
            termId: term.id,
            name: `Séquence ${(order - 1) * 2 + o}`,
            order: o,
          },
        }),
      ),
    );
    terms.push({ id: term.id, seqs: [seqs[0]!.id, seqs[1]!.id] });
  }
  const enroll = (firstName: string, lastName: string, phone: string, gender?: 'M') =>
    enrollStudent(app, s.secretariat, { firstName, lastName, classId: f.class4AId, phone, gender });
  ids = {
    ngono: (await enroll('Marie-Claire', 'Ngono', '677123456')).id,
    ekotto: (await enroll('Mireille', 'Ekotto', '677000001')).id,
    bilong: (await enroll('Estelle', 'Bilong', '677000002')).id,
    tchana: (await enroll('Kevin', 'Tchana', '677000003', 'M')).id,
  };
});

/**
 * Notes de l'année : une composition par matière et par séquence, même note aux deux séquences
 * d'un trimestre. Kevin Tchana, absent tout le 1er trimestre, n'a pas de moyenne au T1.
 */
const PLAN: Record<keyof typeof ids, Record<'maths' | 'other', [string, string, string]>> = {
  ngono: { maths: ['12', '14', '16'], other: ['12', '13', '14'] },
  bilong: { maths: ['16', '15', '14'], other: ['16', '15', '14'] },
  ekotto: { maths: ['10', '8', '9,5'], other: ['10', '8', '9,5'] },
  tchana: { maths: ['abs', '13', '13'], other: ['abs', '13', '13'] },
};

async function fillYear(termCount = 3) {
  const subjects: [string, Session, 'maths' | 'other'][] = [
    [f.cs.maths4A, s.prof, 'maths'],
    [f.cs.francais4A, s.prof2, 'other'],
    [f.cs.anglais4A, s.prof2, 'other'],
  ];
  for (const [t, term] of terms.slice(0, termCount).entries()) {
    for (const seq of term.seqs) {
      for (const [cs, session, kind] of subjects) {
        const ev = await http()
          .post('/grades/evaluations')
          .set(session.auth)
          .send({
            classSubjectId: cs,
            sequenceId: seq,
            name: 'Composition',
            type: 'EXAM',
            weight: 1,
          })
          .expect(201);
        await http()
          .put(`/grades/evaluations/${ev.body.id}/grades`)
          .set(session.auth)
          .send({
            grades: Object.entries(PLAN).map(([k, v]) => ({
              studentId: ids[k as keyof typeof ids],
              value: v[kind][t],
            })),
          })
          .expect(200);
        await http()
          .post('/grades/sheet/submit')
          .set(session.auth)
          .send({ classSubjectId: cs, sequenceId: seq })
          .expect(201);
      }
    }
  }
}

const generate = (termId: string, expected = 201) =>
  http()
    .post('/report-cards/generate')
    .set(s.censeur.auth)
    .send({ classId: f.class4AId, termId })
    .expect(expected);
const publish = (termId: string) =>
  http()
    .post('/report-cards/publish')
    .set(s.direction.auth)
    .send({ classId: f.class4AId, termId })
    .expect(201);

async function parentLogin(phone: string): Promise<Session> {
  const code = await requestOtp(app, phone);
  return toSession(await http().post('/auth/otp/verify').send({ phone, code }).expect(200));
}

describe('bulletin de fin d’année', () => {
  it('calcule moyennes et rangs annuels, porte la décision de fin d’année et la publie', async () => {
    await fillYear();
    const t3 = terms[2]!.id;
    // La décision de fin d'année n'existe qu'au dernier trimestre.
    await http()
      .put('/report-cards/decisions')
      .set(s.censeur.auth)
      .send({
        studentId: ids.ngono,
        termId: f.term1Id,
        decision: 'NONE',
        yearEndDecision: 'PROMOTED',
      })
      .expect(409);
    await http()
      .put('/report-cards/decisions')
      .set(s.censeur.auth)
      .send({
        studentId: ids.ngono,
        termId: t3,
        decision: 'ENCOURAGEMENT',
        yearEndDecision: 'PROMOTED',
      })
      .expect(200);
    await http()
      .put('/report-cards/decisions')
      .set(s.censeur.auth)
      .send({ studentId: ids.ekotto, termId: t3, decision: 'WARNING', yearEndDecision: 'REPEAT' })
      .expect(200);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'reportcards.decision',
        after: { path: ['yearEndDecision'], equals: 'REPEAT' },
      },
    });
    expect(log.after).toMatchObject({ decision: 'WARNING' });

    const gen = await generate(t3);
    expect(gen.body).toMatchObject({ generated: 4, annual: true, issues: [] });

    const list = await http()
      .get(`/report-cards?classId=${f.class4AId}&termId=${t3}`)
      .set(s.direction.auth)
      .expect(200);
    expect(
      list.body.map(
        (c: { student: string; annualAverageCenti: number; annualRankLabel: string }) => [
          c.student,
          c.annualAverageCenti,
          c.annualRankLabel,
        ],
      ),
    ).toEqual([
      // Classés au rang du 3e trimestre : 14,73 · 14,00 · 13,00 · 9,50.
      ['Ngono Marie-Claire', 1336, '2e'],
      ['Bilong Estelle', 1500, '1er'],
      ['Tchana Kevin', 1300, '3e'],
      ['Ekotto Mireille', 917, '4e'],
    ]);

    const ngonoRow = list.body.find((c: { studentId: string }) => c.studentId === ids.ngono);
    const card = await http().get(`/report-cards/${ngonoRow.id}`).set(s.direction.auth).expect(200);
    expect(card.body).toMatchObject({ annualAverageCenti: 1336, annualRank: 2 });
    const data = card.body.data;
    // T2 : (14 × 4 + 13 × 4 + 13 × 3) ÷ 11 = 13,36 ; T3 : (16 × 4 + 14 × 7) ÷ 11 = 14,73.
    // Année : (12,00 + 13,36 + 14,73) ÷ 3 = 13,363… → 13,36.
    expect(data.annual).toMatchObject({
      terms: [{ name: '1er trimestre' }, { name: '2e trimestre' }, { name: '3e trimestre' }],
      termGeneralAverages: [1200, 1336, 1473],
      generalAverageCenti: 1336,
      rank: 2,
      rankLabel: '2e',
      ranked: 4,
      appreciation: 'Assez bien',
      missingTerms: [],
      classPassRatePermille: 750,
      classStats: { minCenti: 917, maxCenti: 1500 },
    });
    expect(data.totals.generalAverageCenti).toBe(1473);
    expect(data.yearEndDecision).toEqual({ type: 'PROMOTED', label: 'Admis en classe supérieure' });
    expect(data.decision).toMatchObject({ type: 'ENCOURAGEMENT' });
    const maths = data.groups
      .flatMap((g: { subjects: unknown[] }) => g.subjects)
      .find((x: { name: string }) => x.name === 'Mathématiques');
    expect(maths).toMatchObject({
      termAverages: [1200, 1400, 1600],
      annualAverageCenti: 1400,
      annualRank: '2e',
      averageCenti: 1600,
    });

    const tchana = await prisma.reportCard.findFirstOrThrow({
      where: { studentId: ids.tchana, termId: t3 },
    });
    // Trimestre manquant : moyenne des deux trimestres notés, signalée sur le bulletin.
    expect((tchana.data as { annual: unknown }).annual).toMatchObject({
      termGeneralAverages: [null, 1300, 1300],
      generalAverageCenti: 1300,
      missingTerms: ['1er trimestre'],
    });
    expect((tchana.data as { yearEndDecision: unknown }).yearEndDecision).toBeNull();

    const pdf = await http()
      .get(`/report-cards/${ngonoRow.id}/pdf`)
      .set(s.direction.auth)
      .expect(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    await publish(t3);
    const sms = await prisma.notificationOutbox.findMany({
      where: { template: 'annualReportCardPublished' },
    });
    expect(sms).toHaveLength(4);
    expect(sms.find((n) => n.body.includes('Marie-Claire'))?.body).toBe(
      "Le bulletin de fin d'année de Marie-Claire Ngono est disponible (moyenne annuelle 13,36/20). Décision du conseil : Admis en classe supérieure.",
    );
    // Version figée en base, vérifiable publiquement avec la moyenne annuelle.
    await expect(
      prisma.reportCard.update({ where: { id: ngonoRow.id }, data: { annualAverageCenti: 2000 } }),
    ).rejects.toThrow(/figé/);
    const verified = await http().get(`/verify/${card.body.verificationCode}`).expect(200);
    expect(verified.body).toMatchObject({
      valid: true,
      annualAverage: '13,36',
      term: '3e trimestre',
    });

    // Les bulletins des autres trimestres restent trimestriels.
    const t1 = await generate(f.term1Id);
    expect(t1.body.annual).toBe(false);
    const t1Card = await prisma.reportCard.findFirstOrThrow({
      where: { studentId: ids.ngono, termId: f.term1Id },
    });
    expect((t1Card.data as { annual?: unknown }).annual).toBeUndefined();
    expect(t1Card.annualAverageCenti).toBeNull();
  });

  it('contrôle les saisies de toute l’année avant la publication du bulletin annuel', async () => {
    await fillYear();
    const t3 = terms[2]!.id;
    await http()
      .post('/grades/sheet/reopen')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.maths4A, sequenceId: f.seq1Id, reason: 'Erreur de report' })
      .expect(201);
    const check = await http()
      .get(`/report-cards/completeness?classId=${f.class4AId}&termId=${t3}`)
      .set(s.direction.auth)
      .expect(200);
    expect(check.body).toEqual({
      annual: true,
      issues: ['Mathématiques · Séquence 1 : saisie non soumise'],
    });
    await generate(t3);
    const refused = await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send({ classId: f.class4AId, termId: t3 })
      .expect(409);
    expect(refused.body.issues).toEqual(check.body.issues);
    // Une note du 1er trimestre corrigée après la préparation rend le brouillon annuel périmé.
    const ev = await prisma.evaluation.findFirstOrThrow({
      where: { classSubjectId: f.cs.maths4A, sequenceId: f.seq1Id },
    });
    await http()
      .put(`/grades/evaluations/${ev.id}/grades`)
      .set(s.prof.auth)
      .send({ grades: [{ studentId: ids.ngono, value: '13' }] })
      .expect(200);
    await http()
      .post('/grades/sheet/submit')
      .set(s.prof.auth)
      .send({ classSubjectId: f.cs.maths4A, sequenceId: f.seq1Id })
      .expect(201);
    const stale = await http()
      .post('/report-cards/publish')
      .set(s.direction.auth)
      .send({ classId: f.class4AId, termId: t3, overrideReason: 'Conseil de fin d’année tenu' })
      .expect(409);
    expect(stale.body.message).toMatch(/préparez à nouveau/);
  });

  it('refuse le bulletin annuel sans aucune note au 3e trimestre', async () => {
    await fillYear(2);
    const res = await generate(terms[2]!.id, 409);
    expect(res.body.message).toMatch(/Aucune note soumise pour ce trimestre/);
  });
});

describe('relevés de notes', () => {
  it('donne le détail d’une séquence, les séquences d’un trimestre et les trimestres de l’année', async () => {
    await fillYear();
    const base = `/transcripts/students/${ids.ngono}`;
    const seq = await http()
      .get(`${base}?scope=sequence&periodId=${terms[1]!.seqs[0]}`)
      .set(s.censeur.auth)
      .expect(200);
    expect(seq.body).toMatchObject({
      scope: 'sequence',
      period: 'Séquence 3',
      className: '4e A',
      columns: [],
      generalAverageCenti: 1336,
      totalCoefficient: 11,
    });
    expect(seq.body.groups[1].subjects[0]).toMatchObject({
      name: 'Mathématiques',
      evaluations: [{ name: 'Composition', weight: 1, maxScore: 20, value: '14' }],
      averageCenti: 1400,
    });

    const term = await http()
      .get(`${base}?scope=term&periodId=${terms[2]!.id}`)
      .set(s.secretariat.auth)
      .expect(200);
    expect(term.body).toMatchObject({
      period: '3e trimestre',
      columns: ['Séquence 5', 'Séquence 6'],
      columnGeneralAverages: [1473, 1473],
      generalAverageCenti: 1473,
    });

    const year = await http().get(`${base}?scope=year`).set(s.direction.auth).expect(200);
    expect(year.body).toMatchObject({
      period: 'Année scolaire 2026-2027',
      columns: ['1er trimestre', '2e trimestre', '3e trimestre'],
      columnGeneralAverages: [1200, 1336, 1473],
      generalAverageCenti: 1336,
    });
    const absent = await http()
      .get(`/transcripts/students/${ids.tchana}?scope=year`)
      .set(s.direction.auth)
      .expect(200);
    expect(absent.body.groups[1].subjects[0]).toMatchObject({
      columns: [null, 1300, 1300],
      averageCenti: 1300,
    });
    expect(absent.body.generalAverageCenti).toBe(1300);

    const pdf = await http()
      .get(`${base}/pdf?scope=year`)
      .set(s.direction.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const seqPdf = await http()
      .get(`${base}/pdf?scope=sequence&periodId=${f.seq1Id}`)
      .set(s.censeur.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((seqPdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const logs = await prisma.auditLog.findMany({ where: { action: 'transcripts.issued' } });
    expect(logs.map((l) => l.after)).toEqual(
      expect.arrayContaining([
        { scope: 'year', period: 'Année scolaire 2026-2027', channel: 'staff' },
        { scope: 'sequence', period: 'Séquence 1', channel: 'staff' },
      ]),
    );
  });

  it('réserve les relevés au personnel autorisé et valide la période', async () => {
    const base = `/transcripts/students/${ids.ngono}`;
    await http().get(`${base}?scope=year`).set(s.prof.auth).expect(403);
    await http().get(`${base}?scope=year`).set(s.compta.auth).expect(403);
    await http().get(`${base}?scope=term`).set(s.direction.auth).expect(400);
    await http().get(`${base}?scope=term&periodId=inconnu`).set(s.direction.auth).expect(404);
    const outsider = await prisma.student.create({
      data: {
        schoolId: f.schoolId,
        matricule: 'CD-HORS-1',
        firstName: 'Sans',
        lastName: 'Classe',
        gender: 'F',
        birthDate: new Date('2012-01-01'),
      },
    });
    await http()
      .get(`/transcripts/students/${outsider.id}?scope=year`)
      .set(s.direction.auth)
      .expect(404);
  });

  it('au portail, ouvre les relevés de trimestre et d’année après la publication du bulletin', async () => {
    await fillYear();
    const parent = await parentLogin('677123456');
    const url = (q: string) => `/portal/children/${ids.ngono}/transcript.pdf?${q}`;
    const pdf = await http()
      .get(url(`scope=sequence&periodId=${f.seq1Id}`))
      .set(parent.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    await http()
      .get(url(`scope=term&periodId=${f.term1Id}`))
      .set(parent.auth)
      .expect(404);
    await http().get(url('scope=year')).set(parent.auth).expect(404);
    let overview = await http().get(`/portal/children/${ids.ngono}`).set(parent.auth).expect(200);
    expect(overview.body.transcripts.sequences).toHaveLength(6);
    expect(overview.body.transcripts).toMatchObject({ terms: [], year: null });

    await generate(f.term1Id);
    await publish(f.term1Id);
    await generate(terms[2]!.id);
    await publish(terms[2]!.id);
    await http()
      .get(url(`scope=term&periodId=${f.term1Id}`))
      .set(parent.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    await http().get(url('scope=year')).set(parent.auth).buffer(true).parse(binary).expect(200);
    overview = await http().get(`/portal/children/${ids.ngono}`).set(parent.auth).expect(200);
    expect(overview.body.transcripts).toMatchObject({
      terms: [{ name: '1er trimestre' }, { name: '3e trimestre' }],
      year: { id: f.yearId },
    });
    expect(
      overview.body.reportCards.find((r: { term: string }) => r.term === '3e trimestre'),
    ).toMatchObject({ annualAverageCenti: 1336, annualRankLabel: '2e' });
    // Un parent n'obtient pas le relevé d'un autre enfant.
    await http()
      .get(`/portal/children/${ids.bilong}/transcript.pdf?scope=year`)
      .set(parent.auth)
      .expect(404);
    expect(
      await prisma.auditLog.count({
        where: { action: 'transcripts.issued', after: { path: ['channel'], equals: 'portal' } },
      }),
    ).toBe(3);
  });
});

describe('tableau de bord : réussite et exports', () => {
  it('calcule le taux de réussite par classe, par trimestre et sur l’année', async () => {
    await fillYear();
    let res = await http().get('/dashboard/results').set(s.direction.auth).expect(200);
    expect(res.body.terms.map((t: { name: string }) => t.name)).toEqual([
      '1er trimestre',
      '2e trimestre',
      '3e trimestre',
    ]);
    expect(res.body.classes.find((c: { className: string }) => c.className === '4e A')).toEqual(
      expect.objectContaining({ terms: [null, null, null], annual: null }),
    );

    // Brouillons : chiffres provisoires.
    await generate(f.term1Id);
    res = await http().get('/dashboard/results').set(s.direction.auth).expect(200);
    const row = () => res.body.classes.find((c: { className: string }) => c.className === '4e A');
    // T1 : 12 · 16 · 10 ; Kevin Tchana sans moyenne n'est pas compté.
    expect(row().terms[0]).toEqual({
      counted: 3,
      passed: 3,
      ratePermille: 1000,
      averageCenti: 1267,
      provisional: true,
    });

    await publish(f.term1Id);
    await generate(terms[1]!.id);
    await publish(terms[1]!.id);
    await generate(terms[2]!.id);
    await publish(terms[2]!.id);
    res = await http().get('/dashboard/results').set(s.direction.auth).expect(200);
    expect(
      row().terms.map((c: { ratePermille: number; provisional: boolean }) => c.ratePermille),
    ).toEqual([1000, 750, 750]);
    expect(row().terms[0].provisional).toBe(false);
    // Année : 15,00 · 13,36 · 13,00 · 9,17 → 3 admis sur 4.
    expect(row().annual).toEqual({
      counted: 4,
      passed: 3,
      ratePermille: 750,
      averageCenti: 1263,
      provisional: false,
    });
    expect(res.body.overall.annual).toMatchObject({ counted: 4, passed: 3, ratePermille: 750 });
    expect(
      res.body.classes.find((c: { className: string }) => c.className === '4e B').terms,
    ).toEqual([null, null, null]);

    // La comptabilité ne voit pas les résultats scolaires.
    await http().get('/dashboard/results').set(s.compta.auth).expect(403);
  });

  it('exporte les indicateurs en Excel et en PDF selon les permissions', async () => {
    await fillYear(1);
    await generate(f.term1Id);
    await publish(f.term1Id);
    const xlsx = await http()
      .get('/dashboard/export.xlsx')
      .set(s.direction.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Synthèse',
      'Réussite par classe',
      'Recouvrement',
    ]);
    const sheet = wb.getWorksheet('Réussite par classe')!;
    const line = sheet.getRows(2, sheet.rowCount - 1)?.find((r) => r.getCell(1).value === '4e A');
    expect([line?.getCell(2).value, line?.getCell(3).value, line?.getCell(4).value]).toEqual([
      100, 3, 3,
    ]);
    const summary = wb.getWorksheet('Synthèse')!;
    const values = summary.getSheetValues().flat().filter(Boolean);
    expect(values).toContain('Taux de réussite · 1er trimestre');

    const compta = await http()
      .get('/dashboard/export.xlsx')
      .set(s.compta.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(compta.body as Buffer);
    expect(wb2.worksheets.map((w) => w.name)).toEqual(['Synthèse', 'Recouvrement']);

    const pdf = await http()
      .get('/dashboard/export.pdf')
      .set(s.censeur.auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    await http().get('/dashboard/export.pdf').set(s.prof.auth).expect(403);
    expect(await prisma.auditLog.count({ where: { action: 'dashboard.exported' } })).toBe(3);
  });
});

describe('cloisonnement des établissements', () => {
  it('une école ne voit ni les relevés, ni les décisions, ni les résultats d’une autre', async () => {
    await fillYear(1);
    await generate(f.term1Id);
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    await http()
      .get(`/transcripts/students/${ids.ngono}?scope=year`)
      .set(other.direction.auth)
      .expect(404);
    await http()
      .get(`/transcripts/students/${ids.ngono}/pdf?scope=term&periodId=${f.term1Id}`)
      .set(other.direction.auth)
      .expect(404);
    await http()
      .put('/report-cards/decisions')
      .set(other.censeur.auth)
      .send({
        studentId: ids.ngono,
        termId: terms[2]!.id,
        decision: 'NONE',
        yearEndDecision: 'EXCLUDED_WORK',
      })
      .expect(404);
    expect(await prisma.councilDecision.count()).toBe(0);
    const res = await http().get('/dashboard/results').set(other.direction.auth).expect(200);
    expect(res.body.classes.flatMap((c: { terms: unknown[] }) => c.terms).filter(Boolean)).toEqual(
      [],
    );
    expect(res.body.terms).toHaveLength(1);
  });
});
