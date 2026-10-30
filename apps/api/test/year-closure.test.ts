import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { todayInCameroon } from '../src/common/dates';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let student: string;
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
  student = (
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
    })
  ).id;
});

describe('année scolaire clôturée', () => {
  it('refuse inscriptions, notes, appel et emploi du temps, mais accepte les arriérés', async () => {
    // Avant la clôture : une évaluation et un cours existent déjà.
    const ev = await http()
      .post('/grades/evaluations')
      .set(s.prof.auth)
      .send({
        classSubjectId: f.cs.maths4A,
        sequenceId: f.seq1Id,
        name: 'Devoir',
        type: 'HOMEWORK',
        weight: 1,
      })
      .expect(201);
    const course = await http()
      .post('/timetable/entries')
      .set(s.censeur.auth)
      .send({ classSubjectId: f.cs.maths4A, dayOfWeek: 1, startTime: '07:30', endTime: '09:20' })
      .expect(201);

    await http().post(`/academic/years/${f.yearId}/close`).set(s.direction.auth).expect(201);
    const closed = (r: request.Response) =>
      expect(r.body.message).toMatch(/Année scolaire 2026-2027 clôturée/);

    // Inscriptions.
    closed(
      await http()
        .post('/students')
        .set(s.secretariat.auth)
        .send({
          firstName: 'Kevin',
          lastName: 'Tchana',
          gender: 'M',
          birthDate: '2012-03-04',
          classId: f.class4AId,
          guardians: [
            {
              firstName: 'Paul',
              lastName: 'Tchana',
              phone: '677000111',
              relationship: 'FATHER',
              isPrimary: true,
            },
          ],
        })
        .expect(409),
    );
    // Notes et évaluations.
    closed(
      await http()
        .post('/grades/evaluations')
        .set(s.prof.auth)
        .send({
          classSubjectId: f.cs.maths4A,
          sequenceId: f.seq1Id,
          name: 'Composition',
          type: 'EXAM',
          weight: 1,
        })
        .expect(409),
    );
    closed(
      await http()
        .put(`/grades/evaluations/${ev.body.id}/grades`)
        .set(s.prof.auth)
        .send({ grades: [{ studentId: student, value: '12' }] })
        .expect(409),
    );
    closed(await http().delete(`/grades/evaluations/${ev.body.id}`).set(s.prof.auth).expect(409));
    // Appel.
    closed(
      await http()
        .post('/attendance/sessions')
        .set(s.prof.auth)
        .send({
          classId: f.class4AId,
          classSubjectId: f.cs.maths4A,
          date: todayInCameroon(),
          startTime: '07:30',
          endTime: '08:30',
          records: [{ studentId: student, status: 'PRESENT' }],
        })
        .expect(409),
    );
    // Emploi du temps.
    closed(
      await http()
        .post('/timetable/entries')
        .set(s.censeur.auth)
        .send({ classSubjectId: f.cs.maths4A, dayOfWeek: 2, startTime: '07:30', endTime: '09:20' })
        .expect(409),
    );
    closed(
      await http()
        .patch(`/timetable/entries/${course.body.id}`)
        .set(s.censeur.auth)
        .send({ dayOfWeek: 3, startTime: '07:30' })
        .expect(409),
    );
    closed(
      await http().delete(`/timetable/entries/${course.body.id}`).set(s.censeur.auth).expect(409),
    );

    // Les arriérés s'encaissent toujours.
    await http()
      .post('/finance/payments')
      .set(s.compta.auth)
      .send({
        studentId: student,
        idempotencyKey: randomUUID(),
        amount: 25000,
        method: 'BANK',
        bankName: 'Banque',
        bankReference: 'VIR-ARRIERES-1',
      })
      .expect(201);
    expect(await prisma.payment.count({ where: { studentId: student } })).toBe(1);
  });
});
