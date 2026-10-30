import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../../config/env';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger('E-mail');
  async send({ to, subject, text }: EmailMessage): Promise<void> {
    this.logger.log(`→ ${to} : [${subject}] ${text}`);
  }
}

/** Fournisseur de test : garde les e-mails en mémoire. */
export class MemoryEmailProvider implements EmailProvider {
  static readonly sent: EmailMessage[] = [];
  static failNext = 0;
  async send(message: EmailMessage): Promise<void> {
    if (MemoryEmailProvider.failNext > 0) {
      MemoryEmailProvider.failNext--;
      throw new Error('Échec simulé du serveur SMTP');
    }
    MemoryEmailProvider.sent.push(message);
  }
  static lastTo(to: string): EmailMessage | undefined {
    return [...MemoryEmailProvider.sent].reverse().find((m) => m.to === to);
  }
  static countTo(to: string): number {
    return MemoryEmailProvider.sent.filter((m) => m.to === to).length;
  }
}

/** Serveur SMTP (fournisseur transactionnel ou messagerie de l'établissement). */
export class SmtpEmailProvider implements EmailProvider {
  private transporter?: Transporter;

  private transport(): Transporter {
    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD } = env();
    if (!SMTP_HOST) throw new Error('SMTP_HOST manquant');
    this.transporter ??= createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return this.transporter;
  }

  async send({ to, subject, text }: EmailMessage): Promise<void> {
    await this.transport().sendMail({ from: env().EMAIL_FROM, to, subject, text });
  }
}

/** Passerelle e-mail HTTP générique (Brevo, Mailjet… via un relais) : POST JSON { to, from, subject, text }. */
export class HttpEmailProvider implements EmailProvider {
  async send({ to, subject, text }: EmailMessage): Promise<void> {
    const { EMAIL_HTTP_URL, EMAIL_HTTP_TOKEN, EMAIL_FROM } = env();
    if (!EMAIL_HTTP_URL) throw new Error('Canal e-mail non configuré');
    const res = await fetch(EMAIL_HTTP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(EMAIL_HTTP_TOKEN ? { authorization: `Bearer ${EMAIL_HTTP_TOKEN}` } : {}),
      },
      body: JSON.stringify({ to, from: EMAIL_FROM, subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Passerelle e-mail : HTTP ${res.status}`);
  }
}

export function createEmailProvider(): EmailProvider {
  switch (env().EMAIL_PROVIDER) {
    case 'memory':
      return new MemoryEmailProvider();
    case 'smtp':
      return new SmtpEmailProvider();
    case 'http':
      return new HttpEmailProvider();
    default:
      return new ConsoleEmailProvider();
  }
}
