/** Détection des conflits d'emploi du temps. Les heures sont au format HH:MM. */

export interface TimetableSlot {
  id: string;
  /** 1 = lundi … 6 = samedi. */
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  classId: string;
  teacherId?: string | null;
  roomId?: string | null;
}

export type ConflictKind = 'teacher' | 'room' | 'class';

export interface TimetableConflict {
  kind: ConflictKind;
  slotIds: [string, string];
}

export function toMinutes(time: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new RangeError(`Heure invalide : ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function overlaps(
  a: Pick<TimetableSlot, 'dayOfWeek' | 'startTime' | 'endTime'>,
  b: Pick<TimetableSlot, 'dayOfWeek' | 'startTime' | 'endTime'>,
): boolean {
  if (a.dayOfWeek !== b.dayOfWeek) return false;
  return (
    toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(b.startTime) < toMinutes(a.endTime)
  );
}

/** Liste les conflits : même enseignant, même salle ou même classe sur des créneaux qui se chevauchent. */
export function findConflicts(slots: readonly TimetableSlot[]): TimetableConflict[] {
  const conflicts: TimetableConflict[] = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!;
      const b = slots[j]!;
      if (!overlaps(a, b)) continue;
      if (a.teacherId && a.teacherId === b.teacherId)
        conflicts.push({ kind: 'teacher', slotIds: [a.id, b.id] });
      if (a.roomId && a.roomId === b.roomId)
        conflicts.push({ kind: 'room', slotIds: [a.id, b.id] });
      if (a.classId === b.classId) conflicts.push({ kind: 'class', slotIds: [a.id, b.id] });
    }
  }
  return conflicts;
}

/** Heures hebdomadaires (en minutes) par enseignant, pour contrôler la charge maximale. */
export function weeklyMinutesByTeacher(slots: readonly TimetableSlot[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of slots) {
    if (!s.teacherId) continue;
    const minutes = toMinutes(s.endTime) - toMinutes(s.startTime);
    totals.set(s.teacherId, (totals.get(s.teacherId) ?? 0) + minutes);
  }
  return totals;
}

// ---------------------------------------------------------------- Déplacement d'un cours

/** Débuts des heures de cours habituelles (séances de 55 minutes, récréation de 10 h 15 à 10 h 30). */
export const DEFAULT_PERIOD_STARTS = [
  '07:30',
  '08:25',
  '09:20',
  '10:30',
  '11:25',
  '12:20',
  '14:00',
  '14:55',
  '15:50',
] as const;

export type MoveConflictKind = ConflictKind | 'load';

export interface MoveTarget {
  dayOfWeek: number;
  startTime: string;
}

export interface MoveConflict {
  kind: MoveConflictKind;
  /** Cours en conflit (absent pour un dépassement de charge horaire). */
  slotId?: string;
}

export interface MoveCheck {
  /** Créneau obtenu : même durée, nouveau jour et nouvelle heure de début. */
  slot: TimetableSlot;
  conflicts: MoveConflict[];
}

export function fromMinutes(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60)
    throw new RangeError(`Minutes invalides : ${minutes}`);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Créneau déplacé en gardant sa durée. Erreur si le cours finirait après minuit. */
export function movedSlot(slot: TimetableSlot, target: MoveTarget): TimetableSlot {
  if (!Number.isInteger(target.dayOfWeek) || target.dayOfWeek < 1 || target.dayOfWeek > 6)
    throw new RangeError(`Jour invalide : ${target.dayOfWeek}`);
  const duration = toMinutes(slot.endTime) - toMinutes(slot.startTime);
  const start = toMinutes(target.startTime);
  if (start + duration >= 24 * 60) throw new RangeError('Le cours finirait après minuit');
  return {
    ...slot,
    dayOfWeek: target.dayOfWeek,
    startTime: target.startTime,
    endTime: fromMinutes(start + duration),
  };
}

/**
 * Conflits que provoquerait le déplacement du cours `slotId` vers `target`, parmi tous les cours
 * de l'année (toutes classes, pour voir l'enseignant et la salle) : enseignant, salle, classe, et
 * charge horaire hebdomadaire de l'enseignant au-delà de son maximum (en minutes).
 */
export function checkMove(
  slots: readonly TimetableSlot[],
  slotId: string,
  target: MoveTarget,
  maxWeeklyMinutes: Readonly<Record<string, number | null | undefined>> = {},
): MoveCheck {
  const current = slots.find((s) => s.id === slotId);
  if (!current) throw new RangeError(`Cours inconnu : ${slotId}`);
  const slot = movedSlot(current, target);
  const others = slots.filter((s) => s.id !== slotId);
  const conflicts: MoveConflict[] = findConflicts([...others, slot])
    .filter((c) => c.slotIds.includes(slotId))
    .map((c) => ({ kind: c.kind, slotId: c.slotIds.find((id) => id !== slotId) }));
  const max = slot.teacherId ? maxWeeklyMinutes[slot.teacherId] : null;
  if (slot.teacherId && max) {
    const minutes = weeklyMinutesByTeacher([...others, slot]).get(slot.teacherId) ?? 0;
    if (minutes > max) conflicts.push({ kind: 'load' });
  }
  return { slot, conflicts };
}

/** Lignes de la grille : heures habituelles et heures de début réellement utilisées, triées. */
export function gridStartTimes(
  slots: readonly Pick<TimetableSlot, 'startTime'>[],
  defaults: readonly string[] = DEFAULT_PERIOD_STARTS,
): string[] {
  return [...new Set([...defaults, ...slots.map((s) => s.startTime)])].sort(
    (a, b) => toMinutes(a) - toMinutes(b),
  );
}
