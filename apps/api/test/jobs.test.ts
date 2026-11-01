import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedSchool } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const SECRET = 'Bearer test-cron-secret-0123456789';

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedSchool();
});

describe('tâches planifiées de l’hébergeur (Vercel Cron)', () => {
  it('reste introuvable sans le bon secret', async () => {
    await http().get('/jobs/outbox').expect(404);
    await http().get('/jobs/outbox').set('Authorization', 'Bearer mauvais-secret').expect(404);
    await http()
      .get('/jobs/outbox')
      .set('Authorization', 'test-cron-secret-0123456789')
      .expect(404);
  });

  it('exécute une tâche connue et refuse les autres', async () => {
    // Un SMS en attente part au passage de la tâche d'envoi.
    const school = await prisma.school.findFirstOrThrow();
    await prisma.notificationOutbox.create({
      data: {
        schoolId: school.id,
        channel: 'SMS',
        recipient: '+237677000001',
        template: 'test',
        body: 'Message de test',
      },
    });
    const res = await http().get('/jobs/outbox').set('Authorization', SECRET).expect(200);
    expect(res.body).toMatchObject({ job: 'outbox' });
    expect(
      await prisma.notificationOutbox.count({
        where: { recipient: '+237677000001', status: 'SENT' },
      }),
    ).toBe(1);
    await http().get('/jobs/accounting').set('Authorization', SECRET).expect(200);
    await http().get('/jobs/inconnue').set('Authorization', SECRET).expect(404);
    await http().get('/jobs/constructor').set('Authorization', SECRET).expect(404);
  });
});
