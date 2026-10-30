import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../../config/env';
import { HttpMobileMoneyProvider } from './mobile-money.provider';

describe('passerelle Mobile Money HTTP : vérification du statut', () => {
  beforeEach(() => {
    process.env.MOBILE_MONEY_HTTP_URL = 'https://passerelle.test';
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MOBILE_MONEY_HTTP_URL;
    resetEnvCache();
  });

  const reply = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

  it('traduit un succès accompagné du montant encaissé', async () => {
    reply({ status: 'SUCCESS', amount: 35000 });
    expect(await new HttpMobileMoneyProvider().checkStatus('ref-1')).toEqual({
      status: 'SUCCESS',
      amount: 35000,
    });
  });

  it('ne tient pas pour encaissé un succès sans montant (vérification impossible)', async () => {
    reply({ status: 'SUCCESS' });
    expect((await new HttpMobileMoneyProvider().checkStatus('ref-1')).status).toBe('PENDING');
    reply({ status: 'SUCCESS', amount: '35000' });
    expect((await new HttpMobileMoneyProvider().checkStatus('ref-1')).status).toBe('PENDING');
  });

  it('transmet un échec même sans montant', async () => {
    reply({ status: 'FAILED' });
    expect((await new HttpMobileMoneyProvider().checkStatus('ref-1')).status).toBe('FAILED');
  });
});
