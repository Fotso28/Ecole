import { describe, expect, it } from 'vitest';
import {
  assessDuplicate,
  formatCameroonPhone,
  formatMatricule,
  initials,
  levenshtein,
  nameSimilarity,
  normalizeCameroonPhone,
  normalizeName,
} from './identity';
import { hasPermission, isTeacherOnly, permissionsForRoles } from './permissions';
import { findConflicts, weeklyMinutesByTeacher } from './timetable';
import {
  attendanceSubmitSchema,
  isoDate,
  paymentCreateSchema,
  studentCreateSchema,
} from './schemas';

describe('téléphones camerounais', () => {
  it.each([
    ['6 77 12 34 56', '+237677123456'],
    ['677123456', '+237677123456'],
    ['+237 677 12 34 56', '+237677123456'],
    ['00237677123456', '+237677123456'],
    ['237677123456', '+237677123456'],
    ['222 23 45 67', '+237222234567'],
  ])('normalise %s', (input, expected) => {
    expect(normalizeCameroonPhone(input)).toBe(expected);
  });

  it.each(['', '12345', '577123456', '+33612345678', '6771234567', 'abc'])('refuse %s', (input) => {
    expect(normalizeCameroonPhone(input)).toBeNull();
  });

  it('formate pour l’affichage', () => {
    expect(formatCameroonPhone('+237677123456')).toBe('6 77 12 34 56');
  });
});

describe('noms et doublons', () => {
  it('normalise accents, casse et tirets', () => {
    expect(normalizeName('Ngono Marie-Claire')).toBe('NGONO MARIE CLAIRE');
    expect(normalizeName('  Abéna   Grâce ')).toBe('ABENA GRACE');
  });

  it('calcule la distance de Levenshtein', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it("ignore l'ordre des mots", () => {
    expect(nameSimilarity('NGONO Marie Claire', 'Ngono Marie-Claire')).toBe(1);
    expect(nameSimilarity('Marie Claire Ngono', 'Ngono Marie-Claire')).toBe(1);
  });

  it('détecte un doublon probable (nom + date de naissance)', () => {
    const r = assessDuplicate(
      { fullName: 'NGONO Marie Claire', birthDate: '2012-03-12', birthPlace: 'Yaoundé' },
      { fullName: 'Ngono Marie-Claire', birthDate: '2012-03-12', birthPlace: 'Yaounde' },
    );
    expect(r.isLikelyDuplicate).toBe(true);
    expect(r.reasons).toEqual(['same_name', 'same_birth_date', 'same_birth_place']);
  });

  it('détecte un doublon par le téléphone du parent malgré une faute de frappe', () => {
    const r = assessDuplicate(
      { fullName: 'Ngono Marie Clair', birthDate: '2012-03-13', guardianPhones: ['6 77 12 34 56'] },
      {
        fullName: 'Ngono Marie-Claire',
        birthDate: '2012-03-12',
        guardianPhones: ['+237677123456'],
      },
    );
    expect(r.reasons).toContain('similar_name');
    expect(r.reasons).toContain('same_guardian_phone');
    expect(r.isLikelyDuplicate).toBe(true);
  });

  it('ne signale pas des homonymes nés à des dates différentes sans parent commun', () => {
    const r = assessDuplicate(
      { fullName: 'Kamga Yvan', birthDate: '2010-01-19' },
      { fullName: 'Kamga Yvan', birthDate: '2011-05-02' },
    );
    expect(r.isLikelyDuplicate).toBe(false);
  });

  it('ne signale pas deux enfants différents de même date de naissance', () => {
    const r = assessDuplicate(
      { fullName: 'Bilong Estelle', birthDate: '2012-03-12' },
      { fullName: 'Ngono Marie-Claire', birthDate: '2012-03-12' },
    );
    expect(r.isLikelyDuplicate).toBe(false);
  });
});

describe('matricules et initiales', () => {
  it('formate un matricule', () => {
    expect(formatMatricule('CD', 2026, 19)).toBe('CD-2026-0019');
    expect(formatMatricule('CD', 2026, 12345)).toBe('CD-2026-12345');
  });

  it('refuse un préfixe ou une séquence invalide', () => {
    expect(() => formatMatricule('cd', 2026, 1)).toThrow(RangeError);
    expect(() => formatMatricule('CD', 2026, 0)).toThrow(RangeError);
  });

  it('calcule les initiales', () => {
    expect(initials('Ngono Marie-Claire')).toBe('NM');
    expect(initials('Bello')).toBe('B');
  });
});

describe('permissions', () => {
  it('cumule les permissions de plusieurs rôles', () => {
    const p = permissionsForRoles(['TEACHER', 'SUPERVISOR']);
    expect(p.has('grades.write')).toBe(true);
    expect(p.has('attendance.justify')).toBe(true);
    expect(p.has('finance.payments.create')).toBe(false);
  });

  it("réserve la fiche santé à l'infirmerie, même pour la direction", () => {
    expect(hasPermission(['DIRECTOR'], 'health.read')).toBe(false);
    expect(hasPermission(['NURSE'], 'health.read')).toBe(true);
  });

  it('identifie un enseignant sans autre rôle', () => {
    expect(isTeacherOnly(['TEACHER'])).toBe(true);
    expect(isTeacherOnly(['TEACHER', 'CENSOR'])).toBe(false);
    expect(isTeacherOnly([])).toBe(false);
  });
});

describe('emploi du temps', () => {
  const base = { dayOfWeek: 2, classId: '4A' };
  it('détecte un enseignant présent dans deux classes au même créneau', () => {
    const conflicts = findConflicts([
      {
        ...base,
        id: 'a',
        startTime: '10:30',
        endTime: '11:25',
        teacherId: 'ateba',
        roomId: 'labo1',
      },
      {
        id: 'b',
        dayOfWeek: 2,
        classId: '3B',
        startTime: '10:30',
        endTime: '11:25',
        teacherId: 'ateba',
        roomId: 'labo2',
      },
    ]);
    expect(conflicts).toEqual([{ kind: 'teacher', slotIds: ['a', 'b'] }]);
  });

  it('ne signale pas des créneaux contigus', () => {
    expect(
      findConflicts([
        { ...base, id: 'a', startTime: '07:30', endTime: '08:25', teacherId: 't' },
        { ...base, id: 'b', startTime: '08:25', endTime: '09:20', teacherId: 't' },
      ]),
    ).toEqual([]);
  });

  it('détecte salle et classe occupées', () => {
    const kinds = findConflicts([
      { ...base, id: 'a', startTime: '08:00', endTime: '09:00', roomId: 'r1' },
      { ...base, id: 'b', startTime: '08:30', endTime: '09:30', roomId: 'r1' },
    ]).map((c) => c.kind);
    expect(kinds).toEqual(['room', 'class']);
  });

  it('somme la charge hebdomadaire par enseignant', () => {
    const totals = weeklyMinutesByTeacher([
      { ...base, id: 'a', startTime: '07:30', endTime: '08:25', teacherId: 't' },
      { ...base, id: 'b', dayOfWeek: 3, startTime: '07:30', endTime: '09:20', teacherId: 't' },
    ]);
    expect(totals.get('t')).toBe(165);
  });
});

describe('schémas de validation', () => {
  it('valide les dates réelles uniquement', () => {
    expect(isoDate.safeParse('2026-10-29').success).toBe(true);
    expect(isoDate.safeParse('2026-02-30').success).toBe(false);
    expect(isoDate.safeParse('29/10/2026').success).toBe(false);
  });

  it('normalise le téléphone des parents à l’inscription', () => {
    const r = studentCreateSchema.parse({
      firstName: 'Marie-Claire',
      lastName: 'Ngono',
      gender: 'F',
      birthDate: '2012-03-12',
      guardians: [
        {
          firstName: 'Pierre',
          lastName: 'Ngono',
          phone: '6 77 12 34 56',
          relationship: 'FATHER',
          isPrimary: true,
        },
      ],
    });
    expect(r.guardians[0]?.phone).toBe('+237677123456');
    expect(r.confirmNotDuplicate).toBe(false);
  });

  it('exige le numéro du payeur pour Mobile Money', () => {
    const r = paymentCreateSchema.safeParse({
      studentId: 's',
      amount: 35000,
      method: 'MTN_MOMO',
      idempotencyKey: '7b0c5d2e-6c51-4c43-9a0e-2f4b1c1e3a11',
    });
    expect(r.success).toBe(false);
  });

  it('refuse un montant décimal', () => {
    const r = paymentCreateSchema.safeParse({
      studentId: 's',
      amount: 100.5,
      method: 'CASH',
      idempotencyKey: '7b0c5d2e-6c51-4c43-9a0e-2f4b1c1e3a11',
    });
    expect(r.success).toBe(false);
  });

  it('refuse un appel sans élève', () => {
    expect(
      attendanceSubmitSchema.safeParse({
        classId: 'c',
        date: '2026-10-29',
        startTime: '07:30',
        endTime: '09:20',
        records: [],
      }).success,
    ).toBe(false);
  });
});
