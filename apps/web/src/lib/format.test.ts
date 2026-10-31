import { describe, expect, it } from 'vitest';
import {
  agree,
  formatDate,
  formatShortDate,
  formatSignedFcfa,
  formatWeekday,
  ofName,
  plural,
} from './format';

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

  it('élide « de » devant une voyelle', () => {
    expect(ofName('Etoa Robert')).toBe('d’Etoa Robert');
    expect(ofName('Mbarga Paul')).toBe('de Mbarga Paul');
    expect(ofName(' Owona')).toBe('d’Owona');
  });

  it('accorde au sexe de l’élève quand il est connu', () => {
    expect(agree('F', 'Monté')).toBe('Montée');
    expect(agree('M', 'Déposé')).toBe('Déposé');
    expect(agree(undefined, 'inscrit')).toBe('inscrit(e)');
  });

  it('signe les écarts avec le moins typographique', () => {
    expect(formatSignedFcfa(-500)).toBe('\u2212500\u00a0FCFA');
    expect(formatSignedFcfa(1250)).toBe('+1\u202f250\u00a0FCFA');
    expect(formatSignedFcfa(0)).toBe('0\u00a0FCFA');
  });
});
