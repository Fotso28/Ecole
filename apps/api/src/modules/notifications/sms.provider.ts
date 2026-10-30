import { Logger } from '@nestjs/common';
import { env } from '../../config/env';

export interface SmsProvider {
  send(to: string, body: string): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger('SMS');
  async send(to: string, body: string): Promise<void> {
    this.logger.log(`→ ${to} : ${body}`);
  }
}

/** Fournisseur de test : garde les messages en mémoire. */
export class MemorySmsProvider implements SmsProvider {
  static readonly sent: { to: string; body: string }[] = [];
  static failNext = 0;
  async send(to: string, body: string): Promise<void> {
    if (MemorySmsProvider.failNext > 0) {
      MemorySmsProvider.failNext--;
      throw new Error('Échec simulé du fournisseur SMS');
    }
    MemorySmsProvider.sent.push({ to, body });
  }
  static lastTo(to: string): string | undefined {
    return [...MemorySmsProvider.sent].reverse().find((m) => m.to === to)?.body;
  }

  static countTo(to: string): number {
    return MemorySmsProvider.sent.filter((m) => m.to === to).length;
  }

  /** Attend un SMS au-delà des `after` déjà reçus par ce numéro (envoi asynchrone). */
  static async waitFor(to: string, after = 0, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (MemorySmsProvider.countTo(to) <= after) {
      if (Date.now() > deadline) throw new Error(`Aucun SMS reçu par ${to}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return MemorySmsProvider.lastTo(to) ?? '';
  }
}

/** Passerelle SMS HTTP générique (agrégateur local) : POST JSON { to, from, text }. */
export class HttpSmsProvider implements SmsProvider {
  async send(to: string, body: string): Promise<void> {
    const { SMS_HTTP_URL, SMS_HTTP_TOKEN, SMS_SENDER } = env();
    if (!SMS_HTTP_URL) throw new Error('SMS_HTTP_URL manquant');
    const res = await fetch(SMS_HTTP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(SMS_HTTP_TOKEN ? { authorization: `Bearer ${SMS_HTTP_TOKEN}` } : {}),
      },
      body: JSON.stringify({ to, from: SMS_SENDER, text: body }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Passerelle SMS : HTTP ${res.status}`);
  }
}

export function createSmsProvider(): SmsProvider {
  switch (env().SMS_PROVIDER) {
    case 'memory':
      return new MemorySmsProvider();
    case 'http':
      return new HttpSmsProvider();
    default:
      return new ConsoleSmsProvider();
  }
}
