/** Règles de communication : choix du canal, regroupement des notifications, calendrier. */

export type ContactChannel = 'SMS' | 'EMAIL';

export interface Contact {
  phone?: string | null;
  email?: string | null;
}

/**
 * Canal d'envoi selon les coordonnées disponibles et la préférence de l'école : le canal préféré
 * s'il est joignable, sinon l'autre, sinon aucun.
 */
export function pickChannel(
  contact: Contact,
  preferred: ContactChannel = 'SMS',
): ContactChannel | null {
  const has: Record<ContactChannel, boolean> = {
    SMS: !!contact.phone?.trim(),
    EMAIL: !!contact.email?.trim(),
  };
  if (has[preferred]) return preferred;
  const other: ContactChannel = preferred === 'SMS' ? 'EMAIL' : 'SMS';
  return has[other] ? other : null;
}

/** Délai avant la notification « nouveau message » : regroupe les messages envoyés en rafale. */
export const MESSAGE_NOTIFY_DELAY_MS = 10 * 60_000;
/** Intervalle minimal entre deux notifications pour un même fil et un même destinataire. */
export const MESSAGE_NOTIFY_COOLDOWN_MS = 3 * 3600_000;
/** Plafond de notifications « nouveau message » par destinataire sur 24 heures. */
export const MESSAGE_NOTIFY_DAILY_CAP = 4;

export interface MessageNotificationHistory {
  /** Une notification du même fil attend déjà son envoi pour ce destinataire. */
  pendingForThread: boolean;
  /** Dernière notification envoyée pour ce fil et ce destinataire. */
  lastSentForThreadAt: Date | null;
  /** Notifications (en attente ou envoyées) reçues par ce destinataire sur 24 heures, tous fils confondus. */
  countLast24h: number;
}

export type MessageNotificationPlan =
  | { action: 'skip'; reason: 'grouped' | 'daily-cap' }
  | { action: 'enqueue'; availableAt: Date };

/**
 * Anti-harcèlement : un message ne déclenche pas forcément une notification. Les messages d'un
 * même fil sont regroupés dans une seule notification différée, espacée d'au moins
 * `MESSAGE_NOTIFY_COOLDOWN_MS`, dans la limite de `MESSAGE_NOTIFY_DAILY_CAP` par jour.
 */
export function planMessageNotification(
  history: MessageNotificationHistory,
  now: Date,
): MessageNotificationPlan {
  if (history.pendingForThread) return { action: 'skip', reason: 'grouped' };
  if (history.countLast24h >= MESSAGE_NOTIFY_DAILY_CAP)
    return { action: 'skip', reason: 'daily-cap' };
  const earliest = now.getTime() + MESSAGE_NOTIFY_DELAY_MS;
  const afterCooldown = history.lastSentForThreadAt
    ? history.lastSentForThreadAt.getTime() + MESSAGE_NOTIFY_COOLDOWN_MS
    : 0;
  return { action: 'enqueue', availableAt: new Date(Math.max(earliest, afterCooldown)) };
}

// Calendrier (dates ISO AAAA-MM-JJ, sans fuseau)

const DAY_MS = 86_400_000;
const toUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  return toIso(new Date(toUtc(iso).getTime() + days * DAY_MS));
}

/** Premier et dernier jour d'un mois (`month` de 1 à 12). */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return { from: toIso(first), to: toIso(last) };
}

/** Grille du mois en semaines du lundi au dimanche, complétée par les jours des mois voisins. */
export function monthGrid(year: number, month: number): { date: string; inMonth: boolean }[][] {
  const { from, to } = monthBounds(year, month);
  const offset = (toUtc(from).getUTCDay() + 6) % 7;
  let cursor = addDays(from, -offset);
  const weeks: { date: string; inMonth: boolean }[][] = [];
  while (cursor <= to) {
    const week: { date: string; inMonth: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({ date: cursor, inMonth: cursor >= from && cursor <= to });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export interface DatedEvent {
  startDate: string;
  endDate?: string | null;
}

/** Vrai si l'événement (bornes incluses) couvre ce jour. */
export function eventCoversDay(event: DatedEvent, day: string): boolean {
  return event.startDate <= day && (event.endDate ?? event.startDate) >= day;
}

/** Vrai si l'événement chevauche la période [from, to] (bornes incluses). */
export function eventOverlaps(event: DatedEvent, from: string, to: string): boolean {
  return event.startDate <= to && (event.endDate ?? event.startDate) >= from;
}
