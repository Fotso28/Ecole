import { describe, expect, it } from 'vitest';
import { lineBadge } from './badge';

describe('badge d’une échéance', () => {
  it('une échéance échue impayée est « En retard », jamais « À venir »', () => {
    expect(lineBadge({ status: 'UNPAID', overdue: true })).toEqual({
      tone: 'danger',
      label: 'En retard',
    });
    expect(lineBadge({ status: 'PARTIAL', overdue: true })).toEqual({
      tone: 'danger',
      label: 'Partiel, en retard',
    });
    expect(lineBadge({ status: 'UNPAID', overdue: false }).label).toBe('À venir');
    expect(lineBadge({ status: 'PARTIAL' }).label).toBe('Partiel');
    expect(lineBadge({ status: 'PAID', overdue: true }).label).toBe('Payé');
  });
});
