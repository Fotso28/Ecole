import type { INestApplication } from '@nestjs/common';
import { findNumberGaps } from '@ecole/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAsSystem } from '../src/common/context';
import { AccountingService } from '../src/modules/accounting/accounting.service';
import { enrollStudent, seedSchool, sessions, type SchoolFixture } from './fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let f: SchoolFixture;
let s: Awaited<ReturnType<typeof sessions>>;
let student: string;
const http = () => request(app.getHttpServer());

const enableAccounting = (schoolId: string) =>
  prisma.school.update({ where: { id: schoolId }, data: { modules: { push: 'accounting' } } });

const pay = (body: Record<string, unknown>, session = s.compta) =>
  http()
    .post('/finance/payments')
    .set(session.auth)
    .send({ studentId: student, idempotencyKey: randomUUID(), ...body });

const sync = (session = s.compta) => http().post('/accounting/sync').set(session.auth).expect(201);

const lastYear = String(new Date().getUTCFullYear() - 1);

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
  student = (
    await enrollStudent(app, s.secretariat, {
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      classId: f.class4AId,
      phone: '677123456',
    })
  ).id;
});

/** Chaque écriture de l'école est équilibrée et chaque journal numéroté sans trou. */
async function expectLedgerIntegrity(schoolId: string) {
  const entries = await prisma.accountingEntry.findMany({
    where: { schoolId },
    include: { lines: true },
  });
  for (const e of entries) {
    const debit = e.lines.reduce((n, l) => n + l.debit, 0);
    const credit = e.lines.reduce((n, l) => n + l.credit, 0);
    expect(debit).toBe(credit);
    expect(debit).toBe(e.total);
    expect(e.lines.length).toBeGreaterThanOrEqual(2);
  }
  const groups = new Map<string, number[]>();
  for (const e of entries) {
    const key = `${e.fiscalYearId}:${e.journalCode}`;
    groups.set(key, [...(groups.get(key) ?? []), e.number]);
  }
  for (const numbers of groups.values()) expect(findNumberGaps(numbers)).toEqual([]);
  return entries;
}

describe('accès au module', () => {
  it('module activable par école et permissions par rôle', async () => {
    await http().get('/accounting/overview').set(s.compta.auth).expect(403);
    await enableAccounting(f.schoolId);
    await http().get('/accounting/overview').set(s.compta.auth).expect(200);
    await http().get('/accounting/overview').set(s.direction.auth).expect(200);
    await http().get('/accounting/overview').set(s.secretariat.auth).expect(403);
    await http().get('/accounting/overview').set(s.prof.auth).expect(403);
    await http().post('/accounting/sync').set(s.censeur.auth).expect(403);
  });

  it('plan comptable SYSCOHADA préchargé et sous-comptes de l’école', async () => {
    await enableAccounting(f.schoolId);
    const accounts = (await http().get('/accounting/accounts').set(s.compta.auth).expect(200))
      .body as { number: string; class: number }[];
    expect(new Set(accounts.map((a) => a.class))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(accounts.map((a) => a.number)).toEqual(
      expect.arrayContaining(['4111', '7061', '571', '521', '5521', '5522', '4011']),
    );
    await http()
      .post('/accounting/accounts')
      .set(s.compta.auth)
      .send({ parentNumber: '4011', number: '40111', label: 'ENEO' })
      .expect(201);
    const dup = await http()
      .post('/accounting/accounts')
      .set(s.compta.auth)
      .send({ parentNumber: '4011', number: '40111', label: 'ENEO bis' })
      .expect(400);
    expect(dup.body.message).toMatch(/existe déjà/);
    await http()
      .post('/accounting/accounts')
      .set(s.compta.auth)
      .send({ parentNumber: '4011', number: '4021', label: 'Hors parent' })
      .expect(400);
    const journals = (await http().get('/accounting/journals').set(s.compta.auth).expect(200))
      .body as { code: string }[];
    expect(journals.map((j) => j.code)).toEqual(['VT', 'CA', 'BQ', 'MM', 'AC', 'OD', 'AN']);
  });
});

describe('alimentation automatique depuis la scolarité', () => {
  async function tuitionActivity() {
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    const cash = await pay({ amount: 40_000, method: 'CASH' }).expect(201);
    await pay({
      amount: 25_000,
      method: 'BANK',
      bankName: 'Afriland',
      bankReference: 'VIR-1',
    }).expect(201);
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { label: 'Tranche 3' } });
    await http()
      .post(`/finance/invoice-lines/${line.id}/discounts`)
      .set(s.compta.auth)
      .send({ amount: 10_000, reason: 'Bourse d’excellence' })
      .expect(201);
    await http()
      .post(`/finance/payments/${cash.body.id}/reverse`)
      .set(s.direction.auth)
      .send({ reason: 'Erreur de saisie au guichet' })
      .expect(201);
  }

  it('rattrape l’historique : facture, paiements, réduction et annulation, chacune une fois', async () => {
    await tuitionActivity(); // avant l'activation du module : historique
    await enableAccounting(f.schoolId);
    const ledger = await prisma.ledgerEntry.findMany({ where: { schoolId: f.schoolId } });
    const overview = await http().get('/accounting/overview').set(s.compta.auth).expect(200);
    expect(overview.body.pendingTuition).toBe(ledger.length);

    const first = await sync();
    expect(first.body).toEqual({ posted: ledger.length, failed: 0, pending: 0 });
    const entries = await expectLedgerIntegrity(f.schoolId);
    expect(entries).toHaveLength(ledger.length);
    expect(new Set(entries.map((e) => e.sourceId))).toEqual(new Set(ledger.map((l) => l.id)));

    // Journaux : recettes (factures, réduction), caisse (paiement et annulation), banque.
    const byJournal = (code: string) => entries.filter((e) => e.journalCode === code);
    expect(byJournal('VT').length).toBe(
      ledger.filter((l) => l.type !== 'PAYMENT' && l.type !== 'REVERSAL').length,
    );
    expect(byJournal('CA')).toHaveLength(2);
    expect(byJournal('BQ')).toHaveLength(1);
    const reversal = await prisma.ledgerEntry.findFirstOrThrow({ where: { type: 'REVERSAL' } });
    const reversalEntry = entries.find((e) => e.sourceId === reversal.id);
    expect(reversalEntry?.journalCode).toBe('CA');
    expect(reversalEntry?.lines.find((l) => l.accountNumber === '571')).toMatchObject({
      debit: 0,
      credit: 40_000,
    });
    const discount = entries.find((e) => e.lines.some((l) => l.accountNumber === '7091'));
    expect(discount?.total).toBe(10_000);

    // Le compte 4111 reflète exactement le solde dû par les familles.
    const ledgerBalance = ledger.reduce((n, l) => n + l.amount, 0);
    const lines = entries.flatMap((e) => e.lines).filter((l) => l.accountNumber === '4111');
    expect(lines.reduce((n, l) => n + l.debit - l.credit, 0)).toBe(ledgerBalance);
    const caisse = entries.flatMap((e) => e.lines).filter((l) => l.accountNumber === '571');
    expect(caisse.reduce((n, l) => n + l.debit - l.credit, 0)).toBe(0);

    // Relance : aucune écriture en double.
    expect((await sync()).body).toEqual({ posted: 0, failed: 0, pending: 0 });
    expect(await prisma.accountingEntry.count()).toBe(ledger.length);
  });

  it('idempotent face aux relances du worker et aux synchronisations simultanées', async () => {
    await enableAccounting(f.schoolId);
    await tuitionActivity();
    const service = app.get(AccountingService);
    const results = await Promise.all([
      runAsSystem('test', () => service.syncTuition(), f.schoolId),
      runAsSystem('test', () => service.syncTuition(), f.schoolId),
      service.syncAllSchools(),
      service.syncAllSchools(),
    ]);
    const ledger = await prisma.ledgerEntry.count();
    const posted = results.reduce((n, r) => n + r.posted, 0);
    expect(posted).toBe(ledger);
    expect(await prisma.accountingEntry.count()).toBe(ledger);
    await expectLedgerIntegrity(f.schoolId);
    // Nouvelle opération après coup : seule elle est passée.
    await pay({ amount: 5_000, method: 'MTN_MOMO', payerPhone: '677000001' }).expect(201);
    const reference = (await prisma.payment.findFirstOrThrow({ where: { method: 'MTN_MOMO' } })).id;
    await http().post(`/dev/mobile-money/${reference}/SUCCESS`).expect(200);
    expect((await service.syncAllSchools()).posted).toBe(1);
    const momo = await prisma.accountingEntry.findFirstOrThrow({
      where: { journalCode: 'MM' },
      include: { lines: true },
    });
    expect(momo.lines.find((l) => l.accountNumber === '5521')?.debit).toBe(5_000);
  });

  it('une école n’est jamais alimentée par les opérations d’une autre', async () => {
    await enableAccounting(f.schoolId);
    const other = await seedSchool('autre', 'AU');
    await enableAccounting(other.schoolId);
    const so = await sessions(app, 'autre');
    await sync();
    await sync(so.compta);
    expect(await prisma.accountingEntry.count({ where: { schoolId: other.schoolId } })).toBe(0);
    const entries = await prisma.accountingEntry.count({ where: { schoolId: f.schoolId } });
    expect(entries).toBeGreaterThan(0);
  });
});

describe('saisie, contre-passation et refus de modification', () => {
  beforeEach(async () => {
    await enableAccounting(f.schoolId);
  });

  const entry = (lines: unknown[], extra: Record<string, unknown> = {}) =>
    http()
      .post('/accounting/entries')
      .set(s.compta.auth)
      .send({
        journal: 'OD',
        date: new Date().toISOString().slice(0, 10),
        label: 'Apport du promoteur',
        pieceRef: 'PV-01',
        lines,
        ...extra,
      });

  it('partie double obligatoire, numérotation continue, contre-passation', async () => {
    const unbalanced = await entry([
      { accountNumber: '521', debit: 100_000 },
      { accountNumber: '101', credit: 90_000 },
    ]).expect(400);
    expect(unbalanced.body.message).toMatch(/déséquilibrée/);
    await entry([
      { accountNumber: '999', debit: 1 },
      { accountNumber: '101', credit: 1 },
    ]).expect(400);
    await entry([
      { accountNumber: '5219', debit: 1 },
      { accountNumber: '101', credit: 1 },
    ]).expect(400);
    await entry(
      [
        { accountNumber: '521', debit: 1 },
        { accountNumber: '101', credit: 1 },
      ],
      { journal: 'AN' },
    ).expect(400);

    const year = new Date().getUTCFullYear();
    const a = await entry([
      { accountNumber: '521', debit: 100_000 },
      { accountNumber: '101', credit: 100_000 },
    ]).expect(201);
    expect(a.body.reference).toBe(`OD-${year}-000001`);
    const b = await entry([
      { accountNumber: '6052', debit: 5_000 },
      { accountNumber: '571', credit: 5_000 },
    ]).expect(201);
    expect(b.body.reference).toBe(`OD-${year}-000002`);

    const rev = await http()
      .post(`/accounting/entries/${a.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Apport saisi deux fois' })
      .expect(201);
    expect(rev.body.reference).toBe(`OD-${year}-000003`);
    expect(rev.body.reversesEntryId).toBe(a.body.id);
    expect(rev.body.lines).toEqual([
      { accountNumber: '521', label: null, debit: 0, credit: 100_000 },
      { accountNumber: '101', label: null, debit: 100_000, credit: 0 },
    ]);
    await http()
      .post(`/accounting/entries/${a.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Encore une fois' })
      .expect(409);
    await http()
      .post(`/accounting/entries/${rev.body.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Annuler la correction' })
      .expect(409);
    const original = (await http().get(`/accounting/entries/${a.body.id}`).set(s.compta.auth)).body;
    expect(original.reversedBy).toBe(rev.body.reference);
    expect(original.total).toBe(100_000);

    // Une écriture automatique se corrige dans la scolarité, pas par contre-passation.
    await sync();
    const auto = await prisma.accountingEntry.findFirstOrThrow({ where: { sourceType: 'LEDGER' } });
    await http()
      .post(`/accounting/entries/${auto.id}/reverse`)
      .set(s.compta.auth)
      .send({ reason: 'Tentative de correction' })
      .expect(409);
    const audit = await prisma.auditLog.count({
      where: { action: { in: ['accounting.entry_created', 'accounting.entry_reversed'] } },
    });
    expect(audit).toBe(3);
    await expectLedgerIntegrity(f.schoolId);
  });

  it('la base refuse toute modification, suppression, écriture déséquilibrée ou trou de numérotation', async () => {
    await sync();
    const e = await prisma.accountingEntry.findFirstOrThrow({ include: { lines: true } });
    const line = e.lines[0]!;
    await expect(
      prisma.accountingEntry.update({ where: { id: e.id }, data: { label: 'Modifié' } }),
    ).rejects.toThrow(/ni modifiées ni supprimées/);
    await expect(prisma.accountingEntry.delete({ where: { id: e.id } })).rejects.toThrow(
      /ni modifiées ni supprimées/,
    );
    await expect(
      prisma.accountingLine.update({ where: { id: line.id }, data: { debit: line.debit + 1 } }),
    ).rejects.toThrow(/ni modifiées ni supprimées/);
    await expect(prisma.accountingLine.delete({ where: { id: line.id } })).rejects.toThrow(
      /ni modifiées ni supprimées/,
    );
    // Ligne ajoutée après coup à une écriture validée : déséquilibre refusé.
    await expect(
      prisma.accountingLine.create({
        data: {
          schoolId: f.schoolId,
          entryId: e.id,
          accountNumber: '571',
          debit: 1,
          order: 9,
        },
      }),
    ).rejects.toThrow(/déséquilibrée/);

    const base = {
      schoolId: f.schoolId,
      fiscalYearId: e.fiscalYearId,
      journalCode: 'OD',
      reference: 'OD-X',
      date: e.date,
      label: 'Direct',
      total: 1_000,
    };
    const unbalanced = prisma.$transaction(async (tx) => {
      const x = await tx.accountingEntry.create({ data: { ...base, number: 1 } });
      await tx.accountingLine.createMany({
        data: [
          { schoolId: f.schoolId, entryId: x.id, accountNumber: '571', debit: 1_000, order: 0 },
          { schoolId: f.schoolId, entryId: x.id, accountNumber: '4111', credit: 999, order: 1 },
        ],
      });
    });
    await expect(unbalanced).rejects.toThrow(/déséquilibrée/);
    await expect(prisma.accountingEntry.create({ data: { ...base, number: 2 } })).rejects.toThrow(
      /Numérotation du journal OD : 1 attendu/,
    );
    expect(await prisma.accountingEntry.count({ where: { journalCode: 'OD' } })).toBe(0);
  });
});

describe('dépenses', () => {
  beforeEach(async () => {
    await enableAccounting(f.schoolId);
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
  });

  const expense = (body: Record<string, unknown>, session = s.compta) =>
    http()
      .post('/accounting/expenses')
      .set(session.auth)
      .send({
        supplierName: 'ENEO',
        date: new Date().toISOString().slice(0, 10),
        label: 'Électricité octobre',
        accountNumber: '6052',
        method: 'BANK',
        pieceRef: 'F-2026-118',
        ...body,
      });

  it('sous le seuil : comptabilisée aussitôt (achats puis règlement)', async () => {
    const res = await expense({ amount: 45_000, method: 'CASH' }).expect(201);
    expect(res.body).toMatchObject({ status: 'POSTED', needsApproval: false, threshold: 100_000 });
    expect(res.body.entries).toHaveLength(2);
    const entries = await prisma.accountingEntry.findMany({
      where: { sourceId: res.body.id },
      include: { lines: true },
      orderBy: { journalCode: 'asc' },
    });
    expect(entries.map((e) => [e.journalCode, e.pieceRef])).toEqual([
      ['AC', 'F-2026-118'],
      ['CA', 'F-2026-118'],
    ]);
    expect(entries[0]?.lines.find((l) => l.accountNumber === '6052')?.debit).toBe(45_000);
    expect(entries[1]?.lines.find((l) => l.accountNumber === '571')?.credit).toBe(45_000);
    await expense({ amount: 1_000, accountNumber: '2442' }).expect(400);
    await expense({ amount: 1_000, pieceRef: '' }).expect(400);
    await expense({ amount: 1_000, supplierName: undefined }).expect(400);
  });

  it('au-delà du seuil : validation par une autre personne', async () => {
    const res = await expense({ amount: 150_000 }).expect(201);
    expect(res.body).toMatchObject({
      status: 'PENDING_APPROVAL',
      needsApproval: true,
      entries: [],
    });
    expect(await prisma.accountingEntry.count({ where: { sourceId: res.body.id } })).toBe(0);
    const self = await http()
      .post(`/accounting/expenses/${res.body.id}/approve`)
      .set(s.compta.auth)
      .expect(403);
    expect(self.body.message).toMatch(/autre personne/);
    const ok = await http()
      .post(`/accounting/expenses/${res.body.id}/approve`)
      .set(s.direction.auth)
      .expect(201);
    expect(ok.body.entries).toHaveLength(2);
    await http()
      .post(`/accounting/expenses/${res.body.id}/approve`)
      .set(s.direction.auth)
      .expect(409);
    const list = (await http().get('/accounting/expenses').set(s.compta.auth)).body;
    expect(list[0]).toMatchObject({ status: 'POSTED', supplier: 'ENEO', amount: 150_000 });
    expect(list[0].approvedBy).toBeTruthy();

    const other = await expense({ amount: 200_000, pieceRef: 'F-2' }).expect(201);
    await http()
      .post(`/accounting/expenses/${other.body.id}/reject`)
      .set(s.direction.auth)
      .send({ reason: 'Facture en double' })
      .expect(201);
    expect(await prisma.accountingEntry.count({ where: { sourceId: other.body.id } })).toBe(0);
    await expect(
      prisma.expense.update({ where: { id: other.body.id }, data: { status: 'POSTED' } }),
    ).rejects.toThrow(/ne se modifie plus/);
    await expect(prisma.expense.delete({ where: { id: other.body.id } })).rejects.toThrow(
      /supprimée/,
    );
    const audit = await prisma.auditLog.findMany({
      where: { entity: 'Expense' },
      select: { action: true },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'accounting.expense_approved',
      'accounting.expense_created',
      'accounting.expense_created',
      'accounting.expense_rejected',
    ]);
  });

  it('seuil réglable par la direction uniquement', async () => {
    await http()
      .put('/accounting/settings')
      .set(s.compta.auth)
      .send({ expenseApprovalThreshold: 0 })
      .expect(403);
    await http()
      .put('/accounting/settings')
      .set(s.direction.auth)
      .send({ expenseApprovalThreshold: 20_000 })
      .expect(200);
    const res = await expense({ amount: 25_000 }).expect(201);
    expect(res.body.status).toBe('PENDING_APPROVAL');
  });
});

describe('exercices : clôture et report à nouveau', () => {
  beforeEach(async () => {
    await enableAccounting(f.schoolId);
  });

  it('la clôture bloque toute écriture sur la période et reporte les soldes', async () => {
    await sync();
    const opened = await http()
      .post('/accounting/fiscal-years')
      .set(s.compta.auth)
      .send({ startDate: `${lastYear}-01-01`, endDate: `${lastYear}-12-31` })
      .expect(201);
    expect(opened.body).toMatchObject({ name: `Exercice ${lastYear}`, status: 'OPEN' });
    await http()
      .post('/accounting/fiscal-years')
      .set(s.compta.auth)
      .send({ startDate: `${lastYear}-06-01`, endDate: `${Number(lastYear) + 1}-05-31` })
      .expect(409);
    await http()
      .post('/accounting/entries')
      .set(s.compta.auth)
      .send({
        journal: 'OD',
        date: `${lastYear}-03-01`,
        label: 'Apport du promoteur',
        lines: [
          { accountNumber: '521', debit: 100_000 },
          { accountNumber: '101', credit: 100_000 },
        ],
      })
      .expect(201);
    await http()
      .post('/accounting/expenses')
      .set(s.compta.auth)
      .send({
        supplierName: 'CAMWATER',
        date: `${lastYear}-04-01`,
        label: 'Eau',
        amount: 20_000,
        accountNumber: '6051',
        method: 'BANK',
        pieceRef: 'CW-77',
      })
      .expect(201);
    const pending = await http()
      .post('/accounting/expenses')
      .set(s.compta.auth)
      .send({
        supplierName: 'Menuiserie Ndzana',
        date: `${lastYear}-05-01`,
        label: 'Tables-bancs',
        amount: 300_000,
        accountNumber: '6056',
        method: 'CASH',
        pieceRef: 'MN-1',
      })
      .expect(201);

    // La direction ne clôture pas un exercice dont une dépense attend sa validation.
    const blocked = await http()
      .post(`/accounting/fiscal-years/${opened.body.id}/close`)
      .set(s.direction.auth)
      .expect(409);
    expect(blocked.body.message).toMatch(/attendent encore/);
    await http()
      .post(`/accounting/expenses/${pending.body.id}/reject`)
      .set(s.direction.auth)
      .send({ reason: 'Devis non retenu' })
      .expect(201);
    await http()
      .post(`/accounting/fiscal-years/${opened.body.id}/close`)
      .set(s.secretariat.auth)
      .expect(403);

    const closed = await http()
      .post(`/accounting/fiscal-years/${opened.body.id}/close`)
      .set(s.direction.auth)
      .expect(201);
    expect(closed.body).toMatchObject({ status: 'CLOSED', result: -20_000 });
    expect(closed.body.carryForward).toMatch(/^AN-\d{4}-000001$/);
    const an = await prisma.accountingEntry.findFirstOrThrow({
      where: { journalCode: 'AN' },
      include: { lines: { orderBy: { accountNumber: 'asc' } } },
    });
    expect(an.fiscalYearId).toBe(closed.body.nextFiscalYear.id);
    expect(an.lines.map((l) => [l.accountNumber, l.debit, l.credit])).toEqual([
      ['101', 0, 100_000],
      ['139', 20_000, 0],
      ['521', 80_000, 0],
    ]);

    // Plus aucune écriture sur la période clôturée, ni par l'API ni directement en base.
    const refused = await http()
      .post('/accounting/entries')
      .set(s.compta.auth)
      .send({
        journal: 'OD',
        date: `${lastYear}-12-15`,
        label: 'Écriture tardive',
        lines: [
          { accountNumber: '571', debit: 1_000 },
          { accountNumber: '101', credit: 1_000 },
        ],
      })
      .expect(409);
    expect(refused.body.message).toMatch(/Exercice clôturé/);
    await http()
      .post('/accounting/expenses')
      .set(s.compta.auth)
      .send({
        supplierName: 'CAMWATER',
        date: `${lastYear}-12-15`,
        label: 'Eau',
        amount: 1_000,
        accountNumber: '6051',
        method: 'BANK',
        pieceRef: 'CW-78',
      })
      .expect(409);
    const counter = await prisma.counter.findFirst({
      where: { key: `accounting:${opened.body.id}:OD` },
    });
    await expect(
      prisma.accountingEntry.create({
        data: {
          schoolId: f.schoolId,
          fiscalYearId: opened.body.id,
          journalCode: 'OD',
          number: (counter?.value ?? 0) + 1,
          reference: 'OD-X',
          date: new Date(`${lastYear}-12-15`),
          label: 'Direct',
          total: 1,
        },
      }),
    ).rejects.toThrow(/Exercice clôturé/);
    await expect(
      prisma.fiscalYear.update({ where: { id: opened.body.id }, data: { status: 'OPEN' } }),
    ).rejects.toThrow(/ne peut pas être rouvert/);
    await expect(prisma.fiscalYear.delete({ where: { id: opened.body.id } })).rejects.toThrow(
      /supprimé/,
    );
    await http()
      .post(`/accounting/fiscal-years/${opened.body.id}/close`)
      .set(s.direction.auth)
      .expect(409);
    // L'exercice en cours ne se clôture qu'après sa date de fin.
    const early = await http()
      .post(`/accounting/fiscal-years/${closed.body.nextFiscalYear.id}/close`)
      .set(s.direction.auth)
      .expect(409);
    expect(early.body.message).toMatch(/après sa date de fin/);
    expect(
      await prisma.auditLog.count({ where: { action: 'accounting.fiscal_year_closed' } }),
    ).toBe(1);

    // Bilan d'ouverture du nouvel exercice cohérent avec le report.
    const year = new Date().getUTCFullYear();
    const bilan = await http()
      .get(`/accounting/reports/bilan?from=${year}-01-01&to=${year}-01-01`)
      .set(s.compta.auth)
      .expect(200);
    expect(bilan.body.sheet.totalAssets).toBe(bilan.body.sheet.totalLiabilities);
    await expectLedgerIntegrity(f.schoolId);
  });
});

describe('états et exports', () => {
  beforeEach(async () => {
    await enableAccounting(f.schoolId);
    await http().post('/finance/cash-sessions/open').set(s.compta.auth).expect(201);
    await pay({ amount: 60_000, method: 'CASH' }).expect(201);
    await sync();
    await http()
      .post('/accounting/expenses')
      .set(s.compta.auth)
      .send({
        supplierName: 'Librairie Peuple',
        date: new Date().toISOString().slice(0, 10),
        label: 'Craies et registres',
        amount: 12_500,
        accountNumber: '6055',
        method: 'CASH',
        pieceRef: 'LP-9',
      })
      .expect(201);
  });

  const year = new Date().getUTCFullYear();
  const period = `from=${year}-01-01&to=${year}-12-31`;

  it('balance, grand livre, journal, compte de résultat et bilan cohérents', async () => {
    const charges = await prisma.ledgerEntry.aggregate({
      where: { type: 'CHARGE' },
      _sum: { amount: true },
    });
    const balance = (await http().get(`/accounting/reports/balance?${period}`).set(s.compta.auth))
      .body;
    expect(balance.balance.totals.debit).toBe(balance.balance.totals.credit);
    expect(balance.balance.totals.balanceDebit).toBe(balance.balance.totals.balanceCredit);
    const caisse = balance.balance.rows.find(
      (r: { accountNumber: string }) => r.accountNumber === '571',
    );
    expect(caisse).toMatchObject({ debit: 60_000, credit: 12_500, balanceDebit: 47_500 });

    const is = (
      await http().get(`/accounting/reports/compte-de-resultat?${period}`).set(s.compta.auth)
    ).body.statement;
    expect(is.totalProducts).toBe(charges._sum.amount);
    expect(is.totalCharges).toBe(12_500);
    expect(is.result).toBe((charges._sum.amount ?? 0) - 12_500);

    const bilan = (await http().get(`/accounting/reports/bilan?${period}`).set(s.compta.auth)).body
      .sheet;
    expect(bilan.totalAssets).toBe(bilan.totalLiabilities);
    expect(bilan.result).toBe(is.result);

    const gl = (
      await http().get(`/accounting/reports/grand-livre?${period}&account=571`).set(s.compta.auth)
    ).body;
    expect(gl.accounts).toHaveLength(1);
    expect(gl.accounts[0]).toMatchObject({ accountNumber: '571', closing: 47_500 });

    const journal = (
      await http().get(`/accounting/reports/journal?${period}&journal=CA`).set(s.compta.auth)
    ).body;
    expect(journal.title).toBe('Journal Caisse');
    expect(journal.entries).toHaveLength(2);
    expect(journal.totals).toEqual({ debit: 72_500, credit: 72_500 });

    await http()
      .get(`/accounting/reports/balance?from=${year}-12-01&to=${year + 1}-01-31`)
      .set(s.compta.auth)
      .expect(400);
    await http().get(`/accounting/reports/inconnu?${period}`).set(s.compta.auth).expect(400);
  });

  it('exports Excel et PDF de chaque état', async () => {
    for (const kind of ['journal', 'grand-livre', 'balance', 'compte-de-resultat', 'bilan']) {
      const xlsx = await http()
        .get(`/accounting/reports/${kind}/export.xlsx?${period}`)
        .set(s.compta.auth)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      const pdf = await http()
        .get(`/accounting/reports/${kind}/export.pdf?${period}`)
        .set(s.compta.auth)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    }
  });
});

describe('isolation entre écoles', () => {
  it('une école ne voit ni ne modifie la comptabilité d’une autre', async () => {
    await enableAccounting(f.schoolId);
    const other = await seedSchool('autre', 'AU');
    await enableAccounting(other.schoolId);
    const so = await sessions(app, 'autre');
    await sync();
    const pendingExpense = await http()
      .post('/accounting/expenses')
      .set(s.compta.auth)
      .send({
        supplierName: 'ENEO',
        date: new Date().toISOString().slice(0, 10),
        label: 'Électricité',
        amount: 500_000,
        accountNumber: '6052',
        method: 'BANK',
        pieceRef: 'E-1',
      })
      .expect(201);
    const entryA = await prisma.accountingEntry.findFirstOrThrow({
      where: { schoolId: f.schoolId },
    });
    const yearA = await prisma.fiscalYear.findFirstOrThrow({ where: { schoolId: f.schoolId } });

    await http().get(`/accounting/entries/${entryA.id}`).set(so.compta.auth).expect(404);
    await http()
      .post(`/accounting/entries/${entryA.id}/reverse`)
      .set(so.compta.auth)
      .send({ reason: 'Intrusion' })
      .expect(404);
    await http()
      .post(`/accounting/expenses/${pendingExpense.body.id}/approve`)
      .set(so.direction.auth)
      .expect(404);
    await http()
      .post(`/accounting/expenses/${pendingExpense.body.id}/reject`)
      .set(so.direction.auth)
      .send({ reason: 'Intrusion' })
      .expect(404);
    await http()
      .post(`/accounting/fiscal-years/${yearA.id}/close`)
      .set(so.direction.auth)
      .expect(404);
    const year = new Date().getUTCFullYear();
    const listed = await http()
      .get(`/accounting/entries?from=${year}-01-01&to=${year}-12-31`)
      .set(so.compta.auth)
      .expect(200);
    expect(listed.body).toEqual([]);
    expect((await http().get('/accounting/expenses').set(so.compta.auth)).body).toEqual([]);
    expect((await http().get('/accounting/fiscal-years').set(so.compta.auth)).body).toEqual([]);
    expect((await http().get('/accounting/suppliers').set(so.compta.auth)).body).toEqual([]);

    // Numérotation indépendante : la première écriture de l'autre école porte le numéro 1.
    const b = await http()
      .post('/accounting/entries')
      .set(so.compta.auth)
      .send({
        journal: 'VT',
        date: `${year}-02-01`,
        label: 'Frais d’examen',
        lines: [
          { accountNumber: '4111', debit: 2_000 },
          { accountNumber: '7068', credit: 2_000 },
        ],
      })
      .expect(201);
    expect(b.body.reference).toBe(`VT-${year}-000001`);
    // Sous-compte d'une école invisible pour l'autre.
    await http()
      .post('/accounting/accounts')
      .set(so.compta.auth)
      .send({ parentNumber: '4011', number: '40119', label: 'Fournisseur de B' })
      .expect(201);
    const accountsA = (await http().get('/accounting/accounts').set(s.compta.auth)).body as {
      number: string;
    }[];
    expect(accountsA.some((a) => a.number === '40119')).toBe(false);
    expect(await prisma.accountingEntry.count({ where: { schoolId: other.schoolId } })).toBe(1);
  });
});
