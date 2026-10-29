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
