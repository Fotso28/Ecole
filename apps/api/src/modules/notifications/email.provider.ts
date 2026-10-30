import { env } from '../../config/env';

export interface EmailProvider {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Passerelle e-mail HTTP générique (Brevo, Mailjet… via un relais) : POST JSON { to, from, subject, text }. */
export class HttpEmailProvider implements EmailProvider {
  async send(to: string, subject: string, text: string): Promise<void> {
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
