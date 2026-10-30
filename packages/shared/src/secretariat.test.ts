import { describe, expect, it } from 'vitest';
import { hasPermission } from './permissions';
import { YEAR_END_DECISIONS, type YearEndDecision } from './results';
import {
  documentCounterKey,
  documentTemplateSchema,
  formatDocumentNumber,
  incidentFilterSchema,
  reenrollmentSchema,
  suggestPromotionClass,
  suggestReenrollment,
  suggestRepeatClass,
  summarizeIncidents,
  type ClassRef,
} from './secretariat';

describe('numérotation des documents', () => {
  it('compose préfixe, année et rang sur quatre chiffres', () => {
    expect(formatDocumentNumber('SCHOOL_CERTIFICATE', '2026-2027', 7)).toBe('CS-2026-2027-0007');
    expect(formatDocumentNumber('ENROLLMENT_ATTESTATION', '2026-2027', 1234)).toBe(
      'AI-2026-2027-1234',
    );
    expect(formatDocumentNumber('STUDENT_CARD', '2026-2027', 12345)).toBe('CE-2026-2027-12345');
  });

  it('tient une série distincte par type et par année', () => {
    const keys = new Set([
      documentCounterKey('SCHOOL_CERTIFICATE', 'y1'),
      documentCounterKey('SCHOOL_CERTIFICATE', 'y2'),
      documentCounterKey('STUDENT_CARD', 'y1'),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe('modèle de document', () => {
  it('ramène les champs vides à null et limite l’en-tête à six lignes', () => {
    const parsed = documentTemplateSchema.parse({ title: '  ', signatoryName: 'M. Abena' });
    expect(parsed.title).toBeNull();
    expect(parsed.signatoryName).toBe('M. Abena');
    expect(parsed.headerLines).toEqual([]);
    expect(
      documentTemplateSchema.safeParse({ headerLines: Array.from({ length: 7 }, () => 'x') })
        .success,
    ).toBe(false);
  });
});

describe('suggestReenrollment', () => {
  it('reconnaît les décisions de passage, de redoublement et de sortie', () => {
    expect(suggestReenrollment('PROMOTED')).toBe('PROMOTED');
    expect(suggestReenrollment('Admis en classe supérieure')).toBe('PROMOTED');
    expect(suggestReenrollment('REPEAT')).toBe('REPEATING');
    expect(suggestReenrollment('Redouble')).toBe('REPEATING');
    expect(suggestReenrollment('EXCLUDED')).toBe('LEFT');
    expect(suggestReenrollment('Exclusion définitive')).toBe('LEFT');
    expect(suggestReenrollment('TRANSFERRED')).toBe('LEFT');
  });

  it('traduit chaque décision de fin d’année du conseil', () => {
    const expected: Record<YearEndDecision, string> = {
      PROMOTED: 'PROMOTED',
      PROMOTED_BY_COUNCIL: 'PROMOTED',
      REPEAT: 'REPEATING',
      EXCLUDED_WORK: 'LEFT',
      EXCLUDED_CONDUCT: 'LEFT',
    };
    for (const d of YEAR_END_DECISIONS) expect(suggestReenrollment(d)).toBe(expected[d]);
  });

  it('ne propose rien pour une décision inconnue ou trimestrielle', () => {
    expect(suggestReenrollment(null)).toBeNull();
    expect(suggestReenrollment(undefined)).toBeNull();
    expect(suggestReenrollment('')).toBeNull();
    expect(suggestReenrollment('HONOR_ROLL')).toBeNull();
    expect(suggestReenrollment('WARNING')).toBeNull();
    expect(suggestReenrollment('NOUVELLE_DECISION_2028')).toBeNull();
  });
});

const cls = (id: string, name: string, levelName: string, levelOrder: number): ClassRef => ({
  id,
  name,
  levelId: `L${levelOrder}`,
  levelName,
  levelOrder,
});

describe('classes proposées', () => {
  const targets = [
    cls('t6A', '6e A', '6e', 1),
    cls('t5A', '5e A', '5e', 2),
    cls('t4B', '4e B', '4e', 3),
    cls('t4A', '4e A', '4e', 3),
    cls('t3A', '3e A', '3e', 4),
    cls('t2C', '2nde C', '2nde', 5),
  ];

  it('envoie un admis au niveau suivant, de préférence dans la classe de même lettre', () => {
    expect(suggestPromotionClass(cls('s5A', '5e A', '5e', 2), targets)).toBe('t4A');
    expect(suggestPromotionClass(cls('s4B', '4e B', '4e', 3), targets)).toBe('t3A');
    expect(suggestPromotionClass(cls('s3B', '3e B', '3e', 4), targets)).toBe('t2C');
  });

  it('saute un niveau absent et ne propose rien après la dernière classe', () => {
    expect(suggestPromotionClass(cls('s6A', '6e A', '6e', 1), targets.slice(2))).toBe('t4A');
    expect(suggestPromotionClass(cls('sTle', 'Tle D', 'Tle', 7), targets)).toBeNull();
  });

  it('garde un redoublant dans la classe de même nom, sinon au même niveau', () => {
    expect(suggestRepeatClass(cls('s4B', '4e B', '4e', 3), targets)).toBe('t4B');
    expect(suggestRepeatClass(cls('s4C', '4e C', '4e', 3), targets)).toBe('t4A');
    expect(suggestRepeatClass(cls('s1D', '1re D', '1re', 6), targets)).toBeNull();
  });
});

describe('reenrollmentSchema', () => {
  it('exige une classe sauf pour un sortant', () => {
    const ok = reenrollmentSchema.safeParse({
      fromYearId: 'y',
      items: [
        { studentId: 'a', decision: 'PROMOTED', classId: 'c' },
        { studentId: 'b', decision: 'LEFT' },
      ],
    });
    expect(ok.success).toBe(true);
    const ko = reenrollmentSchema.safeParse({
      fromYearId: 'y',
      items: [{ studentId: 'a', decision: 'REPEATING' }],
    });
    expect(ko.success).toBe(false);
  });
});

describe('summarizeIncidents', () => {
  it('compte par type, sanction et mois, et repère les récidives', () => {
    const stats = summarizeIncidents([
      { studentId: 'a', type: 'VIOLENCE', sanctionType: 'BLAME', date: '2026-10-02' },
      { studentId: 'a', type: 'INSOLENCE', sanctionType: 'NONE', date: '2026-09-20' },
      { studentId: 'b', type: 'VIOLENCE', sanctionType: 'DETENTION', date: '2026-10-15' },
      { studentId: 'c', type: 'FRAUD', sanctionType: 'NONE', date: '2026-11-03' },
      { studentId: 'a', type: 'VIOLENCE', sanctionType: 'WARNING', date: '2026-11-04' },
    ]);
    expect(stats.total).toBe(5);
    expect(stats.students).toBe(3);
    expect(stats.sanctioned).toBe(3);
    expect(stats.byType).toEqual([
      { type: 'VIOLENCE', count: 3 },
      { type: 'FRAUD', count: 1 },
      { type: 'INSOLENCE', count: 1 },
    ]);
    expect(stats.bySanction[0]).toEqual({ sanctionType: 'NONE', count: 2 });
    expect(stats.byMonth).toEqual([
      { month: '2026-09', count: 1 },
      { month: '2026-10', count: 2 },
      { month: '2026-11', count: 2 },
    ]);
    expect(stats.repeatStudents).toEqual([{ studentId: 'a', count: 3 }]);
  });

  it('renvoie des statistiques vides sans incident', () => {
    expect(summarizeIncidents([])).toEqual({
      total: 0,
      students: 0,
      sanctioned: 0,
      byType: [],
      bySanction: [],
      byMonth: [],
      repeatStudents: [],
    });
  });
});

describe('incidentFilterSchema', () => {
  it('refuse une période inversée', () => {
    expect(incidentFilterSchema.safeParse({ from: '2026-11-01', to: '2026-10-01' }).success).toBe(
      false,
    );
    expect(incidentFilterSchema.parse({}).page).toBe(1);
  });
});

describe('permissions du secrétariat et de la discipline', () => {
  it('réserve le registre des incidents au surveillant général et à la direction', () => {
    expect(hasPermission(['SUPERVISOR'], 'discipline.read')).toBe(true);
    expect(hasPermission(['DIRECTOR'], 'discipline.read')).toBe(true);
    for (const role of ['CENSOR', 'SECRETARY', 'ACCOUNTANT', 'TEACHER', 'NURSE'] as const)
      expect(hasPermission([role], 'discipline.read')).toBe(false);
  });

  it('laisse le secrétariat délivrer mais réserve annulation et modèles à la direction', () => {
    expect(hasPermission(['SECRETARY'], 'documents.issue')).toBe(true);
    expect(hasPermission(['SECRETARY'], 'documents.cancel')).toBe(false);
    expect(hasPermission(['SECRETARY'], 'documents.configure')).toBe(false);
    expect(hasPermission(['DIRECTOR'], 'documents.cancel')).toBe(true);
    expect(hasPermission(['DIRECTOR'], 'documents.configure')).toBe(true);
    expect(hasPermission(['TEACHER'], 'documents.read')).toBe(false);
  });
});
