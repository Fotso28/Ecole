import type { INestApplicationContext } from '@nestjs/common';
import { runAsSystem } from './common/context';
import { CalendarService } from './modules/calendar/calendar.module';
import { FinanceService } from './modules/finance/finance.service';
import { NotificationsService } from './modules/notifications/notifications.service';

export const JOBS = {
  /** Envoi des notifications en attente (SMS). */
  outbox: { every: 5_000 },
  /** Interrogation des opérateurs pour les paiements Mobile Money en attente. */
  reconcile: { every: 10 * 60_000 },
  /** Relances de scolarité J+n, chaque matin à 8 h (heure de Douala). */
  reminders: { pattern: '0 8 * * *', tz: 'Africa/Douala' },
  /** Rappels des événements du lendemain, chaque soir à 18 h (heure de Douala). */
  eventReminders: { pattern: '0 18 * * *', tz: 'Africa/Douala' },
} as const;

export type JobName = keyof typeof JOBS;

export async function runJob(app: INestApplicationContext, name: string): Promise<unknown> {
  switch (name) {
    case 'outbox':
      return runAsSystem('job:outbox', () => app.get(NotificationsService).dispatchPending(100));
    case 'reconcile':
      return runAsSystem('job:reconcile', () => app.get(FinanceService).reconcilePending());
    case 'reminders':
      return runAsSystem('job:reminders', () => app.get(FinanceService).sendReminders());
    case 'eventReminders':
      return runAsSystem('job:event-reminders', () => app.get(CalendarService).sendReminders());
    default:
      throw new Error(`Tâche inconnue : ${name}`);
  }
}
