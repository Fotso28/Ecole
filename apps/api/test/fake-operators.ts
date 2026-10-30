/**
 * Faux serveurs MTN MoMo (API Collection) et Orange Money Cameroun (paiement marchand) pour les
 * tests : aucune requête réseau, réponses conformes aux documentations publiques des opérateurs.
 */

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

type Status = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

export class FakeMtn {
  readonly calls: RecordedCall[] = [];
  readonly requests = new Map<
    string,
    { amount: string; currency: string; externalId: string; status: Status; partyId: string }
  >();
  tokenRequests = 0;
  /** Prochaine réponse forcée de requesttopay : code HTTP ou 'timeout'. */
  nextRequestToPay: number | 'timeout-after-receipt' | null = null;
  statusOverride: { status?: string; amount?: string; currency?: string } | null = null;

  constructor(readonly baseUrl = 'https://mtn.test') {}

  setStatus(reference: string, status: Status): void {
    const r = this.requests.get(reference);
    if (r) r.status = status;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = headersOf(init);
    this.calls.push({ method: init?.method ?? 'GET', url, headers, body: init?.body as string });
    const path = url.replace(this.baseUrl, '');
    if (path === '/collection/token/') {
      this.tokenRequests++;
      if (headers.authorization !== `Basic ${Buffer.from('api-user:api-key').toString('base64')}`)
        return json(401, { error: 'login_failed' });
      return json(200, { access_token: `jeton-${this.tokenRequests}`, token_type: 'access_token', expires_in: 3600 });
    }
    if (!headers.authorization?.startsWith('Bearer ')) return json(401, {});
    if (headers['ocp-apim-subscription-key'] !== 'cle-collection') return json(401, {});
    if (path === '/collection/v1_0/requesttopay' && init?.method === 'POST') {
      const ref = headers['x-reference-id'] ?? '';
      const forced = this.nextRequestToPay;
      this.nextRequestToPay = null;
      if (typeof forced === 'number') return json(forced, { code: 'FORCED' });
      if (this.requests.has(ref)) return json(409, { code: 'RESOURCE_ALREADY_EXIST' });
      const body = JSON.parse(String(init.body)) as {
        amount: string;
        currency: string;
        externalId: string;
        payer: { partyId: string };
      };
      this.requests.set(ref, {
        amount: body.amount,
        currency: body.currency,
        externalId: body.externalId,
        partyId: body.payer.partyId,
        status: 'PENDING',
      });
      if (forced === 'timeout-after-receipt') throw new Error('The operation was aborted due to timeout');
      return new Response(null, { status: 202 });
    }
    const m = /^\/collection\/v1_0\/requesttopay\/(.+)$/.exec(path);
    if (m?.[1]) {
      const r = this.requests.get(decodeURIComponent(m[1]));
      if (!r) return json(404, { code: 'RESOURCE_NOT_FOUND' });
      return json(200, {
        amount: r.amount,
        currency: r.currency,
        externalId: r.externalId,
        payer: { partyIdType: 'MSISDN', partyId: r.partyId },
        status: r.status,
        ...(r.status === 'SUCCESSFUL' ? { financialTransactionId: '1234567' } : {}),
        ...this.statusOverride,
      });
    }
    return json(404, {});
  };
}

export class FakeOrange {
  readonly calls: RecordedCall[] = [];
  readonly payments = new Map<
    string,
    { amount?: string; orderId?: string; status: string; subscriber?: string }
  >();
  private seq = 0;
  nextPay: number | 'timeout' | null = null;

  constructor(readonly baseUrl = 'https://orange.test') {}

  setStatus(payToken: string, status: string): void {
    const p = this.payments.get(payToken);
    if (p) p.status = status;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = headersOf(init);
    this.calls.push({ method: init?.method ?? 'GET', url, headers, body: init?.body as string });
    const path = url.replace(this.baseUrl, '');
    if (path === '/token') {
      if (headers.authorization !== `Basic ${Buffer.from('client:secret').toString('base64')}`)
        return json(401, {});
      return json(200, { access_token: 'jeton-orange', token_type: 'Bearer', expires_in: 3600 });
    }
    if (headers.authorization !== 'Bearer jeton-orange' || headers['x-auth-token'] !== 'x-auth')
      return json(401, { message: 'Unauthorized' });
    if (path === '/omcoreapis/1.0.2/mp/init') {
      const payToken = `MP${String(++this.seq).padStart(6, '0')}`;
      this.payments.set(payToken, { status: 'INITIATED' });
      return json(200, { message: 'Payment request successfully initiated', data: { payToken } });
    }
    if (path === '/omcoreapis/1.0.2/mp/pay') {
      const body = JSON.parse(String(init?.body)) as {
        payToken: string;
        amount: string;
        orderId: string;
        subscriberMsisdn: string;
        pin: string;
      };
      const forced = this.nextPay;
      this.nextPay = null;
      if (typeof forced === 'number') return json(forced, { message: 'Erreur forcée' });
      if (body.pin !== '1234') return json(400, { message: 'PIN invalide' });
      const p = this.payments.get(body.payToken);
      if (!p) return json(404, {});
      Object.assign(p, {
        amount: body.amount,
        orderId: body.orderId,
        subscriber: body.subscriberMsisdn,
        status: 'PENDING',
      });
      if (forced === 'timeout') throw new Error('The operation was aborted due to timeout');
      return json(200, { message: 'Paiement en cours', data: { status: 'PENDING', payToken: body.payToken } });
    }
    const m = /^\/omcoreapis\/1\.0\.2\/mp\/paymentstatus\/(.+)$/.exec(path);
    if (m?.[1]) {
      const p = this.payments.get(decodeURIComponent(m[1]));
      if (!p) return json(404, { message: 'Not found' });
      return json(200, {
        message: 'Statut',
        data: { status: p.status, amount: p.amount, payToken: m[1], txnid: 'MP260101.1234.A00001' },
      });
    }
    return json(404, {});
  };
}

export const mtnTestConfig = (baseUrl: string) => ({
  baseUrl,
  targetEnvironment: 'sandbox',
  subscriptionKey: 'cle-collection',
  apiUser: 'api-user',
  apiKey: 'api-key',
  currency: 'XAF',
  callbackUrl: 'https://ecole.test/api/webhooks/mtn-momo',
});

export const orangeTestConfig = (baseUrl: string) => ({
  baseUrl,
  apiPath: '/omcoreapis/1.0.2',
  clientId: 'client',
  clientSecret: 'secret',
  authToken: 'x-auth',
  channelMsisdn: '691000000',
  pin: '1234',
  callbackUrl: 'https://ecole.test/api/webhooks/orange-money',
});
