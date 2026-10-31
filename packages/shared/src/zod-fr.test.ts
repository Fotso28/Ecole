import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  describeGuardian,
  enrollmentChangeSchema,
  foldForSearch,
  guardianInputSchema,
  isoDate,
  joinFrench,
  normalizeVerificationCode,
  sameGuardianName,
  searchWords,
  staffCreateSchema,
} from './index';

const messages = (r: z.SafeParseReturnType<unknown, unknown>) =>
  r.success ? [] : r.error.issues.map((i) => i.message);

describe('messages de validation en français', () => {
  it('remplace les messages par défaut de zod', () => {
    expect(messages(z.string().email().safeParse('jp.mballa@'))).toEqual([
      'Adresse e-mail invalide',
    ]);
    expect(messages(z.object({ a: z.string() }).safeParse({}))).toEqual(['Champ obligatoire']);
    expect(messages(z.string().min(5).safeParse('abc'))).toEqual(['5 caractères minimum']);
    expect(messages(z.string().max(3).safeParse('abcd'))).toEqual(['3 caractères au plus']);
    expect(messages(z.number().int().safeParse(1.5))).toEqual(['Nombre entier attendu']);
    expect(messages(z.number().max(10).safeParse(11))).toEqual(['Valeur maximale : 10']);
    expect(messages(z.number().nonnegative().safeParse(-1))).toEqual([
      'La valeur ne peut pas être négative',
    ]);
    expect(messages(z.enum(['F', 'M']).safeParse('X'))).toEqual(['Choix invalide']);
    expect(messages(z.array(z.string()).min(1).safeParse([]))).toEqual([
      'Choisissez au moins un élément',
    ]);
  });

  it('garde les messages propres aux schémas', () => {
    expect(messages(guardianInputSchema.shape.phone.safeParse('12345'))).toEqual([
      'Numéro de téléphone camerounais invalide',
    ]);
    const staff = staffCreateSchema.safeParse({
      firstName: 'A',
      lastName: 'B',
      email: 'pas-une-adresse',
      password: 'court',
      roles: ['TEACHER'],
    });
    expect(messages(staff)).toEqual(['Adresse e-mail invalide', '10 caractères minimum']);
    for (const m of messages(staff)) expect(m).not.toMatch(/Invalid|Required|Expected/);
  });

  it('signale une date vide comme champ obligatoire', () => {
    expect(messages(isoDate.safeParse(''))).toEqual(['Champ obligatoire']);
    expect(messages(isoDate.safeParse('2026-02-30'))).toEqual(['Date invalide']);
    expect(messages(isoDate.safeParse('30/10/2026'))).toEqual([
      'Date attendue au format AAAA-MM-JJ',
    ]);
  });
});

describe('recherche et désignation des personnes', () => {
  it('replie accents et casse, et découpe la recherche en mots', () => {
    expect(foldForSearch('Cédric ÉKOTTO Aurélie Grâce Œuvre')).toBe(
      'cedric ekotto aurelie grace oeuvre',
    );
    expect(foldForSearch('N’Goran')).toBe("n'goran");
    expect(searchWords('  Mballa   Aurélie ')).toEqual(['mballa', 'aurelie']);
    expect(searchWords('   ')).toEqual([]);
  });

  it('reconnaît le même parent malgré accents, casse et ordre des mots', () => {
    expect(
      sameGuardianName(
        { firstName: 'Pierre', lastName: 'Ngono' },
        { firstName: 'NGONO', lastName: 'pierre' },
      ),
    ).toBe(true);
    expect(
      sameGuardianName(
        { firstName: 'Thérèse', lastName: 'Abéna' },
        { firstName: 'Therese', lastName: 'Abena' },
      ),
    ).toBe(true);
    expect(
      sameGuardianName(
        { firstName: 'Jacques', lastName: 'Ngono' },
        { firstName: 'Pierre', lastName: 'Ngono' },
      ),
    ).toBe(false);
  });

  it('désigne un parent par son nom et ceux de ses enfants', () => {
    expect(joinFrench([])).toBe('');
    expect(joinFrench(['A'])).toBe('A');
    expect(joinFrench(['A', 'B', 'C'])).toBe('A, B et C');
    expect(
      describeGuardian({
        firstName: 'Pierre',
        lastName: 'Ngono',
        children: [
          { firstName: 'Marie-Claire', lastName: 'NGONO' },
          { firstName: 'Paul-Henri', lastName: 'Ngono' },
          { firstName: 'Junior', lastName: 'Abena' },
        ],
      }),
    ).toBe('Pierre Ngono (parent de Marie-Claire, Paul-Henri et Junior Abena)');
    expect(describeGuardian({ firstName: 'Rose', lastName: 'Bilong', children: [] })).toBe(
      'Rose Bilong',
    );
  });

  it('normalise un code de vérification recopié à la main', () => {
    expect(normalizeVerificationCode(' mxhe rzzb-6pem ')).toBe('MXHERZZB6PEM');
    expect(normalizeVerificationCode('MXHERZZB6PEM')).toBe('MXHERZZB6PEM');
  });
});

describe('changement d’inscription', () => {
  it('exige date, motif et établissement d’accueil pour un transfert', () => {
    const r = enrollmentChangeSchema.safeParse({ status: 'TRANSFERRED' });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['exitDate', 'Champ obligatoire'],
      ['exitReason', 'Motif obligatoire (3 caractères minimum)'],
      ['destinationSchool', 'Indiquez l’établissement d’accueil'],
    ]);
    expect(
      enrollmentChangeSchema.safeParse({
        status: 'LEFT',
        exitDate: '2026-10-30',
        exitReason: 'Déménagement',
      }).success,
    ).toBe(true);
    expect(enrollmentChangeSchema.safeParse({ classId: 'c1' }).success).toBe(true);
    expect(enrollmentChangeSchema.safeParse({}).success).toBe(false);
    expect(
      enrollmentChangeSchema.safeParse({
        status: 'LEFT',
        classId: 'c1',
        exitDate: '2026-10-30',
        exitReason: 'Déménagement',
      }).success,
    ).toBe(false);
  });
});
