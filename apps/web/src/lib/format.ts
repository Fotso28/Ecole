import { formatFcfa } from '@ecole/shared';

export {
  formatCameroonPhone,
  formatFcfa,
  formatGrade,
  initials,
  PAYMENT_METHOD_LABELS,
  ROLE_LABELS,
} from '@ecole/shared';

const dateFmt = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const shortFmt = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});
const weekdayFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const timeFmt = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Africa/Douala',
});
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Africa/Douala',
});

const toDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);

/** « 12 mars 2012 » à partir d'une date ISO. */
export const formatDate = (iso: string) => dateFmt.format(toDate(iso.slice(0, 10)));
/** « 12/03/2012 ». */
export const formatShortDate = (iso: string) => shortFmt.format(toDate(iso.slice(0, 10)));
/** « jeudi 29 octobre ». */
export const formatWeekday = (iso: string) => weekdayFmt.format(toDate(iso.slice(0, 10)));
/** Heure de Douala d'un horodatage. */
export const formatTime = (iso: string | Date) =>
  timeFmt.format(typeof iso === 'string' ? new Date(iso) : iso);
export const formatDateTime = (iso: string | Date) =>
  dateTimeFmt.format(typeof iso === 'string' ? new Date(iso) : iso);

/** Date du jour au Cameroun (UTC+1). */
export function todayIso(): string {
  return new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

/** Écart signé avec le signe moins typographique : « −500 FCFA », « +250 FCFA », « 0 FCFA ». */
export function formatSignedFcfa(amount: number): string {
  if (amount === 0) return formatFcfa(0);
  return `${amount < 0 ? '\u2212' : '+'}${formatFcfa(Math.abs(amount))}`;
}
