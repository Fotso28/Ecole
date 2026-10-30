import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let nextYearId: string;
let six: { id: string };
let fourA: { id: string };
let fourB: { id: string };
const http = () => request(app.getHttpServer());

interface PreviewClass {
  id: string;
  name: string;
  promotionClassId: string | null;
  repeatClassId: string | null;
  students: {
    id: string;
    councilDecision: string | null;
    suggestion: string | null;
    reenrolled: { classId: string; status: string } | null;
  }[];
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
  s = await sessions(app);
  six = await enrollStudent(app, s.secretariat, {
    firstName: 'Paul',
    lastName: 'Ondoa',
    classId: f.class6AId,
  });
  fourA = await enrollStudent(app, s.secretariat, {
    firstName: 'Awa',
    lastName: 'Bello',
    classId: f.class4AId,
  });
  fourB = await enrollStudent(app, s.secretariat, {
    firstName: 'Jean',
    lastName: 'Mvondo',
    classId: f.class4BId,
  });
  const year = await http()
    .post('/academic/years')
    .set(s.direction.auth)
    .send({ name: '2027-2028', startDate: '2027-09-06', endDate: '2028-06-30' })
    .expect(201);
  nextYearId = year.body.id;
  await http()
    .post(`/academic/years/${nextYearId}/rollover`)
    .set(s.direction.auth)
    .send({ fromYearId: f.yearId })
    .expect(201);
});

async function targetClass(name: string) {
  return prisma.class.findFirstOrThrow({ where: { academicYearId: nextYearId, name } });
}

describe('réinscription de rentrée', () => {
  it('prépare chaque classe avec les classes proposées et les décisions du conseil', async () => {
    await prisma.councilDecision.create({
      data: {
        schoolId: f.schoolId,
        studentId: fourA.id,
        termId: f.term1Id,
        decision: 'HONOR_ROLL',
        decidedById: f.users.censor,
      },
    });
    const res = await http()
      .get(`/reenrollment/${nextYearId}?fromYearId=${f.yearId}`)
      .set(s.secretariat.auth)
      .expect(200);
    expect(res.body.fromYear.name).toBe('2026-2027');
    expect(res.body.targetClasses).toHaveLength(3);
    const classes = res.body.classes as PreviewClass[];
    const [new4A, new4B] = await Promise.all([targetClass('4e A'), targetClass('4e B')]);
    const c6 = classes.find((c) => c.name === '6e A')!;
    // Pas de 5e dans cette école : le niveau suivant disponible est la 4e, même lettre.
    expect(c6.promotionClassId).toBe(new4A.id);
    const c4B = classes.find((c) => c.name === '4e B')!;
    expect(c4B.promotionClassId).toBeNull();
    expect(c4B.repeatClassId).toBe(new4B.id);
    const awa = classes.find((c) => c.name === '4e A')!.students[0]!;
    // Distinction trimestrielle : décision connue du conseil mais sans effet sur le passage.
    expect(awa).toMatchObject({ id: fourA.id, councilDecision: 'HONOR_ROLL', suggestion: null });
    expect(c6.students[0]).toMatchObject({ councilDecision: null, reenrolled: null });
  });

  it('réinscrit admis et redoublants avec leur échéancier, sans toucher aux sortants', async () => {
    const [new4A, new4B] = await Promise.all([targetClass('4e A'), targetClass('4e B')]);
    const res = await http()
      .post(`/reenrollment/${nextYearId}`)
      .set(s.secretariat.auth)
      .send({
        fromYearId: f.yearId,
        items: [
          { studentId: six.id, decision: 'PROMOTED', classId: new4A.id },
          { studentId: fourB.id, decision: 'REPEATING', classId: new4B.id },
          { studentId: fourA.id, decision: 'LEFT' },
        ],
      })
      .expect(201);
    expect(res.body).toEqual({ promoted: 1, repeating: 1, left: 1, skipped: [] });

    const enrollments = await prisma.enrollment.findMany({ where: { academicYearId: nextYearId } });
    expect(enrollments).toHaveLength(2);
    const promoted = enrollments.find((e) => e.studentId === six.id)!;
    expect(promoted).toMatchObject({ classId: new4A.id, status: 'ENROLLED' });
    const previous = await prisma.enrollment.findFirstOrThrow({
      where: { studentId: six.id, academicYearId: f.yearId },
    });
    expect(promoted.previousEnrollmentId).toBe(previous.id);
    expect(enrollments.find((e) => e.studentId === fourB.id)?.status).toBe('REPEATING');
    // Les inscriptions de l'année écoulée restent intactes.
    expect(previous.status).toBe('ENROLLED');
    // Frais copiés par la reprise de structure : échéancier de la nouvelle année.
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { studentId: six.id, academicYearId: nextYearId },
      include: { lines: true },
    });
    expect(invoice.lines.map((l) => l.label)).toContain('Frais de laboratoire 4e');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'enrollments.reenrolled', entityId: nextYearId },
    });
    expect(audit.after).toMatchObject({ promoted: 1, repeating: 1, left: 1 });

    const preview = await http()
      .get(`/reenrollment/${nextYearId}?fromYearId=${f.yearId}`)
      .set(s.secretariat.auth)
      .expect(200);
    const c6 = (preview.body.classes as PreviewClass[]).find((c) => c.name === '6e A')!;
    expect(c6.students[0]?.reenrolled).toEqual({ classId: new4A.id, status: 'ENROLLED' });

    // Relancer la même opération n'inscrit personne deux fois.
    const again = await http()
      .post(`/reenrollment/${nextYearId}`)
      .set(s.secretariat.auth)
      .send({
        fromYearId: f.yearId,
        items: [{ studentId: six.id, decision: 'PROMOTED', classId: new4A.id }],
      })
      .expect(201);
    expect(again.body.promoted).toBe(0);
    expect(again.body.skipped).toEqual([
      { studentId: six.id, reason: 'Déjà inscrit pour la nouvelle année' },
    ]);
  });

  it('refuse une classe d’une autre année et une classe manquante', async () => {
    await http()
      .post(`/reenrollment/${nextYearId}`)
      .set(s.secretariat.auth)
      .send({
        fromYearId: f.yearId,
        items: [{ studentId: six.id, decision: 'PROMOTED', classId: f.class4AId }],
      })
      .expect(400);
    const missing = await http()
      .post(`/reenrollment/${nextYearId}`)
      .set(s.secretariat.auth)
      .send({ fromYearId: f.yearId, items: [{ studentId: six.id, decision: 'REPEATING' }] })
      .expect(400);
    expect(missing.body.errors[0].message).toBe('Classe d’arrivée obligatoire');
    await http()
      .get(`/reenrollment/${f.yearId}?fromYearId=${f.yearId}`)
      .set(s.secretariat.auth)
      .expect(400);
    expect(await prisma.enrollment.count({ where: { academicYearId: nextYearId } })).toBe(0);
  });

  it('réserve la réinscription au secrétariat et à la direction', async () => {
    for (const who of ['prof', 'compta', 'surveillant', 'censeur'] as const)
      await http()
        .get(`/reenrollment/${nextYearId}?fromYearId=${f.yearId}`)
        .set(s[who].auth)
        .expect(403);
    await http()
      .get(`/reenrollment/${nextYearId}?fromYearId=${f.yearId}`)
      .set(s.direction.auth)
      .expect(200);
  });
});

describe('isolation de la réinscription entre écoles', () => {
  it('une école ne prépare ni ne réinscrit les élèves d’une autre', async () => {
    const g = await seedSchool('autre', 'AU');
    const o = await sessions(app, 'autre');
    await http()
      .get(`/reenrollment/${nextYearId}?fromYearId=${f.yearId}`)
      .set(o.secretariat.auth)
      .expect(400);
    const theirNext = await http()
      .post('/academic/years')
      .set(o.direction.auth)
      .send({ name: '2027-2028', startDate: '2027-09-06', endDate: '2028-06-30' })
      .expect(201);
    await http()
      .post(`/academic/years/${theirNext.body.id}/rollover`)
      .set(o.direction.auth)
      .send({ fromYearId: g.yearId })
      .expect(201);
    const theirClass = await prisma.class.findFirstOrThrow({
      where: { academicYearId: theirNext.body.id, name: '4e A' },
    });
    const res = await http()
      .post(`/reenrollment/${theirNext.body.id}`)
      .set(o.secretariat.auth)
      .send({
        fromYearId: g.yearId,
        items: [{ studentId: six.id, decision: 'PROMOTED', classId: theirClass.id }],
      })
      .expect(201);
    expect(res.body.skipped).toEqual([
      { studentId: six.id, reason: 'Élève non inscrit l’année précédente' },
    ]);
    expect(await prisma.enrollment.count({ where: { studentId: six.id } })).toBe(1);
  });
});
