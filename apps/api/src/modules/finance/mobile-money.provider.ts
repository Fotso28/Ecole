import { createHmac } from 'node:crypto';
import type { PaymentMethod } from '@prisma/client';
import { env } from '../../config/env';
import { randomToken } from '../../common/crypto';

export type OperatorStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface StatusResult {
  status: OperatorStatus;
  /** Montant confirmé par l'opérateur, quand il le fournit. */
  amount?: number;
}

/** Refus explicite de l'opérateur : la demande n'a pas été prise en compte, rien n'est débité. */
export class OperatorRejectedError extends Error {}

/**
 * Issue inconnue (délai dépassé, erreur 5xx) après l'envoi de la demande : le payeur a peut-être
 * été débité. `reference` permet à la réconciliation d'interroger l'opérateur.
 */
export class OperatorPendingError extends Error {
  constructor(
    message: string,
    readonly reference?: string,
  ) {
    super(message);
  }
}

/** Jeton OAuth mis en cache jusqu'à une minute avant son expiration. */
export class TokenCache {
  private token?: { value: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(private readonly fetchToken: () => Promise<{ value: string; expiresIn: number }>) {}

  get(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000)
      return Promise.resolve(this.token.value);
    this.pending ??= this.fetchToken()
      .then(({ value, expiresIn }) => {
        this.token = { value, expiresAt: Date.now() + expiresIn * 1000 };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  clear(): void {
    this.token = undefined;
  }
}

/** Montant entier en FCFA lu dans une réponse d'opérateur (« 35000 », 35000 ou « 35000.00 »). */
export function parseOperatorAmount(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

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
 * `requestPayment` lève `OperatorRejectedError` pour un refus certain ; toute autre erreur
 * (délai dépassé, réseau) laisse l'issue inconnue.
 */
export interface MobileMoneyProvider {
  requestPayment(req: CollectRequest): Promise<{ reference: string }>;
  /** `reference` : référence de l'opérateur, ou à défaut notre identifiant de paiement (externalId). */
  checkStatus(reference: string, method: PaymentMethod): Promise<StatusResult>;
}

export const MOBILE_MONEY_PROVIDER = Symbol('MOBILE_MONEY_PROVIDER');

/** Simulateur pour le développement et les tests. */
export class SimulatorMobileMoneyProvider implements MobileMoneyProvider {
  static readonly statuses = new Map<string, OperatorStatus>();
  static readonly requests: CollectRequest[] = [];
  static failNextRequest = false;
  static timeoutNextRequest = false;

  async requestPayment(req: CollectRequest): Promise<{ reference: string }> {
    if (SimulatorMobileMoneyProvider.failNextRequest) {
      SimulatorMobileMoneyProvider.failNextRequest = false;
      throw new OperatorRejectedError('Numéro non abonné au service');
    }
    if (SimulatorMobileMoneyProvider.timeoutNextRequest) {
      // La demande parvient à l'opérateur mais la réponse se perd.
      SimulatorMobileMoneyProvider.timeoutNextRequest = false;
      SimulatorMobileMoneyProvider.statuses.set(req.paymentId, 'PENDING');
      SimulatorMobileMoneyProvider.requests.push(req);
      throw new Error('Délai de réponse dépassé');
    }
    const reference = `SIM-${randomToken(9)}`;
    SimulatorMobileMoneyProvider.statuses.set(reference, 'PENDING');
    SimulatorMobileMoneyProvider.requests.push(req);
    return { reference };
  }

  async checkStatus(reference: string): Promise<StatusResult> {
    return { status: SimulatorMobileMoneyProvider.statuses.get(reference) ?? 'PENDING' };
  }
}

/**
 * Agrégateur HTTP générique : POST {url}/collect et GET {url}/status/{reference}.
 * Les raccordements directs MTN MoMo et Orange Money sont dans `mtn-momo.provider.ts` et
 * `orange-money.provider.ts` (MOBILE_MONEY_PROVIDER=operators).
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
    if (res.status >= 400 && res.status < 500)
      throw new OperatorRejectedError(`Passerelle Mobile Money : HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Passerelle Mobile Money : HTTP ${res.status}`);
    const body = (await res.json()) as { reference?: string };
    if (!body.reference) throw new Error('Référence opérateur absente');
    return { reference: body.reference };
  }

  async checkStatus(reference: string): Promise<StatusResult> {
    const url = env().MOBILE_MONEY_HTTP_URL;
    if (!url) throw new Error('MOBILE_MONEY_HTTP_URL manquant');
    const res = await fetch(`${url}/status/${encodeURIComponent(reference)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Passerelle Mobile Money : HTTP ${res.status}`);
    const body = (await res.json()) as { status?: string; amount?: unknown };
    const amount = typeof body.amount === 'number' ? body.amount : undefined;
    // Un succès sans montant ne peut pas être rapproché du paiement demandé : il reste en attente
    // (et expire au bout de 24 h) plutôt que d'être crédité au montant que nous avions demandé.
    if (body.status === 'SUCCESS')
      return amount === undefined ? { status: 'PENDING' } : { status: 'SUCCESS', amount };
    return { status: body.status === 'FAILED' ? 'FAILED' : 'PENDING', amount };
  }
}

/** Aiguillage par opérateur vers les raccordements directs configurés. */
export class OperatorsMobileMoneyProvider implements MobileMoneyProvider {
  constructor(private readonly operators: Partial<Record<PaymentMethod, MobileMoneyProvider>>) {}

  private pick(method: PaymentMethod): MobileMoneyProvider {
    const provider = this.operators[method];
    if (!provider) throw new OperatorRejectedError(`Opérateur ${method} non raccordé`);
    return provider;
  }

  requestPayment(req: CollectRequest): Promise<{ reference: string }> {
    return this.pick(req.method).requestPayment(req);
  }

  checkStatus(reference: string, method: PaymentMethod): Promise<StatusResult> {
    return this.pick(method).checkStatus(reference, method);
  }
}

/** Signature attendue d'un webhook : HMAC-SHA256 hexadécimal du corps brut. */
export function signWebhook(
  rawBody: string | Buffer,
  secret = env().MOBILE_MONEY_WEBHOOK_SECRET,
): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
