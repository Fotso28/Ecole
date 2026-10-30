import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseRateSpec, RateLimiter } from '../src/common/rate-limit';
import { env } from '../src/config/env';
import { signWebhook } from '../src/modules/finance/mobile-money.provider';
import { enrollStudent, seedSchool, sessions } from './fixtures';
import { createTestApp, requestOtp, resetDb, toSession } from './helpers';

let app: INestApplication;
let s: Awaited<ReturnType<typeof sessions>>;
let student: string;
const http = () => request(app.getHttpServer());
const saved = { ...env() };

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  RateLimiter.reset();
  const f = await seedSchool();
  s = await sessions(app);
  student = (
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    })
  ).id;
});
afterEach(() => {
  Object.assign(env(), saved);
});

describe('limiteur à fenêtre fixe', () => {
  it('lit les limites et applique la plus stricte des fenêtres', () => {
    expect(parseRateSpec('5/600, 20/86400')).toEqual([
      { limit: 5, windowMs: 600_000 },
      { limit: 20, windowMs: 86_400_000 },
    ]);
    expect(() => parseRateSpec('5/0')).toThrow(/invalide/);
    const windows = parseRateSpec('2/60,3/3600');
    const t0 = 1_000_000;
    expect(RateLimiter.hit('k', windows, t0).allowed).toBe(true);
    expect(RateLimiter.hit('k', windows, t0 + 1).allowed).toBe(true);
    expect(RateLimiter.hit('k', windows, t0 + 2)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    // Fenêtre courte écoulée : la fenêtre horaire autorise encore une requête, puis bloque.
    expect(RateLimiter.hit('k', windows, t0 + 61_000).allowed).toBe(true);
    const blocked = RateLimiter.hit('k', windows, t0 + 122_000);
    expect(blocked.allowed).toBe(false);
    // Une autre clé n'est pas concernée.
    expect(RateLimiter.hit('autre', windows, t0 + 2).allowed).toBe(true);
  });
});

describe('limites dédiées aux paiements', () => {
  it('limite les demandes de paiement du portail par parent, sans gêner un autre parent', async () => {
    env().PAYMENT_RATE_PORTAL = '2/600';
    const code = await requestOtp(app, '677123456');
    const parent = toSession(
      await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(200),
    );
    const pay = () =>
      http().post('/portal/payments').set(parent.auth).send({
        studentId: student,
        amount: 1000,
        method: 'MTN_MOMO',
        payerPhone: '677123456',
        idempotencyKey: randomUUID(),
      });
    await pay().expect(201);
    await pay().expect(201);
    const blocked = await pay().expect(429);
    expect(blocked.body.message).toMatch(/Trop de demandes de paiement. Réessayez dans 10 minutes/);
    expect(blocked.headers['retry-after']).toBe('600');
    // La caisse n'est pas affectée par la limite du portail.
    await http()
      .post('/finance/payments')
      .set(s.compta.auth)
      .send({
        studentId: student,
        amount: 1000,
        method: 'MTN_MOMO',
        payerPhone: '677123456',
        idempotencyKey: randomUUID(),
      })
      .expect(201);
  });

  it('limite les encaissements de la caisse par utilisateur', async () => {
    env().PAYMENT_RATE_CASHIER = '2/60';
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const pay = (session = s.compta) =>
      http().post('/finance/payments').set(session.auth).send({
        studentId: student,
        amount: 500,
        method: 'CASH',
        idempotencyKey: randomUUID(),
      });
    await pay().expect(201);
    await pay().expect(201);
    await pay().expect(429);
    // Un autre utilisateur a son propre quota.
    await http().post('/finance/cash-sessions/open').set(s.direction.auth).expect(201);
    await pay(s.direction).expect(201);
  });

  it('limite les confirmations des opérateurs par adresse', async () => {
    env().PAYMENT_RATE_CALLBACK = '3/60';
    const raw = JSON.stringify({ reference: 'inconnue', status: 'FAILED' });
    const webhook = () =>
      http()
        .post('/webhooks/mobile-money')
        .set('content-type', 'application/json')
        .set('x-ecole-signature', signWebhook(raw))
        .send(raw);
    for (let i = 0; i < 3; i++) await webhook().expect(404);
    await webhook().expect(429);
    // Les rappels MTN et Orange partagent le quota de l'adresse ; hors mode opérateurs ils
    // n'existent pas.
    RateLimiter.reset();
    await http().post('/webhooks/mtn-momo').send({ externalId: 'x' }).expect(404);
    await http().post('/webhooks/orange-money').send({ payToken: 'x' }).expect(404);
  });
});
