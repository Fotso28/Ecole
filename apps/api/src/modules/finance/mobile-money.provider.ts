import { createHmac } from 'node:crypto';
import type { PaymentMethod } from '@prisma/client';
import { env } from '../../config/env';
import { randomToken } from '../../common/crypto';

export type OperatorStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface CollectRequest {
  paymentId: string;
  amount: number;
  /** Numéro E.164 du payeur. */
  phone: string;
  method: PaymentMethod;
  description: string;
}

/**
 * Passerelle Mobile Money (MTN MoMo, Orange Money). L'école reçoit le résultat par
 * webhook signé ; `checkStatus` sert à la réconciliation des paiements restés en attente.
 */
export interface MobileMoneyProvider {
  requestPayment(req: CollectRequest): Promise<{ reference: string }>;
  checkStatus(reference: string, method: PaymentMethod): Promise<OperatorStatus>;
}

export const MOBILE_MONEY_PROVIDER = Symbol('MOBILE_MONEY_PROVIDER');

/** Simulateur pour le développement et les tests. */
export class SimulatorMobileMoneyProvider implements MobileMoneyProvider {
  static readonly statuses = new Map<string, OperatorStatus>();
  static readonly requests: CollectRequest[] = [];
  static failNextRequest = false;

  async requestPayment(req: CollectRequest): Promise<{ reference: string }> {
    if (SimulatorMobileMoneyProvider.failNextRequest) {
      SimulatorMobileMoneyProvider.failNextRequest = false;
      throw new Error('Opérateur indisponible');
    }
    const reference = `SIM-${randomToken(9)}`;
    SimulatorMobileMoneyProvider.statuses.set(reference, 'PENDING');
    SimulatorMobileMoneyProvider.requests.push(req);
    return { reference };
  }

  async checkStatus(reference: string): Promise<OperatorStatus> {
    return SimulatorMobileMoneyProvider.statuses.get(reference) ?? 'PENDING';
  }
}

/**
 * Agrégateur HTTP générique : POST {url}/collect et GET {url}/status/{reference}.
 * Les intégrations directes MTN MoMo et Orange Money se branchent derrière cette interface.
 */
export class HttpMobileMoneyProvider implements MobileMoneyProvider {
  private headers() {
    const token = env().MOBILE_MONEY_HTTP_TOKEN;
    return {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  async requestPayment(req: CollectRequest): Promise<{ reference: string }> {
    const url = env().MOBILE_MONEY_HTTP_URL;
    if (!url) throw new Error('MOBILE_MONEY_HTTP_URL manquant');
    const res = await fetch(`${url}/collect`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        externalId: req.paymentId,
        amount: req.amount,
        currency: 'XAF',
        phone: req.phone,
        operator: req.method,
        description: req.description,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Passerelle Mobile Money : HTTP ${res.status}`);
    const body = (await res.json()) as { reference?: string };
    if (!body.reference) throw new Error('Référence opérateur absente');
    return { reference: body.reference };
  }

  async checkStatus(reference: string): Promise<OperatorStatus> {
    const url = env().MOBILE_MONEY_HTTP_URL;
    if (!url) throw new Error('MOBILE_MONEY_HTTP_URL manquant');
    const res = await fetch(`${url}/status/${encodeURIComponent(reference)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Passerelle Mobile Money : HTTP ${res.status}`);
    const body = (await res.json()) as { status?: string };
    return body.status === 'SUCCESS' || body.status === 'FAILED' ? body.status : 'PENDING';
  }
}

export function createMobileMoneyProvider(): MobileMoneyProvider {
  return env().MOBILE_MONEY_PROVIDER === 'http'
    ? new HttpMobileMoneyProvider()
    : new SimulatorMobileMoneyProvider();
}

/** Signature attendue d'un webhook : HMAC-SHA256 hexadécimal du corps brut. */
export function signWebhook(
  rawBody: string | Buffer,
  secret = env().MOBILE_MONEY_WEBHOOK_SECRET,
): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
