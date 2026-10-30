import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appLogger } from '../src/common/logger';
import { seedSchool, sessions } from './fixtures';
import { createTestApp, resetDb } from './helpers';

const lines: Record<string, unknown>[] = [];
let app: INestApplication;

beforeAll(async () => {
  appLogger({ format: 'json', level: 'log', write: (l) => lines.push(JSON.parse(l)) });
  app = await createTestApp();
  await resetDb();
  await seedSchool();
});
afterAll(async () => {
  await app.close();
  appLogger({ format: 'text', level: 'error' });
});

describe('Journaux structurés', () => {
  it("journalise chaque requête avec son identifiant et l'école, sans données personnelles", async () => {
    const s = await sessions(app);
    lines.length = 0;
    const res = await request(app.getHttpServer())
      .get('/students?search=677123456&q=awa@example.cm')
      .set(s.secretariat.auth)
      .set('x-request-id', 'nginx-req-0123456789')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('nginx-req-0123456789');
    const access = lines.find(
      (l) => l.context === 'HTTP' && l.requestId === 'nginx-req-0123456789',
    );
    expect(access).toMatchObject({
      level: 'info',
      method: 'GET',
      path: '/students',
      status: 200,
      actor: 'staff',
      schoolId: expect.any(String),
    });
    expect(typeof access!.durationMs).toBe('number');
    const all = JSON.stringify(lines);
    expect(all).not.toContain('677123456');
    expect(all).not.toContain('awa@example.cm');
    expect(all).not.toContain(s.secretariat.auth.Authorization.slice(7));
  });

  it('génère un identifiant quand il manque ou est invalide, et ignore les sondes de santé', async () => {
    lines.length = 0;
    const res = await request(app.getHttpServer())
      .get('/students')
      .set('x-request-id', 'bad id with spaces')
      .expect(401);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        status: 401,
        requestId: res.headers['x-request-id'],
      }),
    );
    lines.length = 0;
    await request(app.getHttpServer()).get('/health').expect(200);
    expect(lines.filter((l) => l.context === 'HTTP')).toHaveLength(0);
  });
});
