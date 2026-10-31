import { z, type ZodErrorMap, type ZodIssue } from 'zod';

const THIN_SPACE = String.fromCharCode(0x202f);

/** 10000000 → « 10 000 000 » (espace fine insécable), comme les montants affichés. */
function groupDigits(n: number | bigint): string {
  const value = typeof n === 'bigint' ? n.toString() : String(n);
  if (!/^-?\d+$/.test(value)) return value.replace('.', ',');
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

const plural = (n: number | bigint, one: string, many: string) =>
  `${groupDigits(n)} ${Number(n) > 1 ? many : one}`;

/**
 * Messages de validation en français pour les contrôles qui n'ont pas de message propre (les
 * messages écrits dans les schémas restent prioritaires).
 */
export const frenchErrorMap: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null')
        return { message: 'Champ obligatoire' };
      if (issue.expected === 'number' || issue.expected === 'integer')
        return { message: 'Nombre attendu' };
      if (issue.expected === 'string') return { message: 'Texte attendu' };
      if (issue.expected === 'boolean') return { message: 'Oui ou non attendu' };
      if (issue.expected === 'array') return { message: 'Liste attendue' };
      return { message: 'Valeur invalide' };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'string')
        return {
          message:
            Number(issue.minimum) <= 1
              ? 'Champ obligatoire'
              : `${plural(issue.minimum, 'caractère', 'caractères')} au minimum`,
        };
      if (issue.type === 'number' || issue.type === 'bigint')
        return {
          message:
            Number(issue.minimum) === 0 && !issue.inclusive
              ? 'Doit être supérieur à 0'
              : issue.inclusive
                ? `Doit être au moins ${groupDigits(issue.minimum)}`
                : `Doit être supérieur à ${groupDigits(issue.minimum)}`,
        };
      if (issue.type === 'array')
        return { message: `${plural(issue.minimum, 'élément', 'éléments')} au minimum` };
      return { message: 'Valeur trop petite' };
    case z.ZodIssueCode.too_big:
      if (issue.type === 'string')
        return { message: `${plural(issue.maximum, 'caractère', 'caractères')} au maximum` };
      if (issue.type === 'number' || issue.type === 'bigint')
        return {
          message: issue.inclusive
            ? `Trop élevé (${groupDigits(issue.maximum)} au maximum)`
            : `Doit être inférieur à ${groupDigits(issue.maximum)}`,
        };
      if (issue.type === 'array')
        return { message: `${plural(issue.maximum, 'élément', 'éléments')} au maximum` };
      return { message: 'Valeur trop grande' };
    case z.ZodIssueCode.invalid_enum_value:
    case z.ZodIssueCode.invalid_literal:
    case z.ZodIssueCode.invalid_union:
    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: 'Valeur non autorisée' };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'Adresse e-mail invalide' };
      if (issue.validation === 'url') return { message: 'Adresse web invalide' };
      return { message: 'Format invalide' };
    case z.ZodIssueCode.invalid_date:
      return { message: 'Date invalide' };
    case z.ZodIssueCode.not_multiple_of:
      return { message: `Doit être un multiple de ${groupDigits(issue.multipleOf)}` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: 'Champ non attendu' };
    default:
      return {
        message: ctx.defaultError === 'Invalid input' ? 'Valeur invalide' : ctx.defaultError,
      };
  }
};

z.setErrorMap(frenchErrorMap);

/** Libellés des champs des formulaires, pour situer une erreur de validation. */
export const FIELD_LABELS: Record<string, string> = {
  accountNumber: 'Compte',
  amount: 'Montant',
  body: 'Message',
  city: 'Ville',
  code: 'Code',
  countedAmount: 'Montant compté',
  credit: 'Crédit',
  date: 'Date',
  debit: 'Débit',
  description: 'Description',
  dueDate: 'Échéance',
  email: 'Adresse e-mail',
  employeeId: 'Membre du personnel',
  endDate: 'Date de fin',
  firstMonth: 'Premier mois de retenue',
  firstName: 'Prénom',
  installments: 'Nombre de mensualités',
  journal: 'Journal',
  label: 'Libellé',
  lastName: 'Nom',
  lines: 'Lignes',
  matriculePrefix: 'Préfixe des matricules',
  method: 'Mode de règlement',
  name: 'Nom',
  note: 'Motif',
  password: 'Mot de passe',
  phone: 'Téléphone',
  pieceRef: 'Pièce de référence',
  quantity: 'Quantité',
  reason: 'Motif',
  reference: 'Référence',
  startDate: 'Date de début',
  studentId: 'Élève',
  supplierId: 'Fournisseur',
  supplierName: 'Fournisseur',
  title: 'Titre',
  unitCost: 'Coût unitaire',
  unitPrice: 'Prix unitaire',
};

/** « lines.1.debit » → « Ligne 2 · Débit » ; champ inconnu : rien. */
export function fieldLabel(path: readonly (string | number)[]): string | null {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next = path[i + 1];
    if (typeof key === 'string' && typeof next === 'number' && key === 'lines') {
      parts.push(`Ligne ${next + 1}`);
      i++;
      continue;
    }
    if (typeof key === 'number') {
      parts.push(`n° ${key + 1}`);
      continue;
    }
    const label = key ? FIELD_LABELS[key] : undefined;
    if (label) parts.push(label);
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Message lisible d'une erreur de validation : le champ et la raison de la première erreur,
 * puis le nombre d'autres erreurs (« Montant : trop élevé… (et 1 autre erreur) »).
 */
export function describeIssues(issues: readonly Pick<ZodIssue, 'path' | 'message'>[]): string {
  const first = issues[0];
  if (!first) return 'Données invalides';
  const label = fieldLabel(first.path);
  const others = issues.length - 1;
  const suffix = others > 0 ? ` (et ${plural(others, 'autre erreur', 'autres erreurs')})` : '';
  return `${label ? `${label} : ` : ''}${first.message}${suffix}`;
}
