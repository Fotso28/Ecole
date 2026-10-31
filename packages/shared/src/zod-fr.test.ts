import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { expenseCreateSchema, manualEntrySchema } from './accounting';
import { describeIssues, fieldLabel } from './zod-fr';
import './schemas';

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

describe('messages de validation en français', () => {
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
      '5 caractères au maximum',
      'Trop élevé (10 au maximum)',
      'Valeur non autorisée',
      'Adresse e-mail invalide',
      '1 élément au minimum',
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
    expect(describeIssues(entry)).toBe('Libellé : 2 caractères au minimum (et 1 autre erreur)');
    expect(fieldLabel(['lines', 0, 'debit'])).toBe('Ligne 1 · Débit');
    expect(fieldLabel(['inconnu'])).toBeNull();
    expect(describeIssues([])).toBe('Données invalides');
    expect(describeIssues([{ path: ['inconnu'], message: 'Valeur invalide' }])).toBe(
      'Valeur invalide',
    );
  });
});
