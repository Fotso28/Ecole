import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationOutbox, Prisma } from '@prisma/client';
import { pickChannel, type Contact, type ContactChannel } from '@ecole/shared';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { EMAIL_PROVIDER, EmailProvider } from './email.provider';
import { SMS_PROVIDER, SmsProvider } from './sms.provider';

export interface NotificationInput {
  schoolId?: string | null;
  channel?: NotificationChannel;
  recipient: string;
  template: string;
  body: string;
  /** Objet de l'e-mail (canal EMAIL), conservé dans `payload.subject`. */
  subject?: string;
  payload?: Record<string, unknown>;
  /** Envoi différé (regroupement, rappel). */
  availableAt?: Date;
  /**
   * Message confidentiel (code de connexion) : son corps est effacé dès qu'il est envoyé,
   * abandonné ou expiré, pour ne pas rester lisible en base.
   */
  sensitive?: boolean;
  /** Au-delà, le message n'est plus envoyé (code expiré). */
  expiresAt?: Date;
}

/** Notification adressée à une personne : le canal dépend de ses coordonnées et de l'école. */
export interface ContactNotificationInput extends Omit<NotificationInput, 'recipient' | 'channel'> {
  schoolId: string;
  contact: Contact;
  /** Texte plus complet pour l'e-mail (sinon `body`). */
  emailBody?: string;
}

/**
 * Condition vérifiée juste avant l'envoi : si elle renvoie faux, la notification est annulée
 * (ex. message déjà lu entre-temps).
 */
export type NotificationGuard = (n: NotificationOutbox) => Promise<boolean>;

export const MAX_ATTEMPTS = 5;

/** Corps conservé à la place d'un message confidentiel une fois traité. */
export const MASKED_BODY = '[contenu confidentiel effacé]';

/**
 * Notifications fiables (pattern outbox) : l'écriture en base se fait dans la même
 * transaction que l'action métier ; l'envoi est fait ensuite par le worker, avec
 * nouvelles tentatives espacées.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');
  private readonly guards = new Map<string, NotificationGuard>();

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  registerGuard(template: string, guard: NotificationGuard): void {
    this.guards.set(template, guard);
  }

  async enqueue(input: NotificationInput, tx?: Tx): Promise<NotificationOutbox> {
    const payload = {
      ...(input.payload ?? {}),
      ...(input.subject ? { subject: input.subject } : {}),
    };
    return (tx ?? this.db).notificationOutbox.create({
      data: {
        schoolId: input.schoolId ?? null,
        channel: input.channel ?? 'SMS',
        recipient: input.recipient,
        template: input.template,
        body: input.body,
        payload: payload as Prisma.InputJsonValue,
        ...(input.availableAt ? { availableAt: input.availableAt } : {}),
        ...(input.sensitive ? { sensitive: true } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      },
    });
  }

  /** Messages confidentiels expirés avant l'envoi : abandonnés et effacés. */
  private async purgeExpired(): Promise<void> {
    await this.db.notificationOutbox.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      data: { status: 'CANCELLED', lastError: 'Expiré avant l’envoi' },
    });
    await this.db.notificationOutbox.updateMany({
      where: { sensitive: true, status: { not: 'PENDING' }, body: { not: MASKED_BODY } },
      data: { body: MASKED_BODY },
    });
  }

  /** Canal préféré de l'école (réglage `preferredChannel`), SMS par défaut. */
  async preferredChannel(schoolId: string, tx?: Tx): Promise<ContactChannel> {
    const school = await (tx ?? this.db).school.findUnique({
      where: { id: schoolId },
      select: { settings: true },
    });
    const value = (school?.settings as { preferredChannel?: string } | undefined)?.preferredChannel;
    return value === 'EMAIL' ? 'EMAIL' : 'SMS';
  }

  /**
   * Met en file une notification pour une personne, par SMS ou par e-mail selon ses coordonnées
   * et la préférence de l'école. Renvoie `null` si elle n'est pas joignable.
   */
  async notifyContact(
    input: ContactNotificationInput,
    tx?: Tx,
    preferred?: ContactChannel,
  ): Promise<NotificationOutbox | null> {
    const { contact, emailBody, ...rest } = input;
    const channel = pickChannel(
      contact,
      preferred ?? (await this.preferredChannel(input.schoolId, tx)),
    );
    if (!channel) return null;
    const recipient = (channel === 'SMS' ? contact.phone : contact.email)!.trim();
    const body = channel === 'EMAIL' && emailBody ? emailBody : rest.body;
    return this.enqueue({ ...rest, body, channel, recipient }, tx);
  }

  /** Réserve puis envoie un lot de notifications en attente. Renvoie le nombre traité. */
  async dispatchPending(limit = 50, onlyId?: string): Promise<number> {
    await this.purgeExpired();
    const leased = await this.db.$queryRaw<NotificationOutbox[]>`
      UPDATE "NotificationOutbox" SET "attempts" = "attempts" + 1, "availableAt" = now() + interval '2 minutes'
      WHERE "id" IN (
        SELECT "id" FROM "NotificationOutbox"
        WHERE "status" = 'PENDING' AND "availableAt" <= now()
          AND (${onlyId ?? null}::text IS NULL OR "id" = ${onlyId ?? null})
        ORDER BY "createdAt" LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
    for (const n of leased) {
      try {
        const guard = this.guards.get(n.template);
        if (guard && !(await guard(n))) {
          await this.db.notificationOutbox.update({
            where: { id: n.id },
            data: { status: 'CANCELLED', lastError: null, ...this.mask(n) },
          });
          continue;
        }
        await this.send(n);
        await this.db.notificationOutbox.update({
          where: { id: n.id },
          data: { status: 'SENT', sentAt: new Date(), lastError: null, ...this.mask(n) },
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const final = n.attempts >= MAX_ATTEMPTS;
        await this.db.notificationOutbox.update({
          where: { id: n.id },
          data: {
            status: final ? 'FAILED' : 'PENDING',
            lastError: message.slice(0, 500),
            availableAt: new Date(Date.now() + 2 ** n.attempts * 60_000),
            ...(final ? this.mask(n) : {}),
          },
        });
        if (final)
          this.logger.error(
            `Notification ${n.id} abandonnée après ${n.attempts} tentatives : ${message}`,
          );
      }
    }
    return leased.length;
  }

  private mask(n: NotificationOutbox): { body?: string } {
    return n.sensitive ? { body: MASKED_BODY } : {};
  }

  /** Envoi immédiat (ex. code de connexion) ; le worker reprend en cas d'échec. */
  async dispatchNow(id: string): Promise<void> {
    try {
      await this.dispatchPending(1, id);
    } catch (e) {
      this.logger.warn(`Envoi immédiat impossible : ${e instanceof Error ? e.message : e}`);
    }
  }

  private async send(n: NotificationOutbox): Promise<void> {
    switch (n.channel) {
      case 'SMS':
        return this.sms.send(n.recipient, n.body);
      case 'WHATSAPP':
        // Canal soumis à l'approbation Meta : repli sur SMS tant qu'il n'est pas configuré.
        return this.sms.send(n.recipient, n.body);
      case 'EMAIL': {
        const subject = (n.payload as { subject?: unknown } | null)?.subject;
        return this.email.send({
          to: n.recipient,
          subject: typeof subject === 'string' ? subject : 'Ecole',
          text: n.body,
        });
      }
    }
  }
}
