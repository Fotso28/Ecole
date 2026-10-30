import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAsSystem } from '../src/common/context';
import { resetEnvCache } from '../src/config/env';
import { ALERT_TEMPLATE, AlertsService } from '../src/modules/alerts/alerts.service';
import {
  signWebhook,
  SimulatorMobileMoneyProvider,
} from '../src/modules/finance/mobile-money.provider';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { MemorySmsProvider } from '../src/modules/notifications/sms.provider';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

const ALERT_PHONE = '+237699000111';
const ALERT_EMAIL = 'astreinte@ecole.cm';
const MINUTE = 60_000;

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let student: string;
let tmp: string;
/** Faux serveur : passerelle e-mail (POST /email) et sonde de santé (GET /health). */
let server: Server;
let baseUrl: string;
let healthStatus = 200;
const emails: { to: string; subject: string; text: string }[] = [];

const http = () => request(app.getHttpServer());
const alerts = () => app.get(AlertsService);
const run = (now = new Date()) => runAsSystem('test:alerts', () => alerts().runChecks(now));
const later = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

function setEnv(values: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

async function alertRows(key?: string) {
  const rows = await prisma.notificationOutbox.findMany({
    where: { template: ALERT_TEMPLATE },
    orderBy: { createdAt: 'asc' },
  });
  return key ? rows.filter((r) => (r.payload as { alert?: string }).alert === key) : rows;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(healthStatus).end(JSON.stringify({ status: 'ok' }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      emails.push(JSON.parse(body));
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await new Promise((r) => server.close(r));
  setEnv({
    ALERT_SMS_TO: undefined,
    ALERT_EMAIL_TO: undefined,
    EMAIL_HTTP_URL: undefined,
    ALERT_HEALTH_URL: undefined,
    BACKUP_STATUS_FILE: undefined,
  });
});

beforeEach(async () => {
  await resetDb();
  emails.length = 0;
  healthStatus = 200;
  tmp = mkdtempSync(join(tmpdir(), 'ecole-alertes-'));
  setEnv({
    ALERT_SMS_TO: ALERT_PHONE,
    ALERT_EMAIL_TO: ALERT_EMAIL,
    ALERT_COOLDOWN_MINUTES: '60',
    EMAIL_HTTP_URL: `${baseUrl}/email`,
    ALERT_HEALTH_URL: undefined,
    BACKUP_STATUS_FILE: undefined,
  });
  f = await seedSchool();
  s = await sessions(app);
  student = (
    await enrollStudent(app, s.secretariat, {
      firstName: 'Awa',
      lastName: 'Mbarga',
      classId: f.class4AId,
      phone: '677555444',
    })
  ).id;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function webhook(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return http()
    .post('/webhooks/mobile-money')
    .set('content-type', 'application/json')
    .set('x-ecole-signature', signWebhook(raw))
    .send(raw);
}

/** Conflit réel : échec annoncé par l'opérateur, puis succès contradictoire. */
async function mobileMoneyConflict() {
  const res = await http()
    .post('/finance/payments')
    .set(s.compta.auth)
    .send({
      studentId: student,
      idempotencyKey: randomUUID(),
      amount: 25000,
      method: 'MTN_MOMO',
      payerPhone: '677555444',
    })
    .expect(201);
  await webhook({ reference: res.body.operatorReference, status: 'FAILED' }).expect(200);
  await webhook({ reference: res.body.operatorReference, status: 'SUCCESS', amount: 25000 });
}

function payment(data: { status: 'PENDING' | 'FAILED'; createdAt?: Date }) {
  return prisma.payment.create({
    data: {
      schoolId: f.schoolId,
      studentId: student,
      amount: 10000,
      method: 'ORANGE_MONEY',
      idempotencyKey: randomUUID(),
      ...data,
    },
  });
}

describe("Alertes à l'équipe technique", () => {
  it('signale un conflit Mobile Money par SMS et e-mail, sans répétition', async () => {
    SimulatorMobileMoneyProvider.statuses.clear();
    expect(await run()).toEqual([]); // premier passage : références des compteurs
    await mobileMoneyConflict();
    expect(
      await prisma.auditLog.count({ where: { action: 'finance.mobile_money_conflict' } }),
    ).toBe(1);

    expect(await run()).toEqual(['mobile_money_conflict']);
    const rows = await alertRows('mobile_money_conflict');
    expect(rows.map((r) => [r.channel, r.recipient])).toEqual([
      ['SMS', ALERT_PHONE],
      ['EMAIL', ALERT_EMAIL],
    ]);
    expect(rows[0]!.schoolId).toBeNull();
    expect(rows[0]!.body).toContain('1 conflit(s) Mobile Money');

    // Envoi réel par la table d'envoi : SMS (fournisseur existant) et passerelle e-mail.
    await app.get(NotificationsService).dispatchPending(50);
    expect(MemorySmsProvider.lastTo(ALERT_PHONE)).toContain('conflit(s) Mobile Money');
    expect(emails).toEqual([
      expect.objectContaining({
        to: ALERT_EMAIL,
        subject: '[Ecole] Conflit Mobile Money',
        text: expect.stringContaining('1 conflit(s)'),
      }),
    ]);
    expect(await prisma.notificationOutbox.count({ where: { status: 'SENT' } })).toBeGreaterThan(1);

    // Anti-répétition : un nouveau conflit pendant le délai n'est pas renvoyé tout de suite…
    await mobileMoneyConflict();
    expect(await run()).toEqual([]);
    expect(await alertRows('mobile_money_conflict')).toHaveLength(2);
    // … mais il est signalé une fois le délai écoulé, et n'est compté qu'une fois.
    expect(await run(later(61))).toEqual(['mobile_money_conflict']);
    const all = await alertRows('mobile_money_conflict');
    expect(all).toHaveLength(4);
    expect(all[3]!.body).toContain('1 conflit(s)');
    expect(await run(later(200))).toEqual([]);
  });

  it('signale les notifications abandonnées, hors alertes elles-mêmes', async () => {
    await run();
    await prisma.notificationOutbox.createMany({
      data: [
        {
          channel: 'SMS',
          recipient: '+237677000001',
          template: 'absence',
          body: 'x',
          status: 'FAILED',
        },
        {
          channel: 'SMS',
          recipient: '+237677000002',
          template: 'absence',
          body: 'x',
          status: 'FAILED',
        },
        {
          channel: 'SMS',
          recipient: ALERT_PHONE,
          template: ALERT_TEMPLATE,
          body: 'x',
          status: 'FAILED',
        },
      ],
    });
    expect(await run()).toEqual(['notifications_failed']);
    const [sms] = await alertRows('notifications_failed');
    expect(sms!.body).toContain('2 notification(s) abandonnée(s)');
  });

  it('signale les paiements en attente depuis plus de 2 h, puis après chaque délai', async () => {
    await payment({ status: 'PENDING', createdAt: new Date(Date.now() - 90 * MINUTE) });
    expect(await run()).toEqual([]);
    await payment({ status: 'PENDING', createdAt: new Date(Date.now() - 150 * MINUTE) });
    expect(await run()).toEqual(['payments_pending']);
    expect((await alertRows('payments_pending'))[0]!.body).toContain('1 paiement(s) en attente');
    expect(await run(later(10))).toEqual([]);
    // La situation dure : rappel après le délai (le premier paiement a lui aussi dépassé 2 h).
    expect(await run(later(61))).toEqual(['payments_pending']);
    expect((await alertRows('payments_pending'))[2]!.body).toContain('2 paiement(s)');
  });

  it('signale des échecs Mobile Money anormalement nombreux', async () => {
    for (let i = 0; i < 4; i++) await payment({ status: 'FAILED' });
    expect(await run()).toEqual([]);
    await payment({ status: 'FAILED' });
    expect(await run()).toEqual(['mobile_money_failures']);
    expect((await alertRows('mobile_money_failures'))[0]!.body).toContain('5 paiements');
  });

  it('signale une sauvegarde ratée ou trop ancienne, puis son rétablissement', async () => {
    const file = join(tmp, 'last-status.json');
    setEnv({ BACKUP_STATUS_FILE: file });
    // Aucun état : la sauvegarde planifiée ne tourne pas.
    expect(await run()).toEqual(['backup']);
    expect((await alertRows('backup'))[0]!.body).toContain('aucun état de sauvegarde');

    const yesterday = new Date(Date.now() - 20 * 3_600_000).toISOString();
    writeFileSync(
      file,
      JSON.stringify({
        status: 'failed',
        at: new Date().toISOString(),
        lastSuccess: yesterday,
        message: 'pg_dump',
      }),
    );
    expect(await run()).toEqual([]); // déjà signalée, délai en cours
    expect(await run(later(61))).toEqual(['backup']);
    expect((await alertRows('backup'))[2]!.body).toMatch(/a échoué \(pg_dump\)/);

    writeFileSync(file, JSON.stringify({ status: 'ok', at: new Date().toISOString() }));
    expect(await run(later(62))).toEqual(['backup']);
    expect((await alertRows('backup'))[4]!.body).toContain('de nouveau réussi');
    expect(await run(later(200))).toEqual([]);

    // Dernière réussite trop ancienne (plus de 26 h).
    writeFileSync(
      file,
      JSON.stringify({ status: 'ok', at: new Date(Date.now() - 30 * 3_600_000).toISOString() }),
    );
    expect(await run(later(201))).toEqual(['backup']);
    expect((await alertRows('backup'))[6]!.body).toContain('il y a 33 h');
  });

  it("signale l'API injoignable après trois sondes en échec, puis son retour", async () => {
    setEnv({ ALERT_HEALTH_URL: `${baseUrl}/health` });
    expect(await run()).toEqual([]);
    healthStatus = 503;
    expect(await run()).toEqual([]);
    expect(await run()).toEqual([]);
    expect(await run()).toEqual(['api_health']);
    expect((await alertRows('api_health'))[0]!.body).toContain('API injoignable depuis 3 min');
    expect(await run()).toEqual([]);
    healthStatus = 200;
    expect(await run()).toEqual(['api_health']);
    expect((await alertRows('api_health'))[2]!.body).toContain('répond de nouveau');
    expect(await run()).toEqual([]);

    // Adresse fermée : même traitement qu'une erreur HTTP.
    setEnv({ ALERT_HEALTH_URL: 'http://127.0.0.1:9/health' });
    for (let i = 0; i < 2; i++) expect(await run()).toEqual([]);
    expect(await run()).toEqual(['api_health']);
    // Retour à la normale (l'état de la sonde est gardé en mémoire par le worker).
    setEnv({ ALERT_HEALTH_URL: `${baseUrl}/health` });
    expect(await run()).toEqual(['api_health']);
  });

  it('envoie directement aux fournisseurs quand la base est indisponible', async () => {
    setEnv({ ALERT_HEALTH_URL: `${baseUrl}/health` });
    healthStatus = 500;
    const service = alerts() as unknown as { enqueue: () => Promise<void> };
    const spy = vi.spyOn(service, 'enqueue').mockRejectedValue(new Error('base injoignable'));
    try {
      for (let i = 0; i < 3; i++) await run(later(500 + i));
      expect(MemorySmsProvider.lastTo(ALERT_PHONE)).toContain('API injoignable depuis 3 min');
      expect(emails).toEqual([
        expect.objectContaining({ to: ALERT_EMAIL, subject: '[Ecole] API injoignable' }),
      ]);
      // Anti-répétition en mémoire : pas de nouvel envoi direct pendant le délai.
      await run(later(510));
      expect(MemorySmsProvider.countTo(ALERT_PHONE)).toBe(1);
      healthStatus = 200;
      expect(await run(later(511))).toEqual(['api_health']);
      expect(MemorySmsProvider.lastTo(ALERT_PHONE)).toContain('répond de nouveau');
      expect(await alertRows()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("n'envoie rien sans destinataire mais garde l'anti-répétition", async () => {
    setEnv({ ALERT_SMS_TO: '', ALERT_EMAIL_TO: '' });
    await payment({ status: 'PENDING', createdAt: new Date(Date.now() - 3 * 60 * MINUTE) });
    expect(await run()).toEqual(['payments_pending']);
    expect(await alertRows()).toHaveLength(0);
    expect(await run()).toEqual([]);
  });
});
