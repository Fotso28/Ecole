import 'reflect-metadata';
import { inflateSync } from 'node:zlib';
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
import { TEST_OWNER_URL } from './setup-env';

/**
 * Accès direct à la base pour préparer et vérifier les données, avec le rôle propriétaire
 * (superutilisateur, hors Row-Level Security). L'API testée, elle, utilise le rôle ecole_app.
 */
export const prisma = new PrismaClient({ datasourceUrl: TEST_OWNER_URL });

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
    | 'TRANSPORT'
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

/**
 * Texte d'un PDF produit par pdfkit (polices standard) : flux décompressés, chaînes des
 * opérateurs de texte décodées. Suffisant pour vérifier qu'une mention est imprimée.
 */
export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const tj of content.matchAll(/\[([^\]]*)\]\s*TJ/g))
      out.push(
        [...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)]
          .map((h) =>
            [...Buffer.from(h[1]!, 'hex')]
              .map((b) => WIN_ANSI[b] ?? String.fromCharCode(b))
              .join(''),
          )
          .join(''),
      );
  }
  return out.join('\n');
}

/** Caractères WinAnsi des polices standard PDF qui diffèrent du latin-1. */
const WIN_ANSI: Record<number, string> = {
  0x80: '€',
  0x85: '…',
  0x8c: 'Œ',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x96: '–',
  0x97: '—',
  0x9c: 'œ',
};

/** Corps binaire d'une réponse (PDF, classeur). */
export function binary(
  res: NodeJS.EventEmitter,
  cb: (err: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
