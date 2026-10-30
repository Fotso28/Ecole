import { describe, expect, it } from 'vitest';
import { formatDate, formatShortDate, formatWeekday, plural } from './format';

describe('formats français', () => {
  it('formate les dates calendaires sans décalage de fuseau', () => {
    expect(formatDate('2012-03-12')).toBe('12 mars 2012');
    expect(formatShortDate('2026-11-15T00:00:00.000Z')).toBe('15/11/2026');
    expect(formatWeekday('2026-10-29')).toBe('jeudi 29 octobre');
  });

  it('accorde au pluriel', () => {
    expect(plural(1, 'élève', 'élèves')).toBe('1 élève');
    expect(plural(3, 'élève', 'élèves')).toBe('3 élèves');
  });
});
