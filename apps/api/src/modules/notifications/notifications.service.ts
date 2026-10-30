import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationOutbox, Prisma } from '@prisma/client';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { HttpEmailProvider } from './email.provider';
import { SMS_PROVIDER, SmsProvider } from './sms.provider';

export interface NotificationInput {
  schoolId?: string | null;
  channel?: NotificationChannel;
  recipient: string;
  template: string;
  body: string;
  payload?: Record<string, unknown>;
}

export const MAX_ATTEMPTS = 5;

/**
 * Notifications fiables (pattern outbox) : l'écriture en base se fait dans la même
 * transaction que l'action métier ; l'envoi est fait ensuite par le worker, avec
 * nouvelles tentatives espacées.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  async enqueue(input: NotificationInput, tx?: Tx): Promise<NotificationOutbox> {
    return (tx ?? this.db).notificationOutbox.create({
      data: {
        schoolId: input.schoolId ?? null,
        channel: input.channel ?? 'SMS',
        recipient: input.recipient,
        template: input.template,
        body: input.body,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /** Réserve puis envoie un lot de notifications en attente. Renvoie le nombre traité. */
  async dispatchPending(limit = 50, onlyId?: string): Promise<number> {
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
        await this.send(n);
        await this.db.notificationOutbox.update({
          where: { id: n.id },
          data: { status: 'SENT', sentAt: new Date(), lastError: null },
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
        return new HttpEmailProvider().send(
          n.recipient,
          typeof subject === 'string' ? subject : 'Ecole',
          n.body,
        );
      }
    }
  }
}
