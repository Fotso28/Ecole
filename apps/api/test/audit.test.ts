import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
const http = () => request(app.getHttpServer());

interface AuditRow {
  id: string;
  action: string;
  label: string;
  actor: { id: string; firstName: string; lastName: string } | null;
  createdAt: string;
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
});

const list = async (qs: string, session = s.direction) =>
  (await http().get(`/audit-logs?${qs}`).set(session.auth).expect(200)).body as {
    total: number;
    pages: number;
    items: AuditRow[];
  };

describe('journal d’audit', () => {
  it('attribue chaque connexion à la personne, y compris les anciennes entrées', async () => {
    const logins = await list('action=auth.login&pageSize=100');
    const director = logins.items.find((i) => i.actor?.id === f.users.director);
    expect(director).toMatchObject({ action: 'auth.login', label: 'Connexion' });
    expect(logins.items.every((i) => i.actor !== null)).toBe(true);
    // Connexion écrite avant l'attribution (auteur vide) : rattachée au compte connecté.
    await prisma.auditLog.create({
      data: {
        schoolId: f.schoolId,
        actorId: null,
        action: 'auth.login',
        entity: 'User',
        entityId: f.users.accountant,
      },
    });
    const byAccountant = await list(`actorId=${f.users.accountant}&action=auth`);
    expect(byAccountant.items).toHaveLength(2);
    expect(byAccountant.items.every((i) => i.actor?.id === f.users.accountant)).toBe(true);
  });

  it('filtre par période (jours de Douala), personne et type d’action, avec libellés et pages', async () => {
    const at = (iso: string, action: string, actorId: string | null = f.users.director) =>
      prisma.auditLog.create({
        data: {
          schoolId: f.schoolId,
          actorId,
          action,
          entity: 'Payment',
          createdAt: new Date(iso),
        },
      });
    // 14/09 à 23 h 30 et 15/09 à 0 h 30, heure de Douala.
    await at('2026-09-14T22:30:00Z', 'finance.payment_received', f.users.accountant);
    await at('2026-09-14T23:30:00Z', 'finance.payment_reversed');
    await at('2026-09-15T10:25:00Z', 'hr.payroll_validated');
    await at('2026-09-15T10:40:00Z', 'module.inconnu');

    const day = await list('from=2026-09-15&to=2026-09-15&pageSize=100');
    const actions = day.items.map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['finance.payment_reversed', 'hr.payroll_validated']),
    );
    expect(actions).not.toContain('finance.payment_received');
    expect((await list('from=2026-09-14&to=2026-09-14')).items.map((i) => i.action)).toEqual([
      'finance.payment_received',
    ]);

    const finance = await list('action=finance');
    expect(finance.items.map((i) => [i.action, i.label])).toEqual([
      ['finance.payment_reversed', 'Paiement annulé'],
      ['finance.payment_received', 'Paiement encaissé'],
    ]);
    expect((await list('action=finance.payment_reversed')).total).toBe(1);
    const mine = await list(`actorId=${f.users.director}&from=2026-09-15&to=2026-09-15`);
    expect(mine.items.map((i) => i.action).sort()).toEqual([
      'finance.payment_reversed',
      'hr.payroll_validated',
      'module.inconnu',
    ]);
    // Code sans libellé : affiché tel quel.
    expect(mine.items.find((i) => i.action === 'module.inconnu')?.label).toBe('module.inconnu');

    const page2 = await list('from=2026-09-15&to=2026-09-15&pageSize=2&page=2');
    expect(page2).toMatchObject({ total: 3, pages: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.action).toBe('finance.payment_reversed');

    const actors = (await http().get('/audit-logs/actors').set(s.direction.auth).expect(200))
      .body as { id: string }[];
    expect(actors.map((a) => a.id)).toEqual(
      expect.arrayContaining([f.users.director, f.users.accountant]),
    );
    await http().get('/audit-logs?from=31/10/2026').set(s.direction.auth).expect(400);
    await http().get('/audit-logs/actors').set(s.compta.auth).expect(403);
  });

  it('une école ne voit ni le journal ni les personnes d’une autre', async () => {
    await seedSchool('autre', 'AU');
    const other = await sessions(app, 'autre');
    const theirs = await list('pageSize=100', other.direction);
    expect(theirs.items.some((i) => i.actor?.id === f.users.director)).toBe(false);
    const actors = (await http().get('/audit-logs/actors').set(other.direction.auth).expect(200))
      .body as { id: string }[];
    expect(actors.map((a) => a.id)).not.toContain(f.users.director);
    expect((await list(`actorId=${f.users.director}`, other.direction)).total).toBe(0);
  });
});
