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
import { expenseCreateSchema, manualEntrySchema } from './accounting';
import { describeIssues, fieldLabel } from './zod-fr';

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

const issues = (schema: z.ZodTypeAny, value: unknown) => {
  const r = schema.safeParse(value);
  if (r.success) throw new Error('validation attendue en échec');
  return r.error.issues;
};

const expense = {
  supplierName: 'Librairie Saint-Paul',
  date: '2026-10-31',
  label: 'Ramette de papier A4',
  amount: 3500,
  accountNumber: '6055',
  method: 'CASH',
  pieceRef: 'FAC-LSP-0458',
};

describe('messages de validation : champ et raison', () => {
  it('traduit les contrôles sans message propre', () => {
    const schema = z.object({
      name: z.string().min(2).max(5),
      count: z.number().int().min(1).max(10),
      kind: z.enum(['A', 'B']),
      email: z.string().email(),
      tags: z.array(z.string()).min(1),
    });
    const messages = issues(schema, {
      name: 'abcdefgh',
      count: 12,
      kind: 'C',
      email: 'x',
      tags: [],
    }).map((i) => i.message);
    expect(messages).toEqual([
      '5 caractères au plus',
      'Valeur maximale : 10',
      'Choix invalide',
      'Adresse e-mail invalide',
      'Choisissez au moins un élément',
    ]);
    expect(issues(schema, {}).map((i) => i.message)).toEqual(Array(5).fill('Champ obligatoire'));
    expect(issues(z.string().min(1), '')[0]?.message).toBe('Champ obligatoire');
    expect(issues(z.number(), 'abc')[0]?.message).toBe('Nombre attendu');
  });

  it('garde les messages écrits dans les schémas', () => {
    expect(issues(expenseCreateSchema, { ...expense, amount: 0 })[0]?.message).toBe(
      'Le montant doit être positif',
    );
  });

  it('situe l’erreur : champ et raison, au lieu de « Données invalides »', () => {
    // Montant collé à la saisie précédente (45000 puis 350000).
    expect(describeIssues(issues(expenseCreateSchema, { ...expense, amount: 45000350000 }))).toBe(
      'Montant : Montant trop élevé (1 000 000 000 FCFA au plus)',
    );
    expect(describeIssues(issues(expenseCreateSchema, { ...expense, pieceRef: '' }))).toBe(
      'Pièce de référence : Champ obligatoire',
    );
    const entry = issues(manualEntrySchema, {
      journal: 'CA',
      date: '2026-10-31',
      label: 'x',
      lines: [
        { accountNumber: '658', debit: 1.5 },
        { accountNumber: '571', credit: 1 },
      ],
    });
    expect(describeIssues(entry)).toBe('Libellé : 2 caractères minimum (et 1 autre erreur)');
    expect(fieldLabel(['lines', 0, 'debit'])).toBe('Ligne 1 · Débit');
    expect(fieldLabel(['inconnu'])).toBeNull();
    expect(describeIssues([])).toBe('Données invalides');
    expect(describeIssues([{ path: ['inconnu'], message: 'Valeur invalide' }])).toBe(
      'Valeur invalide',
    );
  });
});
