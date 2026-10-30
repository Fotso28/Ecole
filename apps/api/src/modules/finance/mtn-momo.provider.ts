import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { env } from '../../config/env';
import {
  type CollectRequest,
  type MobileMoneyProvider,
  OperatorPendingError,
  OperatorRejectedError,
  parseOperatorAmount,
  type StatusResult,
  TokenCache,
} from './mobile-money.provider';

export interface MtnMomoConfig {
  /** https://sandbox.momodeveloper.mtn.com (bac à sable) ou l'URL de production remise par MTN. */
  baseUrl: string;
  /** « sandbox » en bac à sable, « mtncameroon » en production. */
  targetEnvironment: string;
  /** Clé d'abonnement du produit Collection (en-tête Ocp-Apim-Subscription-Key). */
  subscriptionKey: string;
  apiUser: string;
  apiKey: string;
  /** XAF en production ; le bac à sable n'accepte que EUR. */
  currency: string;
  /** Adresse de rappel (X-Callback-Url), sur le domaine déclaré auprès de MTN. */
  callbackUrl?: string;
}

export function mtnConfigFromEnv(): MtnMomoConfig | null {
  const e = env();
  if (!e.MTN_MOMO_SUBSCRIPTION_KEY || !e.MTN_MOMO_API_USER || !e.MTN_MOMO_API_KEY) return null;
  return {
    baseUrl: e.MTN_MOMO_BASE_URL.replace(/\/+$/, ''),
    targetEnvironment: e.MTN_MOMO_TARGET_ENVIRONMENT,
    subscriptionKey: e.MTN_MOMO_SUBSCRIPTION_KEY,
    apiUser: e.MTN_MOMO_API_USER,
    apiKey: e.MTN_MOMO_API_KEY,
    currency: e.MTN_MOMO_CURRENCY,
    callbackUrl: e.MTN_MOMO_CALLBACK_URL,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMEOUT_MS = 15_000;

/**
 * MTN Mobile Money, API Collection (https://momodeveloper.mtn.com) :
 * - jeton : POST /collection/token/ (Basic utilisateur API : clé API) ;
 * - demande de paiement : POST /collection/v1_0/requesttopay, identifiée par X-Reference-Id (UUID v4),
 *   réponse 202 ; une réponse 409 signale une référence déjà reçue ;
 * - statut : GET /collection/v1_0/requesttopay/{X-Reference-Id} → PENDING, SUCCESSFUL ou FAILED.
 *
 * La référence est dérivée de notre identifiant de paiement : après un délai dépassé, la
 * réconciliation retrouve la demande même si la réponse de MTN s'est perdue. Le rappel de MTN
 * (X-Callback-Url) n'est pas signé : il ne sert qu'à déclencher une vérification du statut.
 */
export class MtnMomoProvider implements MobileMoneyProvider {
  private readonly logger = new Logger('MtnMomo');
  private readonly tokens: TokenCache;

  constructor(
    private readonly config: MtnMomoConfig,
    private readonly http: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.tokens = new TokenCache(() => this.fetchToken());
  }

  /** Référence X-Reference-Id déterministe (forme UUID v4) pour un identifiant de paiement. */
  static referenceFor(paymentId: string): string {
    const h = createHash('sha256').update(`ecole:${paymentId}`).digest('hex');
    const variant = ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  private async fetchToken(): Promise<{ value: string; expiresIn: number }> {
    const basic = Buffer.from(`${this.config.apiUser}:${this.config.apiKey}`).toString('base64');
    const res = await this.http(`${this.config.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`MTN MoMo : jeton refusé (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('MTN MoMo : jeton absent de la réponse');
    return { value: body.access_token, expiresIn: body.expires_in ?? 3600 };
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.tokens.get()}`,
      'X-Target-Environment': this.config.targetEnvironment,
      'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
    };
  }

  async requestPayment(req: CollectRequest): Promise<{ reference: string }> {
    const reference = MtnMomoProvider.referenceFor(req.paymentId);
    let headers: Record<string, string>;
    try {
      headers = await this.headers();
    } catch (e) {
      // Rien n'a été envoyé à MTN : aucun débit possible.
      this.logger.error(e instanceof Error ? e.message : String(e));
      throw new OperatorRejectedError('Service MTN MoMo momentanément indisponible');
    }
    let res: Response;
    try {
      res = await this.http(`${this.config.baseUrl}/collection/v1_0/requesttopay`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'X-Reference-Id': reference,
          ...(this.config.callbackUrl ? { 'X-Callback-Url': this.config.callbackUrl } : {}),
        },
        body: JSON.stringify({
          amount: String(req.amount),
          currency: this.config.currency,
          externalId: req.paymentId,
          payer: { partyIdType: 'MSISDN', partyId: req.phone.replace(/^\+/, '') },
          payerMessage: req.description.slice(0, 160),
          payeeNote: req.description.slice(0, 160),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new OperatorPendingError(
        `MTN MoMo sans réponse : ${e instanceof Error ? e.message : e}`,
        reference,
      );
    }
    // 409 : MTN a déjà reçu cette référence (demande rejouée), elle reste suivie normalement.
    if (res.status === 202 || res.status === 200 || res.status === 409) return { reference };
    if (res.status === 401) this.tokens.clear();
    if (res.status >= 400 && res.status < 500)
      throw new OperatorRejectedError(`MTN MoMo : demande refusée (HTTP ${res.status})`);
    throw new OperatorPendingError(`MTN MoMo : HTTP ${res.status}`, reference);
  }

  async checkStatus(reference: string): Promise<StatusResult> {
    const ref = UUID.test(reference) ? reference : MtnMomoProvider.referenceFor(reference);
    const res = await this.http(
      `${this.config.baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(ref)}`,
      { headers: await this.headers(), signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    // Référence inconnue : la demande n'est peut-être jamais arrivée ; elle expirera après 24 h.
    if (res.status === 404) return { status: 'PENDING' };
    if (res.status === 401) this.tokens.clear();
    if (!res.ok) throw new Error(`MTN MoMo : statut indisponible (HTTP ${res.status})`);
    const body = (await res.json()) as { status?: string; amount?: unknown; currency?: string };
    if (body.status === 'SUCCESSFUL') {
      const amount = parseOperatorAmount(body.amount);
      if (amount === undefined || (body.currency && body.currency !== this.config.currency))
        throw new Error('MTN MoMo : succès sans montant ou devise attendus, vérification manuelle');
      return { status: 'SUCCESS', amount };
    }
    if (body.status === 'FAILED' || body.status === 'REJECTED' || body.status === 'TIMEOUT')
      return { status: 'FAILED' };
    return { status: 'PENDING' };
  }
}
