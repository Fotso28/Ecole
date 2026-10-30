import { describe, expect, it } from 'vitest';
import {
  addDays,
  eventCoversDay,
  eventOverlaps,
  MESSAGE_NOTIFY_COOLDOWN_MS,
  MESSAGE_NOTIFY_DAILY_CAP,
  MESSAGE_NOTIFY_DELAY_MS,
  monthBounds,
  monthGrid,
  pickChannel,
  planMessageNotification,
} from './communication';
import { announcementCreateSchema, eventCreateSchema, eventRangeSchema } from './schemas';

describe('pickChannel', () => {
  it('prend le canal préféré quand il est joignable', () => {
    expect(pickChannel({ phone: '+237677123456', email: 'a@b.cm' }, 'SMS')).toBe('SMS');
    expect(pickChannel({ phone: '+237677123456', email: 'a@b.cm' }, 'EMAIL')).toBe('EMAIL');
  });
  it("se replie sur l'autre canal", () => {
    expect(pickChannel({ phone: '+237677123456', email: null }, 'EMAIL')).toBe('SMS');
    expect(pickChannel({ phone: null, email: 'a@b.cm' }, 'SMS')).toBe('EMAIL');
    expect(pickChannel({ phone: '  ', email: 'a@b.cm' })).toBe('EMAIL');
  });
  it('renvoie null sans coordonnées', () => {
    expect(pickChannel({}, 'SMS')).toBeNull();
    expect(pickChannel({ phone: '', email: '' }, 'EMAIL')).toBeNull();
  });
});

describe('planMessageNotification', () => {
  const now = new Date('2026-10-30T10:00:00Z');
  const empty = { pendingForThread: false, lastSentForThreadAt: null, countLast24h: 0 };

  it('diffère la première notification pour regrouper les messages en rafale', () => {
    expect(planMessageNotification(empty, now)).toEqual({
      action: 'enqueue',
      availableAt: new Date(now.getTime() + MESSAGE_NOTIFY_DELAY_MS),
    });
  });
  it('ne crée pas de seconde notification tant que la première attend', () => {
    expect(planMessageNotification({ ...empty, pendingForThread: true }, now)).toEqual({
      action: 'skip',
      reason: 'grouped',
    });
  });
  it("respecte l'intervalle minimal après un envoi pour le même fil", () => {
    const sent = new Date(now.getTime() - 3600_000);
    expect(planMessageNotification({ ...empty, lastSentForThreadAt: sent }, now)).toEqual({
      action: 'enqueue',
      availableAt: new Date(sent.getTime() + MESSAGE_NOTIFY_COOLDOWN_MS),
    });
    const old = new Date(now.getTime() - 2 * MESSAGE_NOTIFY_COOLDOWN_MS);
    expect(planMessageNotification({ ...empty, lastSentForThreadAt: old }, now)).toEqual({
      action: 'enqueue',
      availableAt: new Date(now.getTime() + MESSAGE_NOTIFY_DELAY_MS),
    });
  });
  it('plafonne le nombre de notifications par jour', () => {
    expect(
      planMessageNotification({ ...empty, countLast24h: MESSAGE_NOTIFY_DAILY_CAP - 1 }, now).action,
    ).toBe('enqueue');
    expect(
      planMessageNotification({ ...empty, countLast24h: MESSAGE_NOTIFY_DAILY_CAP }, now),
    ).toEqual({ action: 'skip', reason: 'daily-cap' });
  });
});

describe('calendrier', () => {
  it('ajoute des jours en traversant mois et années', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
  it('donne les bornes du mois', () => {
    expect(monthBounds(2026, 11)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthBounds(2028, 2)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
  it('construit une grille du lundi au dimanche', () => {
    // Novembre 2026 commence un dimanche et finit un lundi.
    const grid = monthGrid(2026, 11);
    expect(grid).toHaveLength(6);
    expect(grid[0]![0]).toEqual({ date: '2026-10-26', inMonth: false });
    expect(grid[0]![6]).toEqual({ date: '2026-11-01', inMonth: true });
    expect(grid[5]![0]).toEqual({ date: '2026-11-30', inMonth: true });
    expect(grid[5]![6]).toEqual({ date: '2026-12-06', inMonth: false });
    expect(grid.every((w) => w.length === 7)).toBe(true);
    // Février 2027 : du lundi 1er au dimanche 28, quatre semaines pleines.
    const feb = monthGrid(2027, 2);
    expect(feb).toHaveLength(4);
    expect(feb.flat().every((d) => d.inMonth)).toBe(true);
  });
  it('teste la couverture et le chevauchement des événements', () => {
    const holiday = { startDate: '2026-12-19', endDate: '2027-01-04' };
    expect(eventCoversDay(holiday, '2026-12-25')).toBe(true);
    expect(eventCoversDay(holiday, '2027-01-05')).toBe(false);
    expect(eventCoversDay({ startDate: '2026-11-12' }, '2026-11-12')).toBe(true);
    expect(eventOverlaps(holiday, '2027-01-01', '2027-01-31')).toBe(true);
    expect(eventOverlaps(holiday, '2026-11-01', '2026-11-30')).toBe(false);
    expect(
      eventOverlaps({ startDate: '2026-11-30', endDate: null }, '2026-11-01', '2026-11-30'),
    ).toBe(true);
  });
});

describe('schémas de communication', () => {
  it('exige au moins un élève pour une annonce ciblée', () => {
    const base = { title: 'Sortie', body: 'Autorisation à signer', scope: 'STUDENTS' as const };
    expect(announcementCreateSchema.safeParse(base).success).toBe(false);
    expect(announcementCreateSchema.safeParse({ ...base, studentIds: ['a', 'b'] }).success).toBe(
      true,
    );
    expect(
      announcementCreateSchema.safeParse({ ...base, scope: 'CLASS', studentIds: [] }).success,
    ).toBe(false);
  });
  it('valide les dates et heures des événements', () => {
    const base = {
      title: 'Réunion',
      category: 'PARENT_MEETING' as const,
      startDate: '2026-11-12',
      scope: 'SCHOOL' as const,
    };
    expect(eventCreateSchema.safeParse(base).success).toBe(true);
    expect(eventCreateSchema.safeParse({ ...base, endDate: '2026-11-11' }).success).toBe(false);
    expect(
      eventCreateSchema.safeParse({ ...base, startTime: '15:00', endTime: '14:00' }).success,
    ).toBe(false);
    expect(eventCreateSchema.safeParse({ ...base, scope: 'CLASS' }).success).toBe(false);
    expect(eventRangeSchema.safeParse({ from: '2026-11-01', to: '2026-11-30' }).success).toBe(true);
    expect(eventRangeSchema.safeParse({ from: '2026-11-30', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(eventRangeSchema.safeParse({ from: '2026-01-01', to: '2028-01-01' }).success).toBe(
      false,
    );
  });
});
