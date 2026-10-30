import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { encrypt, totp } from '../src/common/crypto';
import { env } from '../src/config/env';
import { AuthService } from '../src/modules/auth/auth.service';
import { normalizeCameroonPhone } from '@ecole/shared';
import { MemoryEmailProvider } from '../src/modules/notifications/email.provider';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';

export const prisma = new PrismaClient();

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  return app;
}

/** Vide toutes les tables (TRUNCATE ne déclenche pas les protections ligne à ligne). */
export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  MemorySmsProvider.sent.length = 0;
  MemorySmsProvider.failNext = 0;
  MemoryEmailProvider.sent.length = 0;
  MemoryEmailProvider.failNext = 0;
}

export const PLATFORM_ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Super-administrateur, double authentification activée (obligatoire pour ce rôle). */
export async function createPlatformAdmin(
  email = 'admin@plateforme.cm',
  password = 'motdepasse-admin-1',
  { mfa = true } = {},
) {
  return prisma.user.create({
    data: {
      email,
      firstName: 'Admin',
      lastName: 'Plateforme',
      isPlatformAdmin: true,
      passwordHash: await AuthService.hashPassword(password),
      ...(mfa
        ? {
            mfaEnabled: true,
            mfaSecret: encrypt(PLATFORM_ADMIN_TOTP_SECRET, env().DATA_ENCRYPTION_KEY),
          }
        : {}),
    },
  });
}

export async function loginPlatformAdmin(
  app: INestApplication,
  email = 'admin@plateforme.cm',
  password = 'motdepasse-admin-1',
): Promise<Session> {
  const step1 = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const res = await request(app.getHttpServer())
    .post('/auth/mfa/verify')
    .send({ mfaToken: step1.body.mfaToken, code: totp(PLATFORM_ADMIN_TOTP_SECRET) })
    .expect(200);
  return toSession(res);
}

export async function createSchool(slug: string, prefix = 'CD') {
  return prisma.school.create({
    data: { name: `Collège ${slug}`, slug, city: 'Yaoundé', matriculePrefix: prefix },
  });
}

export async function createStaff(
  schoolId: string,
  email: string,
  roles: (
    | 'DIRECTOR'
    | 'CENSOR'
    | 'SUPERVISOR'
    | 'SECRETARY'
    | 'ACCOUNTANT'
    | 'TEACHER'
    | 'NURSE'
  )[],
  password = 'motdepasse-test-1',
) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      firstName: 'Prénom',
      lastName: email.split('@')[0] ?? 'Nom',
      passwordHash: await AuthService.hashPassword(password),
    },
  });
  await prisma.membership.create({ data: { userId: user.id, schoolId, roles } });
  return user;
}

export interface Session {
  token: string;
  cookie: string;
  auth: { Authorization: string };
}

export async function login(
  app: INestApplication,
  email: string,
  password = 'motdepasse-test-1',
): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return toSession(res);
}

export function toSession(res: request.Response): Session {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = (raw ?? []).find((c) => c.startsWith('ecole_rt='))?.split(';')[0] ?? '';
  const token = res.body.accessToken as string;
  return { token, cookie, auth: { Authorization: `Bearer ${token}` } };
}

/** Demande un code de connexion parent et renvoie le code reçu par SMS (envoi asynchrone). */
export async function requestOtp(app: INestApplication, phone: string): Promise<string> {
  const to = normalizeCameroonPhone(phone) ?? phone;
  const before = MemorySmsProvider.countTo(to);
  await request(app.getHttpServer()).post('/auth/otp/request').send({ phone }).expect(202);
  return /(\d{6})/.exec(await MemorySmsProvider.waitFor(to, before))?.[1] ?? '';
}
