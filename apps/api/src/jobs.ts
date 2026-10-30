import type { INestApplicationContext } from '@nestjs/common';
import { runAsSystem } from './common/context';
import { AccountingService } from './modules/accounting/accounting.service';
import { FinanceService } from './modules/finance/finance.service';
import { NotificationsService } from './modules/notifications/notifications.service';

export const JOBS = {
  /** Envoi des notifications en attente (SMS). */
  outbox: { every: 5_000 },
  /** Interrogation des opérateurs pour les paiements Mobile Money en attente. */
  reconcile: { every: 10 * 60_000 },
  /** Relances de scolarité J+n, chaque matin à 8 h (heure de Douala). */
  reminders: { pattern: '0 8 * * *', tz: 'Africa/Douala' },
  /** Écritures comptables des opérations de scolarité (idempotent, rattrape l'historique). */
  accounting: { every: 60_000 },
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
    case 'accounting':
      return runAsSystem('job:accounting', () =>
        app
          .get(AccountingService)
          .syncAllSchools()
          .then((r) => r.posted),
      );
    default:
      throw new Error(`Tâche inconnue : ${name}`);
  }
}
