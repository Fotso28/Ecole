import { describe, expect, it } from 'vitest';
import {
  checkMove,
  DEFAULT_PERIOD_STARTS,
  fromMinutes,
  gridStartTimes,
  movedSlot,
  type TimetableSlot,
} from './timetable';

const slot = (over: Partial<TimetableSlot> & { id: string }): TimetableSlot => ({
  dayOfWeek: 1,
  startTime: '07:30',
  endTime: '08:25',
  classId: 'c1',
  teacherId: null,
  roomId: null,
  ...over,
});

describe('heures', () => {
  it('convertit des minutes en HH:MM', () => {
    expect(fromMinutes(0)).toBe('00:00');
    expect(fromMinutes(450)).toBe('07:30');
    expect(fromMinutes(23 * 60 + 59)).toBe('23:59');
  });

  it.each([-1, 24 * 60, 1.5, Number.NaN])('refuse %s minutes', (m) => {
    expect(() => fromMinutes(m)).toThrow(RangeError);
  });
});

describe('déplacement d’un cours', () => {
  it('garde la durée du cours', () => {
    const moved = movedSlot(slot({ id: 'a', startTime: '07:30', endTime: '09:20' }), {
      dayOfWeek: 3,
      startTime: '10:30',
    });
    expect(moved).toMatchObject({ dayOfWeek: 3, startTime: '10:30', endTime: '12:20' });
  });

  it('refuse un jour hors de la semaine ou un cours après minuit', () => {
    expect(() => movedSlot(slot({ id: 'a' }), { dayOfWeek: 0, startTime: '07:30' })).toThrow(
      RangeError,
    );
    expect(() => movedSlot(slot({ id: 'a' }), { dayOfWeek: 7, startTime: '07:30' })).toThrow(
      RangeError,
    );
    expect(() => movedSlot(slot({ id: 'a' }), { dayOfWeek: 1, startTime: '23:30' })).toThrow(
      RangeError,
    );
    expect(() => movedSlot(slot({ id: 'a' }), { dayOfWeek: 1, startTime: '7:30' })).toThrow(
      RangeError,
    );
  });

  it('accepte un créneau libre', () => {
    const slots = [
      slot({ id: 'a', teacherId: 't1', roomId: 'r1' }),
      slot({ id: 'b', startTime: '08:25', endTime: '09:20', teacherId: 't2' }),
    ];
    expect(checkMove(slots, 'a', { dayOfWeek: 2, startTime: '08:25' }).conflicts).toEqual([]);
  });

  it('ne compte pas le cours déplacé contre lui-même', () => {
    const slots = [slot({ id: 'a', teacherId: 't1', roomId: 'r1' })];
    expect(checkMove(slots, 'a', { dayOfWeek: 1, startTime: '08:00' }).conflicts).toEqual([]);
  });

  it('signale l’enseignant pris dans une autre classe', () => {
    const slots = [
      slot({ id: 'a', teacherId: 't1' }),
      slot({ id: 'b', classId: 'c2', dayOfWeek: 2, teacherId: 't1' }),
    ];
    expect(checkMove(slots, 'a', { dayOfWeek: 2, startTime: '08:00' }).conflicts).toEqual([
      { kind: 'teacher', slotId: 'b' },
    ]);
  });

  it('signale la salle occupée et la classe qui a déjà cours', () => {
    const slots = [
      slot({ id: 'a', roomId: 'r1', teacherId: 't1' }),
      slot({ id: 'b', classId: 'c2', dayOfWeek: 2, roomId: 'r1', teacherId: 't2' }),
      slot({ id: 'c', dayOfWeek: 2, startTime: '08:25', endTime: '09:20', teacherId: 't3' }),
    ];
    const check = checkMove(slots, 'a', { dayOfWeek: 2, startTime: '08:00' });
    expect(check.conflicts).toEqual(
      expect.arrayContaining([
        { kind: 'room', slotId: 'b' },
        { kind: 'class', slotId: 'c' },
      ]),
    );
    expect(check.conflicts).toHaveLength(2);
  });

  it('cumule plusieurs conflits avec le même cours', () => {
    const slots = [
      slot({ id: 'a', teacherId: 't1', roomId: 'r1' }),
      slot({ id: 'b', dayOfWeek: 4, teacherId: 't1', roomId: 'r1' }),
    ];
    const kinds = checkMove(slots, 'a', { dayOfWeek: 4, startTime: '07:30' }).conflicts.map(
      (c) => c.kind,
    );
    expect(kinds.sort()).toEqual(['class', 'room', 'teacher']);
  });

  it('accepte deux cours qui se touchent sans se chevaucher', () => {
    const slots = [
      slot({ id: 'a', teacherId: 't1' }),
      slot({
        id: 'b',
        classId: 'c2',
        dayOfWeek: 2,
        startTime: '08:25',
        endTime: '09:20',
        teacherId: 't1',
      }),
    ];
    expect(checkMove(slots, 'a', { dayOfWeek: 2, startTime: '07:30' }).conflicts).toEqual([]);
    expect(checkMove(slots, 'a', { dayOfWeek: 2, startTime: '09:20' }).conflicts).toEqual([]);
    expect(checkMove(slots, 'a', { dayOfWeek: 2, startTime: '07:31' }).conflicts).toEqual([
      { kind: 'teacher', slotId: 'b' },
    ]);
  });

  it('signale la charge horaire dépassée', () => {
    const slots = [
      slot({ id: 'a', teacherId: 't1' }),
      slot({ id: 'b', dayOfWeek: 2, teacherId: 't1' }),
    ];
    // 110 minutes pour un maximum de 100 : la charge est déjà dépassée, le déplacement le signale.
    expect(
      checkMove(slots, 'a', { dayOfWeek: 3, startTime: '07:30' }, { t1: 100 }).conflicts,
    ).toEqual([{ kind: 'load' }]);
    expect(
      checkMove(slots, 'a', { dayOfWeek: 3, startTime: '07:30' }, { t1: 110 }).conflicts,
    ).toEqual([]);
    // Pas de maximum connu : pas de contrôle.
    expect(
      checkMove(slots, 'a', { dayOfWeek: 3, startTime: '07:30' }, { t1: null }).conflicts,
    ).toEqual([]);
  });

  it('refuse un cours inconnu', () => {
    expect(() => checkMove([], 'x', { dayOfWeek: 1, startTime: '07:30' })).toThrow(RangeError);
  });
});

describe('grille de l’emploi du temps', () => {
  it('ajoute les heures utilisées aux heures habituelles, dans l’ordre', () => {
    const rows = gridStartTimes([{ startTime: '13:00' }, { startTime: '07:30' }]);
    expect(rows).toContain('13:00');
    expect(rows.filter((r) => r === '07:30')).toHaveLength(1);
    expect(rows).toHaveLength(DEFAULT_PERIOD_STARTS.length + 1);
    expect([...rows].sort()).toEqual(rows);
  });
});
