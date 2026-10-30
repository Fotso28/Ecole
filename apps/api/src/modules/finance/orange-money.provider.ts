import { Logger } from '@nestjs/common';
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

export interface OrangeMoneyConfig {
  /** https://api-s1.orange.cm (pré-production) ou l'URL de production remise par Orange. */
  baseUrl: string;
  /** Préfixe des services, par exemple /omcoreapis/1.0.2. */
  apiPath: string;
  /** Identifiants OAuth de l'application (client credentials). */
  clientId: string;
  clientSecret: string;
  /** Jeton marchand fourni par Orange (en-tête X-AUTH-TOKEN). */
  authToken: string;
  /** Compte marchand (channel user) et son code secret. */
  channelMsisdn: string;
  pin: string;
  /** Adresse de notification appelée par Orange à la fin du paiement. */
  callbackUrl?: string;
}

export function orangeConfigFromEnv(): OrangeMoneyConfig | null {
  const e = env();
  if (
    !e.ORANGE_MONEY_CLIENT_ID ||
    !e.ORANGE_MONEY_CLIENT_SECRET ||
    !e.ORANGE_MONEY_AUTH_TOKEN ||
    !e.ORANGE_MONEY_CHANNEL_MSISDN ||
    !e.ORANGE_MONEY_CHANNEL_PIN
  )
    return null;
  return {
    baseUrl: e.ORANGE_MONEY_BASE_URL.replace(/\/+$/, ''),
    apiPath: e.ORANGE_MONEY_API_PATH.replace(/\/+$/, ''),
    clientId: e.ORANGE_MONEY_CLIENT_ID,
    clientSecret: e.ORANGE_MONEY_CLIENT_SECRET,
    authToken: e.ORANGE_MONEY_AUTH_TOKEN,
    channelMsisdn: e.ORANGE_MONEY_CHANNEL_MSISDN,
    pin: e.ORANGE_MONEY_CHANNEL_PIN,
    callbackUrl: e.ORANGE_MONEY_CALLBACK_URL,
  };
}

const TIMEOUT_MS = 15_000;

/** Numéro national à 9 chiffres attendu par Orange (« 699887766 »). */
function localMsisdn(phone: string): string {
  return phone.replace(/^\+?237/, '');
}

/**
 * Orange Money Cameroun, API de paiement marchand (« merchant payment ») :
 * - jeton : POST /token (Basic client : secret, grant_type=client_credentials) ;
 * - initialisation : POST {apiPath}/mp/init → payToken ;
 * - paiement : POST {apiPath}/mp/pay (le payeur valide sur son téléphone), réponse PENDING ;
 * - statut : GET {apiPath}/mp/paymentstatus/{payToken} → PENDING, SUCCESSFULL, FAILED,
 *   CANCELLED ou EXPIRED.
 *
 * La notification envoyée par Orange (notifUrl) n'est pas signée : elle ne sert qu'à déclencher
 * une vérification du statut auprès d'Orange.
 */
export class OrangeMoneyProvider implements MobileMoneyProvider {
  private readonly logger = new Logger('OrangeMoney');
  private readonly tokens: TokenCache;

  constructor(
    private readonly config: OrangeMoneyConfig,
    private readonly http: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.tokens = new TokenCache(() => this.fetchToken());
  }

  private async fetchToken(): Promise<{ value: string; expiresIn: number }> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64',
    );
    const res = await this.http(`${this.config.baseUrl}/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`jeton refusé (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('jeton absent de la réponse');
    return { value: body.access_token, expiresIn: body.expires_in ?? 3600 };
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.tokens.get()}`,
      'X-AUTH-TOKEN': this.config.authToken,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${this.config.apiPath}${path}`;
  }

  async requestPayment(req: CollectRequest): Promise<{ reference: string }> {
    let headers: Record<string, string>;
    let payToken: string;
    try {
      headers = await this.headers();
      const init = await this.http(this.url('/mp/init'), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!init.ok) throw new Error(`initialisation refusée (HTTP ${init.status})`);
      const body = (await init.json()) as { data?: { payToken?: string } };
      if (!body.data?.payToken) throw new Error('payToken absent de la réponse');
      payToken = body.data.payToken;
    } catch (e) {
      // Aucune demande de paiement n'a été présentée au payeur : aucun débit possible.
      this.logger.error(`Orange Money : ${e instanceof Error ? e.message : e}`);
      throw new OperatorRejectedError('Service Orange Money momentanément indisponible');
    }
    let res: Response;
    try {
      res = await this.http(this.url('/mp/pay'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          notifUrl: this.config.callbackUrl ?? '',
          channelUserMsisdn: this.config.channelMsisdn,
          amount: String(req.amount),
          subscriberMsisdn: localMsisdn(req.phone),
          pin: this.config.pin,
          orderId: req.paymentId,
          description: req.description.slice(0, 120),
          payToken,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new OperatorPendingError(
        `Orange Money sans réponse : ${e instanceof Error ? e.message : e}`,
        payToken,
      );
    }
    if (res.status === 401) this.tokens.clear();
    if (res.status >= 400 && res.status < 500)
      throw new OperatorRejectedError(`Orange Money : paiement refusé (HTTP ${res.status})`);
    if (!res.ok) throw new OperatorPendingError(`Orange Money : HTTP ${res.status}`, payToken);
    const body = (await res.json().catch(() => ({}))) as { data?: { status?: string } };
    if (body.data?.status === 'FAILED')
      throw new OperatorRejectedError('Orange Money : paiement refusé');
    return { reference: payToken };
  }

  async checkStatus(reference: string): Promise<StatusResult> {
    const res = await this.http(this.url(`/mp/paymentstatus/${encodeURIComponent(reference)}`), {
      headers: await this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Sans payToken (réponse d'initialisation perdue), Orange ne retrouve pas la demande :
    // le paiement reste en attente puis expire après 24 h.
    if (res.status === 404) return { status: 'PENDING' };
    if (res.status === 401) this.tokens.clear();
    if (!res.ok) throw new Error(`Orange Money : statut indisponible (HTTP ${res.status})`);
    const body = (await res.json()) as { data?: { status?: string; amount?: unknown } };
    const status = body.data?.status?.toUpperCase();
    if (status === 'SUCCESSFULL' || status === 'SUCCESSFUL' || status === 'SUCCESS') {
      const amount = parseOperatorAmount(body.data?.amount);
      if (amount === undefined)
        throw new Error('Orange Money : succès sans montant, vérification manuelle');
      return { status: 'SUCCESS', amount };
    }
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED')
      return { status: 'FAILED' };
    return { status: 'PENDING' };
  }
}
