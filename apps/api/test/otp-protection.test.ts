import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { AuthService } from '../src/modules/auth/auth.service';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';
import { createSchool, createTestApp, prisma, requestOtp, resetDb } from './helpers';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const PHONE = '+237677123456';
const saved = { ...env() };

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  const school = await createSchool('parents');
  await prisma.guardian.create({
    data: { schoolId: school.id, firstName: 'Pierre', lastName: 'Ngono', phone: PHONE },
  });
});
afterEach(() => {
  Object.assign(env(), saved);
});

/** Connexion réussie : renvoie le cookie d'appareil de confiance remis par l'API. */
async function loginAndGetDevice(): Promise<string> {
  const code = await requestOtp(app, '677123456');
  const res = await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const device = cookies.find((c) => c.startsWith('ecole_pdt='));
  expect(device).toMatch(/HttpOnly/);
  return device?.split(';')[0] ?? '';
}

const smsCount = () => prisma.notificationOutbox.count({ where: { template: 'otp' } });
const lastCodeTo = async (before: number) =>
  /(\d{6})/.exec(await MemorySmsProvider.waitFor(PHONE, before))?.[1] ?? '';

describe('appareil de confiance', () => {
  it('signe le jeton pour un numéro donné et le refuse pour un autre ou expiré', () => {
    const token = AuthService.deviceToken(PHONE);
    expect(token).toMatch(/^v1\.\d+\.[0-9a-f]{32}$/);
    expect(token).not.toContain('677123456');
    expect(AuthService.isTrustedDevice(PHONE, token)).toBe(true);
    expect(AuthService.isTrustedDevice('+237699887766', token)).toBe(false);
    expect(AuthService.isTrustedDevice(PHONE, `${token.slice(0, -1)}0`)).toBe(false);
    expect(AuthService.isTrustedDevice(PHONE, undefined)).toBe(false);
    const old = AuthService.deviceToken(PHONE, Date.now() - 200 * 86_400_000);
    expect(AuthService.isTrustedDevice(PHONE, old)).toBe(false);
  });
});

describe('épuisement des codes par un tiers', () => {
  it('ne bloque pas le parent sur son téléphone habituel', async () => {
    const device = await loginAndGetDevice();
    // Un tiers épuise le quota anonyme du numéro.
    for (let i = 0; i < 5; i++)
      await http().post('/auth/otp/request').send({ phone: '677123456' }).expect(202);
    const afterAttack = await smsCount();
    expect(afterAttack).toBe(3); // 1 (connexion initiale) + 2 : le quota anonyme est de 3.
    // Le parent, depuis son appareil de confiance, reçoit quand même un code et se connecte.
    const before = MemorySmsProvider.countTo(PHONE);
    await http()
      .post('/auth/otp/request')
      .set('Cookie', device)
      .send({ phone: '677123456' })
      .expect(202);
    expect(await smsCount()).toBe(afterAttack + 1);
    const code = await lastCodeTo(before);
    await http()
      .post('/auth/otp/verify')
      .set('Cookie', device)
      .send({ phone: '677123456', code })
      .expect(200);
  });

  it('laisse valable le dernier code reçu quand le quota anonyme est atteint', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) codes.push(await requestOtp(app, '677123456'));
    // Quatrième demande : même réponse, aucun SMS, mais les codes déjà reçus restent valables.
    const res = await http().post('/auth/otp/request').send({ phone: '677123456' }).expect(202);
    expect(res.body.message).toContain('Le dernier code reçu reste valable');
    expect(await smsCount()).toBe(3);
    // Une nouvelle demande n'annule pas le code précédent : le premier code fonctionne encore.
    await http()
      .post('/auth/otp/verify')
      .send({ phone: '677123456', code: codes[0] })
      .expect(200);
    // Chaque code ne sert qu'une fois ; les autres restent utilisables.
    await http()
      .post('/auth/otp/verify')
      .send({ phone: '677123456', code: codes[0] })
      .expect(401);
    await http()
      .post('/auth/otp/verify')
      .send({ phone: '677123456', code: codes[2] })
      .expect(200);
  });

  it('isole les faux codes d’un tiers des essais depuis l’appareil de confiance', async () => {
    const device = await loginAndGetDevice();
    const before = MemorySmsProvider.countTo(PHONE);
    await http()
      .post('/auth/otp/request')
      .set('Cookie', device)
      .send({ phone: '677123456' })
      .expect(202);
    const code = await lastCodeTo(before);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await http().post('/auth/otp/verify').send({ phone: '677123456', code: wrong }).expect(401);
    await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(429);
    await http()
      .post('/auth/otp/verify')
      .set('Cookie', device)
      .send({ phone: '677123456', code })
      .expect(200);
  });

  it('plafonne les SMS par jour et par numéro', async () => {
    for (let i = 0; i < 8; i++) {
      await http().post('/auth/otp/request').send({ phone: '677123456' }).expect(202);
      // Fenêtre de 15 minutes écoulée.
      await prisma.$executeRaw`UPDATE "OtpCode" SET "createdAt" = "createdAt" - interval '16 minutes'`;
    }
    expect(await smsCount()).toBe(6);
  });

  it('suspend les demandes anonymes au-delà du budget SMS global, pas les appareils de confiance', async () => {
    const device = await loginAndGetDevice();
    env().OTP_DAILY_SMS_BUDGET = 1;
    const school = await prisma.school.findFirstOrThrow();
    await prisma.guardian.create({
      data: { schoolId: school.id, firstName: 'Awa', lastName: 'Bello', phone: '+237699887766' },
    });
    const before = await smsCount();
    await http().post('/auth/otp/request').send({ phone: '699887766' }).expect(202);
    expect(await smsCount()).toBe(before);
    await http()
      .post('/auth/otp/request')
      .set('Cookie', device)
      .send({ phone: '677123456' })
      .expect(202);
    expect(await smsCount()).toBe(before + 1);
  });

  it('n’accorde pas la confiance d’un numéro à un autre numéro', async () => {
    const device = await loginAndGetDevice();
    const school = await prisma.school.findFirstOrThrow();
    await prisma.guardian.create({
      data: { schoolId: school.id, firstName: 'Awa', lastName: 'Bello', phone: '+237699887766' },
    });
    for (let i = 0; i < 4; i++)
      await http()
        .post('/auth/otp/request')
        .set('Cookie', device)
        .send({ phone: '699887766' })
        .expect(202);
    expect(await prisma.otpCode.count({ where: { phone: '+237699887766', trusted: true } })).toBe(0);
    expect(await prisma.otpCode.count({ where: { phone: '+237699887766', sent: true } })).toBe(3);
  });
});
