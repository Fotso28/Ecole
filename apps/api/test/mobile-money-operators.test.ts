import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RateLimiter } from '../src/common/rate-limit';
import { FinanceService } from '../src/modules/finance/finance.service';
import {
  MOBILE_MONEY_PROVIDER,
  OperatorPendingError,
  OperatorRejectedError,
  OperatorsMobileMoneyProvider,
} from '../src/modules/finance/mobile-money.provider';
import { MtnMomoProvider } from '../src/modules/finance/mtn-momo.provider';
import { OrangeMoneyProvider } from '../src/modules/finance/orange-money.provider';
import { FakeMtn, FakeOrange, mtnTestConfig, orangeTestConfig } from './fake-operators';
import { enrollStudent, seedSchool, sessions } from './fixtures';
import { prisma, resetDb } from './helpers';

const collect = (over: Partial<Parameters<MtnMomoProvider['requestPayment']>[0]> = {}) => ({
  paymentId: 'cmpaiement000000000000001',
  amount: 35000,
  phone: '+237677123456',
  method: 'MTN_MOMO' as const,
  description: 'Scolarité',
  ...over,
});

describe('adaptateur MTN MoMo (API Collection)', () => {
  let mtn: FakeMtn;
  let provider: MtnMomoProvider;
  beforeEach(() => {
    mtn = new FakeMtn();
    provider = new MtnMomoProvider(mtnTestConfig(mtn.baseUrl), mtn.fetch);
  });

  it('obtient un jeton OAuth, envoie la demande de paiement et réutilise le jeton', async () => {
    const { reference } = await provider.requestPayment(collect());
    expect(reference).toBe(MtnMomoProvider.referenceFor('cmpaiement000000000000001'));
    expect(reference).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [token, pay] = mtn.calls;
    expect(token).toMatchObject({ method: 'POST', url: 'https://mtn.test/collection/token/' });
    expect(token?.headers['ocp-apim-subscription-key']).toBe('cle-collection');
    expect(pay?.url).toBe('https://mtn.test/collection/v1_0/requesttopay');
    expect(pay?.headers).toMatchObject({
      authorization: 'Bearer jeton-1',
      'x-reference-id': reference,
      'x-target-environment': 'sandbox',
      'x-callback-url': 'https://ecole.test/api/webhooks/mtn-momo',
    });
    expect(JSON.parse(pay?.body ?? '{}')).toMatchObject({
      amount: '35000',
      currency: 'XAF',
      externalId: 'cmpaiement000000000000001',
      payer: { partyIdType: 'MSISDN', partyId: '237677123456' },
    });
    await provider.requestPayment(collect({ paymentId: 'cmpaiement000000000000002' }));
    expect(mtn.tokenRequests).toBe(1);
  });

  it('traduit les statuts et vérifie le montant et la devise', async () => {
    const { reference } = await provider.requestPayment(collect());
    expect(await provider.checkStatus(reference)).toEqual({ status: 'PENDING' });
    mtn.setStatus(reference, 'SUCCESSFUL');
    expect(await provider.checkStatus(reference)).toEqual({ status: 'SUCCESS', amount: 35000 });
    // Recherche par notre identifiant de paiement : la référence est recalculée.
    expect(await provider.checkStatus('cmpaiement000000000000001')).toEqual({
      status: 'SUCCESS',
      amount: 35000,
    });
    mtn.statusOverride = { currency: 'EUR' };
    await expect(provider.checkStatus(reference)).rejects.toThrow(/devise/);
    mtn.statusOverride = null;
    mtn.setStatus(reference, 'FAILED');
    expect(await provider.checkStatus(reference)).toEqual({ status: 'FAILED' });
    expect(await provider.checkStatus(randomUUID())).toEqual({ status: 'PENDING' });
  });

  it('distingue refus certain, issue inconnue et demande rejouée', async () => {
    mtn.nextRequestToPay = 400;
    await expect(provider.requestPayment(collect())).rejects.toBeInstanceOf(OperatorRejectedError);
    mtn.nextRequestToPay = 500;
    const pending = await provider.requestPayment(collect()).catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(OperatorPendingError);
    expect((pending as OperatorPendingError).reference).toBe(
      MtnMomoProvider.referenceFor('cmpaiement000000000000001'),
    );
    mtn.nextRequestToPay = 'timeout-after-receipt';
    await expect(provider.requestPayment(collect())).rejects.toBeInstanceOf(OperatorPendingError);
    // La même référence renvoyée une seconde fois : MTN répond 409, la demande reste suivie.
    expect(await provider.requestPayment(collect())).toEqual({
      reference: MtnMomoProvider.referenceFor('cmpaiement000000000000001'),
    });
  });

  it('refuse sans rien envoyer si les identifiants sont faux', async () => {
    const bad = new MtnMomoProvider({ ...mtnTestConfig(mtn.baseUrl), apiKey: 'faux' }, mtn.fetch);
    await expect(bad.requestPayment(collect())).rejects.toBeInstanceOf(OperatorRejectedError);
    expect(mtn.requests.size).toBe(0);
  });
});

describe('adaptateur Orange Money Cameroun (paiement marchand)', () => {
  let orange: FakeOrange;
  let provider: OrangeMoneyProvider;
  beforeEach(() => {
    orange = new FakeOrange();
    provider = new OrangeMoneyProvider(orangeTestConfig(orange.baseUrl), orange.fetch);
  });

  const order = (over = {}) =>
    collect({ method: 'ORANGE_MONEY', phone: '+237699887766', ...over });

  it('initialise puis présente le paiement au payeur', async () => {
    const { reference } = await provider.requestPayment(order());
    expect(reference).toBe('MP000001');
    const [token, init, pay] = orange.calls;
    expect(token).toMatchObject({ url: 'https://orange.test/token', body: 'grant_type=client_credentials' });
    expect(token?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init?.url).toBe('https://orange.test/omcoreapis/1.0.2/mp/init');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer jeton-orange', 'x-auth-token': 'x-auth' });
    expect(JSON.parse(pay?.body ?? '{}')).toMatchObject({
      payToken: 'MP000001',
      amount: '35000',
      subscriberMsisdn: '699887766',
      channelUserMsisdn: '691000000',
      orderId: 'cmpaiement000000000000001',
      notifUrl: 'https://ecole.test/api/webhooks/orange-money',
    });
  });

  it('traduit les statuts d’Orange et exige le montant', async () => {
    const { reference } = await provider.requestPayment(order());
    expect(await provider.checkStatus(reference)).toEqual({ status: 'PENDING' });
    orange.setStatus(reference, 'SUCCESSFULL');
    expect(await provider.checkStatus(reference)).toEqual({ status: 'SUCCESS', amount: 35000 });
    for (const s of ['CANCELLED', 'EXPIRED', 'FAILED']) {
      orange.setStatus(reference, s);
      expect(await provider.checkStatus(reference)).toEqual({ status: 'FAILED' });
    }
    orange.payments.set('MP999999', { status: 'SUCCESSFULL' });
    await expect(provider.checkStatus('MP999999')).rejects.toThrow(/sans montant/);
    expect(await provider.checkStatus('inconnu')).toEqual({ status: 'PENDING' });
  });

  it('distingue refus certain et issue inconnue', async () => {
    orange.nextPay = 400;
    await expect(provider.requestPayment(order())).rejects.toBeInstanceOf(OperatorRejectedError);
    orange.nextPay = 'timeout';
    const pending = await provider.requestPayment(order()).catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(OperatorPendingError);
    expect((pending as OperatorPendingError).reference).toBe('MP000002');
    orange.nextPay = 503;
    await expect(provider.requestPayment(order())).rejects.toBeInstanceOf(OperatorPendingError);
    const noPin = new OrangeMoneyProvider(
      { ...orangeTestConfig(orange.baseUrl), clientSecret: 'faux' },
      orange.fetch,
    );
    await expect(noPin.requestPayment(order())).rejects.toBeInstanceOf(OperatorRejectedError);
  });
});

describe('circuit complet avec les opérateurs', () => {
  let app: INestApplication;
  let mtn: FakeMtn;
  let orange: FakeOrange;
  let s: Awaited<ReturnType<typeof sessions>>;
  let student: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    mtn = new FakeMtn();
    orange = new FakeOrange();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MOBILE_MONEY_PROVIDER)
      .useValue(
        new OperatorsMobileMoneyProvider({
          MTN_MOMO: new MtnMomoProvider(mtnTestConfig(mtn.baseUrl), mtn.fetch),
          ORANGE_MONEY: new OrangeMoneyProvider(orangeTestConfig(orange.baseUrl), orange.fetch),
        }),
      )
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    RateLimiter.reset();
    mtn.requests.clear();
    orange.payments.clear();
    const f = await seedSchool();
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

  const pay = (method: 'MTN_MOMO' | 'ORANGE_MONEY', amount = 35000, phone = '677123456') =>
    http()
      .post('/finance/payments')
      .set(s.compta.auth)
      .send({ studentId: student, amount, method, payerPhone: phone, idempotencyKey: randomUUID() })
      .expect(201);

  it('MTN : un rappel non signé ne crédite rien sans confirmation de l’opérateur', async () => {
    const created = await pay('MTN_MOMO');
    const reference = MtnMomoProvider.referenceFor(created.body.id);
    expect(created.body).toMatchObject({ status: 'PENDING', operatorReference: reference });
    // Rappel forgé : il annonce un succès, mais MTN répond toujours PENDING.
    await http()
      .put('/webhooks/mtn-momo')
      .send({ externalId: created.body.id, status: 'SUCCESSFUL', amount: '35000' })
      .expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(
      'PENDING',
    );
    mtn.setStatus(reference, 'SUCCESSFUL');
    await http()
      .post('/webhooks/mtn-momo')
      .send({ externalId: created.body.id, status: 'SUCCESSFUL', financialTransactionId: '42' })
      .expect(200);
    const row = await prisma.payment.findUniqueOrThrow({
      where: { id: created.body.id },
      include: { receipt: true },
    });
    expect(row.status).toBe('SUCCESS');
    expect(row.receipt?.number).toMatch(/^R-\d{4}-000001$/);
    // Rappel rejoué : le paiement est clos, l'opérateur n'est plus interrogé.
    const calls = mtn.calls.length;
    await http().put('/webhooks/mtn-momo').send({ externalId: created.body.id }).expect(200);
    expect(mtn.calls.length).toBe(calls);
    expect(await prisma.ledgerEntry.count({ where: { paymentId: created.body.id } })).toBe(1);
  });

  it('MTN : un échec confirmé par l’opérateur est enregistré sans écriture', async () => {
    const created = await pay('MTN_MOMO');
    mtn.setStatus(MtnMomoProvider.referenceFor(created.body.id), 'FAILED');
    await http().put('/webhooks/mtn-momo').send({ externalId: created.body.id }).expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(
      'FAILED',
    );
    expect(await prisma.ledgerEntry.count({ where: { paymentId: created.body.id } })).toBe(0);
  });

  it('MTN : une demande sans réponse est retrouvée par la réconciliation', async () => {
    mtn.nextRequestToPay = 'timeout-after-receipt';
    const created = await pay('MTN_MOMO', 20000);
    expect(created.body).toMatchObject({ status: 'PENDING', unconfirmed: true });
    const reference = MtnMomoProvider.referenceFor(created.body.id);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: created.body.id } })).operatorReference,
    ).toBe(reference);
    await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = now() - interval '20 minutes' WHERE "id" = ${created.body.id}`;
    mtn.setStatus(reference, 'SUCCESSFUL');
    expect(await app.get(FinanceService).reconcilePending()).toMatchObject({ settled: 1 });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(
      'SUCCESS',
    );
  });

  it('Orange : la notification déclenche une vérification avant l’encaissement', async () => {
    const created = await pay('ORANGE_MONEY', 35000, '699887766');
    const payToken = created.body.operatorReference as string;
    expect(created.body.status).toBe('PENDING');
    expect(orange.payments.get(payToken)).toMatchObject({ amount: '35000', status: 'PENDING' });
    await http()
      .post('/webhooks/orange-money')
      .send({ payToken, status: 'SUCCESSFULL' })
      .expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(
      'PENDING',
    );
    orange.setStatus(payToken, 'SUCCESSFULL');
    await http()
      .post('/webhooks/orange-money')
      .send({ data: { payToken, status: 'SUCCESSFULL' } })
      .expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(
      'SUCCESS',
    );
    // Notification pour un jeton inconnu : aucun effet, aucune information renvoyée.
    const unknown = await http()
      .post('/webhooks/orange-money')
      .send({ payToken: 'MP424242', status: 'SUCCESSFULL' })
      .expect(200);
    expect(unknown.body).toEqual({ received: true });
  });

  it('Orange : un montant confirmé différent n’est pas encaissé et est signalé', async () => {
    const created = await pay('ORANGE_MONEY', 35000, '699887766');
    const payToken = created.body.operatorReference as string;
    orange.setStatus(payToken, 'SUCCESSFULL');
    const p = orange.payments.get(payToken);
    if (p) p.amount = '3500';
    await http().post('/webhooks/orange-money').send({ payToken }).expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: created.body.id } })).status).toBe(
      'PENDING',
    );
    expect(
      await prisma.auditLog.count({ where: { action: 'finance.mobile_money_amount_mismatch' } }),
    ).toBe(1);
  });

  it('Orange : un refus de l’opérateur est signalé au caissier', async () => {
    orange.nextPay = 400;
    const res = await http()
      .post('/finance/payments')
      .set(s.compta.auth)
      .send({
        studentId: student,
        amount: 35000,
        method: 'ORANGE_MONEY',
        payerPhone: '699887766',
        idempotencyKey: randomUUID(),
      })
      .expect(502);
    expect(res.body.message).toMatch(/a refusé la demande/);
    expect((await prisma.payment.findFirstOrThrow()).status).toBe('FAILED');
  });
});
