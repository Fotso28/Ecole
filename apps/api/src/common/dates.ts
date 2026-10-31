/** Dates calendaires au format ISO (AAAA-MM-JJ) stockées en colonnes DATE. */

export function toDbDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function fromDbDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Date du jour au Cameroun (Africa/Douala, UTC+1 sans heure d'été). */
export function todayInCameroon(now = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = toDbDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDbDate(d);
}

/** Début d'un jour calendaire de Douala (UTC+1, sans heure d'été), en instant UTC. */
export function doualaDayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00.000+01:00`);
}

/** « 2026-10-31 11:23 » : date et heure de Douala d'un instant (exports). */
export function doualaDateTime(d: Date): string {
  return new Date(d.getTime() + 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
