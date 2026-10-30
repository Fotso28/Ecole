import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../src/common/crypto';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';
import {
  createPlatformAdmin,
  createSchool,
  createStaff,
  createTestApp,
  login,
  loginPlatformAdmin,
  PLATFORM_ADMIN_TOTP_SECRET,
  prisma,
  requestOtp,
  resetDb,
  toSession,
} from './helpers';

let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
});

describe('création d’établissement par la plateforme', () => {
  it('crée une école et son directeur, qui peut ensuite se connecter', async () => {
    await createPlatformAdmin();
    const admin = await loginPlatformAdmin(app);
    const created = await http()
      .post('/platform/schools')
      .set(admin.auth)
      .send({
        name: 'Collège Démo',
        slug: 'college-demo',
        city: 'Yaoundé',
        matriculePrefix: 'CD',
        director: {
          firstName: 'Alice',
          lastName: 'Ngo Bassa',
          email: 'direction@demo.cm',
          password: 'motdepasse-directeur',
        },
      })
      .expect(201);
    expect(created.body.school.slug).toBe('college-demo');

    const director = await login(app, 'direction@demo.cm', 'motdepasse-directeur');
    const me = await http().get('/auth/me').set(director.auth).expect(200);
    expect(me.body.kind).toBe('staff');
    expect(me.body.activeSchool.name).toBe('Collège Démo');
    expect(me.body.roles).toEqual(['DIRECTOR']);
    expect(me.body.permissions).toContain('finance.payments.create');
    expect(me.body.permissions).not.toContain('health.read');
  });

  it('refuse les routes plateforme à un directeur', async () => {
    const school = await createSchool('a');
    await createStaff(school.id, 'dir@a.cm', ['DIRECTOR']);
    const s = await login(app, 'dir@a.cm');
    await http().get('/platform/schools').set(s.auth).expect(403);
  });

  it('journalise un accès exceptionnel motivé et le limite à la lecture', async () => {
    await createPlatformAdmin();
    const school = await createSchool('b');
    const admin = await loginPlatformAdmin(app);
    await http()
      .post(`/platform/schools/${school.id}/access`)
      .set(admin.auth)
      .send({ reason: 'court' })
      .expect(400);
    const res = await http()
      .post(`/platform/schools/${school.id}/access`)
      .set(admin.auth)
      .send({ reason: 'Demande du directeur, ticket support 42' })
      .expect(201);
    expect(res.body.accessToken).toBeTruthy();
    const log = await prisma.auditLog.findFirst({ where: { action: 'platform.break_glass' } });
    expect(log?.reason).toBe('Demande du directeur, ticket support 42');
    expect(log?.schoolId).toBe(school.id);
  });
});

describe('connexion du personnel', () => {
  beforeEach(async () => {
    const school = await createSchool('demo');
    await createStaff(school.id, 'dir@demo.cm', ['DIRECTOR']);
  });

  it('refuse un mauvais mot de passe avec un message générique', async () => {
    const res = await http()
      .post('/auth/login')
      .send({ email: 'dir@demo.cm', password: 'faux' })
      .expect(401);
    expect(res.body.message).toBe('Adresse e-mail ou mot de passe incorrect');
    const unknown = await http()
      .post('/auth/login')
      .send({ email: 'inconnu@demo.cm', password: 'faux' })
      .expect(401);
    expect(unknown.body.message).toBe(res.body.message);
  });

  it('valide le format des données', async () => {
    const res = await http()
      .post('/auth/login')
      .send({ email: 'pas-un-email', password: '' })
      .expect(400);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(['email', 'password']);
  });

  it('pose le jeton de rafraîchissement en cookie httpOnly', async () => {
    const res = await http()
      .post('/auth/login')
      .send({ email: 'dir@demo.cm', password: 'motdepasse-test-1' })
      .expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('ecole_rt='),
    );
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(res.body.refreshToken).toBeUndefined();
  });

  it('fait tourner le jeton de rafraîchissement et détecte sa réutilisation', async () => {
    const first = await login(app, 'dir@demo.cm');
    const refreshed = await http().post('/auth/refresh').set('Cookie', first.cookie).expect(200);
    const second = toSession(refreshed);
    expect(second.cookie).not.toBe(first.cookie);
    await http().get('/auth/me').set(second.auth).expect(200);

    // Réutilisation de l'ancien jeton : toute la famille est révoquée.
    await http().post('/auth/refresh').set('Cookie', first.cookie).expect(401);
    await http().post('/auth/refresh').set('Cookie', second.cookie).expect(401);
    const log = await prisma.auditLog.findFirst({ where: { action: 'auth.refresh_reuse' } });
    expect(log).not.toBeNull();
  });

  it('révoque la session à la déconnexion', async () => {
    const s = await login(app, 'dir@demo.cm');
    await http().post('/auth/logout').set('Cookie', s.cookie).expect(204);
    await http().post('/auth/refresh').set('Cookie', s.cookie).expect(401);
  });

  it('refuse un jeton d’accès invalide ou absent', async () => {
    await http().get('/auth/me').expect(401);
    await http().get('/auth/me').set('Authorization', 'Bearer abc').expect(401);
  });

  it('refuse un compte désactivé', async () => {
    const s = await login(app, 'dir@demo.cm');
    await prisma.user.update({ where: { email: 'dir@demo.cm' }, data: { status: 'DISABLED' } });
    await http().get('/auth/me').set(s.auth).expect(401);
    await http()
      .post('/auth/login')
      .send({ email: 'dir@demo.cm', password: 'motdepasse-test-1' })
      .expect(401);
  });

  it('change d’établissement pour un membre de plusieurs écoles', async () => {
    const other = await createSchool('autre', 'AU');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'dir@demo.cm' } });
    await prisma.membership.create({
      data: { userId: user.id, schoolId: other.id, roles: ['TEACHER'] },
    });
    const s = await login(app, 'dir@demo.cm');
    const switched = toSession(
      await http()
        .post('/auth/switch-school')
        .set(s.auth)
        .set('Cookie', s.cookie)
        .send({ schoolId: other.id })
        .expect(200),
    );
    const me = await http().get('/auth/me').set(switched.auth).expect(200);
    expect(me.body.activeSchool.id).toBe(other.id);
    expect(me.body.roles).toEqual(['TEACHER']);
    expect(me.body.schools).toHaveLength(2);

    const stranger = await createSchool('etranger', 'ET');
    await http()
      .post('/auth/switch-school')
      .set(s.auth)
      .send({ schoolId: stranger.id })
      .expect(403);
  });
});

describe('double authentification', () => {
  it('active la double authentification puis l’exige à la connexion', async () => {
    const school = await createSchool('mfa');
    await createStaff(school.id, 'compta@mfa.cm', ['ACCOUNTANT']);
    const s = await login(app, 'compta@mfa.cm');
    const setup = await http().post('/auth/mfa/setup').set(s.auth).expect(200);
    expect(setup.body.otpauthUrl).toContain('otpauth://totp/');
    await http().post('/auth/mfa/enable').set(s.auth).send({ code: '000000' }).expect(400);
    await http()
      .post('/auth/mfa/enable')
      .set(s.auth)
      .send({ code: totp(setup.body.secret) })
      .expect(204);

    const step1 = await http()
      .post('/auth/login')
      .send({ email: 'compta@mfa.cm', password: 'motdepasse-test-1' })
      .expect(200);
    expect(step1.body.mfaRequired).toBe(true);
    expect(step1.body.accessToken).toBeUndefined();
    await http()
      .post('/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code: '123456' })
      .expect(401);
    // Le code ayant servi à l'activation ne peut pas être réutilisé.
    await http()
      .post('/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code: totp(setup.body.secret) })
      .expect(401);
    const next = totp(setup.body.secret, Date.now() + 30_000);
    const step2 = await http()
      .post('/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code: next })
      .expect(200);
    expect(step2.body.accessToken).toBeTruthy();
    await http()
      .post('/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code: next })
      .expect(401);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'compta@mfa.cm' } });
    expect(stored.mfaSecret).not.toContain(setup.body.secret);
  });

  it('verrouille la vérification après cinq codes erronés', async () => {
    await createPlatformAdmin();
    const step1 = await http()
      .post('/auth/login')
      .send({ email: 'admin@plateforme.cm', password: 'motdepasse-admin-1' })
      .expect(200);
    for (let i = 0; i < 5; i++) {
      await http()
        .post('/auth/mfa/verify')
        .send({ mfaToken: step1.body.mfaToken, code: '000000' })
        .expect(401);
    }
    // Même le bon code est refusé pendant le verrouillage.
    await http()
      .post('/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code: totp(PLATFORM_ADMIN_TOTP_SECRET) })
      .expect(429);
    await prisma.user.updateMany({ data: { mfaLockedUntil: new Date(Date.now() - 1000) } });
    await http()
      .post('/auth/mfa/verify')
      .send({ mfaToken: step1.body.mfaToken, code: totp(PLATFORM_ADMIN_TOTP_SECRET) })
      .expect(200);
  });

  it('exige la double authentification du super-administrateur', async () => {
    await createPlatformAdmin('admin@plateforme.cm', 'motdepasse-admin-1', { mfa: false });
    const school = await createSchool('c');
    const admin = await login(app, 'admin@plateforme.cm', 'motdepasse-admin-1');
    const res = await http().get('/platform/schools').set(admin.auth).expect(403);
    expect(res.body.code).toBe('MFA_SETUP_REQUIRED');
    await http()
      .post(`/platform/schools/${school.id}/access`)
      .set(admin.auth)
      .send({ reason: 'Demande du directeur, ticket support 42' })
      .expect(403);
    // L'activation reste possible.
    await http().post('/auth/mfa/setup').set(admin.auth).expect(200);
  });
});

describe('connexion des parents par code SMS', () => {
  beforeEach(async () => {
    const school = await createSchool('parents');
    await prisma.guardian.create({
      data: { schoolId: school.id, firstName: 'Pierre', lastName: 'Ngono', phone: '+237677123456' },
    });
  });

  it('envoie un code au parent connu et ouvre une session parent', async () => {
    const code = await requestOtp(app, '6 77 12 34 56');
    expect(code).toMatch(/^\d{6}$/);
    const res = await http()
      .post('/auth/otp/verify')
      .send({ phone: '677123456', code })
      .expect(200);
    expect(res.body.kind).toBe('parent');
    const s = toSession(res);
    const me = await http().get('/auth/me').set(s.auth).expect(200);
    expect(me.body.kind).toBe('parent');
    expect(me.body.user.phone).toBe('+237677123456');
    const guardian = await prisma.guardian.findFirstOrThrow({ where: { phone: '+237677123456' } });
    expect(guardian.userId).toBe(me.body.user.id);

    // Un code ne sert qu'une fois.
    await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(401);
    // Un parent n'accède pas aux routes du personnel.
    await http().get('/platform/schools').set(s.auth).expect(403);
  });

  it('répond pareil pour un numéro inconnu sans envoyer de SMS', async () => {
    const res = await http().post('/auth/otp/request').send({ phone: '699000000' }).expect(202);
    expect(res.body.message).toContain('Si ce numéro est connu');
    expect(MemorySmsProvider.sent).toHaveLength(0);
  });

  it('refuse un numéro non camerounais', async () => {
    await http().post('/auth/otp/request').send({ phone: '+33612345678' }).expect(400);
  });

  it('limite le nombre de demandes de code', async () => {
    for (let i = 0; i < 3; i++)
      await http().post('/auth/otp/request').send({ phone: '677123456' }).expect(202);
    await http().post('/auth/otp/request').send({ phone: '677123456' }).expect(429);
  });

  it('bloque le code après cinq essais erronés', async () => {
    const code = await requestOtp(app, '677123456');
    for (let i = 0; i < 5; i++) {
      await http()
        .post('/auth/otp/verify')
        .send({ phone: '677123456', code: code === '000000' ? '111111' : '000000' })
        .expect(401);
    }
    await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(401);
  });

  it('compte les essais simultanés sans dépasser la limite', async () => {
    const code = await requestOtp(app, '677123456');
    const wrong = code === '000000' ? '111111' : '000000';
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        http().post('/auth/otp/verify').send({ phone: '677123456', code: wrong }),
      ),
    );
    expect(results.every((r) => r.status === 401)).toBe(true);
    const otp = await prisma.otpCode.findFirstOrThrow();
    expect(otp.attempts).toBe(5);
    await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(401);
  });

  it('expire le code après cinq minutes', async () => {
    const code = await requestOtp(app, '677123456');
    await prisma.otpCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await http().post('/auth/otp/verify').send({ phone: '677123456', code }).expect(401);
  });
});
