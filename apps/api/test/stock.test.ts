import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let a: { id: string };
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

async function enableModules(schoolId: string) {
  const school = await prisma.school.findUniqueOrThrow({ where: { id: schoolId } });
  await prisma.school.update({
    where: { id: schoolId },
    data: { modules: [...school.modules, 'library'] },
  });
}

beforeEach(async () => {
  await resetDb();
  f = await seedSchool();
  await enableModules(f.schoolId);
  s = await sessions(app);
  a = await enrollStudent(app, s.secretariat, {
    firstName: 'Awa',
    lastName: 'Bello',
    classId: f.class4AId,
  });
});

async function uniform() {
  const item = await http()
    .post('/stock/items')
    .set(s.compta.auth)
    .send({
      name: 'Chemise uniforme',
      category: 'UNIFORM',
      sizes: ['S', 'M'],
      unitPrice: 4500,
      alertThreshold: 5,
    })
    .expect(201);
  const purchase = await http()
    .post('/stock/purchases')
    .set(s.compta.auth)
    .send({
      itemId: item.body.id,
      size: 'M',
      quantity: 10,
      unitCost: 3000,
      supplier: 'Tissus Mfoundi',
    })
    .expect(201);
  return { id: item.body.id as string, purchaseId: purchase.body.id as string };
}

const sell = (itemId: string, quantity: number, requestId = randomUUID()) =>
  http()
    .post('/stock/sales')
    .set(s.compta.auth)
    .send({ itemId, size: 'M', quantity, studentId: a.id, requestId });

async function itemState(itemId: string) {
  const items = await http().get('/stock/items').set(s.compta.auth).expect(200);
  return items.body.find((i: { id: string }) => i.id === itemId);
}

describe('stock de fournitures et d’uniformes', () => {
  it('vend à un élève et facture une seule fois, même si la vente est renvoyée', async () => {
    const shirt = await uniform();
    const requestId = randomUUID();
    const [first, second] = await Promise.all([
      sell(shirt.id, 3, requestId),
      sell(shirt.id, 3, requestId),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    await sell(shirt.id, 3, requestId).expect(201);
    const lines = await prisma.invoiceLine.findMany({
      where: { invoice: { studentId: a.id }, label: { startsWith: 'Chemise uniforme' } },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: 13500, label: 'Chemise uniforme (taille M) × 3' });
    expect(await prisma.ledgerEntry.count({ where: { invoiceLineId: lines[0]!.id } })).toBe(1);
    const state = await itemState(shirt.id);
    expect(state.sizes).toEqual([
      { size: 'S', onHand: 0, low: true },
      { size: 'M', onHand: 7, low: false },
    ]);
    expect(state).toMatchObject({ onHand: 7, averageCost: 3000, value: 21000 });
  });

  it('interdit le stock négatif et les tailles inconnues', async () => {
    const shirt = await uniform();
    const res = await sell(shirt.id, 11).expect(409);
    expect(res.body.message).toMatch(/Stock insuffisant/);
    await http()
      .post('/stock/sales')
      .set(s.compta.auth)
      .send({ itemId: shirt.id, size: 'XL', quantity: 1, studentId: a.id, requestId: randomUUID() })
      .expect(400);
    await http()
      .post('/stock/allocations')
      .set(s.compta.auth)
      .send({ itemId: shirt.id, size: 'M', quantity: 6, reason: 'Équipe de football' })
      .expect(201);
    expect((await itemState(shirt.id)).sizes[1]).toEqual({ size: 'M', onHand: 4, low: true });
    expect(await prisma.invoiceLine.count({ where: { label: { startsWith: 'Chemise' } } })).toBe(0);
  });

  it('corrige par un mouvement inverse, une seule fois ; les mouvements sont figés', async () => {
    const shirt = await uniform();
    const sale = await sell(shirt.id, 2).expect(201);
    const rev = await http()
      .post(`/stock/movements/${sale.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Erreur de taille' })
      .expect(201);
    expect(rev.body).toMatchObject({
      type: 'REVERSAL',
      quantity: 2,
      invoiced: true,
      credited: 9000,
      notCredited: 0,
    });
    // Avoir automatique sur la ligne de facture de la vente annulée.
    const line = await prisma.invoiceLine.findUniqueOrThrow({
      where: { id: sale.body.invoiceLineId },
    });
    expect([line.amount, line.discount]).toEqual([9000, 9000]);
    await http()
      .post(`/stock/movements/${sale.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Encore' })
      .expect(409);
    await http()
      .post(`/stock/movements/${rev.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Encore' })
      .expect(409);
    const big = await sell(shirt.id, 9).expect(201);
    // Avoir partiel par le gestionnaire du stock, plafonné au reste dû de la vente.
    await http()
      .post(`/stock/movements/${big.body.id}/credit`)
      .set(s.secretariat.auth)
      .send({ amount: 4500, reason: 'Chemise défectueuse' })
      .expect(201);
    await http()
      .post(`/stock/movements/${big.body.id}/credit`)
      .set(s.secretariat.auth)
      .send({ amount: 40000, reason: 'Chemise défectueuse' })
      .expect(409);
    await http()
      .post(`/stock/movements/${shirt.purchaseId}/credit`)
      .set(s.secretariat.auth)
      .send({ amount: 100, reason: 'Pas une vente' })
      .expect(404);
    // Annuler l'achat rendrait le stock négatif.
    await http()
      .post(`/stock/movements/${shirt.purchaseId}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Livraison refusée' })
      .expect(409);
    await expect(
      prisma.stockMovement.update({ where: { id: sale.body.id }, data: { quantity: -1 } }),
    ).rejects.toThrow();
    await expect(prisma.stockMovement.delete({ where: { id: sale.body.id } })).rejects.toThrow();
    const history = await http()
      .get(`/stock/movements?itemId=${shirt.id}`)
      .set(s.compta.auth)
      .expect(200);
    expect(history.body.total).toBe(4);
  });

  it('exige une justification pour chaque écart d’inventaire', async () => {
    const shirt = await uniform();
    const bad = await http()
      .post('/stock/inventories')
      .set(s.compta.auth)
      .send({ lines: [{ itemId: shirt.id, size: 'M', counted: 8 }] })
      .expect(400);
    expect(bad.body.message).toMatch(/Justifiez/);
    const ok = await http()
      .post('/stock/inventories')
      .set(s.compta.auth)
      .send({
        note: 'Inventaire de fin de trimestre',
        lines: [
          { itemId: shirt.id, size: 'M', counted: 8, reason: 'Deux chemises tachées' },
          { itemId: shirt.id, size: 'S', counted: 0 },
        ],
      })
      .expect(201);
    expect(ok.body.gaps).toEqual([
      { itemId: shirt.id, size: 'M', expected: 10, counted: 8, gap: -2 },
    ]);
    expect((await itemState(shirt.id)).onHand).toBe(8);
    // L'inventaire est réservé à la comptabilité et à la direction.
    await http()
      .post('/stock/inventories')
      .set(s.secretariat.auth)
      .send({ lines: [{ itemId: shirt.id, size: 'M', counted: 8 }] })
      .expect(403);
    await http().get('/stock/items').set(s.prof.auth).expect(403);
  });

  it('cloisonne articles et mouvements entre écoles', async () => {
    const shirt = await uniform();
    const other = await seedSchool('autre', 'AU');
    await enableModules(other.schoolId);
    const o = await sessions(app, 'autre');
    expect((await http().get('/stock/items').set(o.compta.auth)).body).toEqual([]);
    expect((await http().get('/stock/movements').set(o.compta.auth)).body.total).toBe(0);
    await http()
      .post('/stock/purchases')
      .set(o.compta.auth)
      .send({ itemId: shirt.id, size: 'M', quantity: 1, unitCost: 1, supplier: 'X' })
      .expect(404);
    await http()
      .post(`/stock/movements/${shirt.purchaseId}/reverse`)
      .set(o.compta.auth)
      .send({ reason: 'Intrusion' })
      .expect(404);
    await http()
      .post('/stock/sales')
      .set(o.compta.auth)
      .send({ itemId: shirt.id, size: 'M', quantity: 1, studentId: a.id, requestId: randomUUID() })
      .expect(404);
  });
});
