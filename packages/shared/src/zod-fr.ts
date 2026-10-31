import { z, ZodIssueCode, ZodParsedType, type ZodErrorMap, type ZodIssue } from 'zod';

const THIN_SPACE = String.fromCharCode(0x202f);

/** 10000000 → « 10 000 000 » (espace fine insécable), comme les montants affichés. */
function groupDigits(n: number | bigint): string {
  const value = typeof n === 'bigint' ? n.toString() : String(n);
  if (!/^-?\d+$/.test(value)) return value.replace('.', ',');
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

const plural = (n: number | bigint, one: string, many: string) =>
  `${groupDigits(n)} ${Number(n) > 1 ? many : one}`;

const TYPE_LABELS: Partial<Record<string, string>> = {
  [ZodParsedType.string]: 'Texte attendu',
  [ZodParsedType.number]: 'Nombre attendu',
  [ZodParsedType.integer]: 'Nombre entier attendu',
  [ZodParsedType.boolean]: 'Réponse oui ou non attendue',
  [ZodParsedType.date]: 'Date attendue',
  [ZodParsedType.array]: 'Liste attendue',
  [ZodParsedType.object]: 'Données attendues',
};

/**
 * Messages de validation en français, communs à l'API et au site. Un message propre au schéma
 * (« Numéro de téléphone camerounais invalide »…) reste prioritaire ; ce sont les messages par
 * défaut de zod (« Invalid email », « Required »…) qui sont remplacés.
 */
export const frenchErrorMap: ZodErrorMap = (issue) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined || issue.received === ZodParsedType.null)
        return { message: 'Champ obligatoire' };
      return { message: TYPE_LABELS[issue.expected] ?? 'Valeur invalide' };
    case ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'Adresse e-mail invalide' };
      if (issue.validation === 'url') return { message: 'Adresse web invalide' };
      if (issue.validation === 'date' || issue.validation === 'datetime')
        return { message: 'Date invalide' };
      return { message: 'Format invalide' };
    case ZodIssueCode.too_small:
      if (issue.type === 'string')
        return {
          message:
            Number(issue.minimum) <= 1
              ? 'Champ obligatoire'
              : `${groupDigits(issue.minimum)} caractères minimum`,
        };
      if (issue.type === 'array')
        return {
          message:
            Number(issue.minimum) <= 1
              ? 'Choisissez au moins un élément'
              : `Choisissez au moins ${groupDigits(issue.minimum)} éléments`,
        };
      if (issue.type === 'number' || issue.type === 'bigint') {
        if (Number(issue.minimum) === 0)
          return {
            message: issue.inclusive
              ? 'La valeur ne peut pas être négative'
              : 'La valeur doit être positive',
          };
        return {
          message: issue.inclusive
            ? `Valeur minimale : ${groupDigits(issue.minimum)}`
            : `La valeur doit dépasser ${groupDigits(issue.minimum)}`,
        };
      }
      return { message: 'Valeur trop petite' };
    case ZodIssueCode.too_big:
      if (issue.type === 'string')
        return { message: `${groupDigits(issue.maximum)} caractères au plus` };
      if (issue.type === 'array')
        return { message: `${groupDigits(issue.maximum)} éléments au plus` };
      if (issue.type === 'number' || issue.type === 'bigint')
        return {
          message: issue.inclusive
            ? `Valeur maximale : ${groupDigits(issue.maximum)}`
            : `La valeur doit rester sous ${groupDigits(issue.maximum)}`,
        };
      return { message: 'Valeur trop grande' };
    case ZodIssueCode.invalid_enum_value:
    case ZodIssueCode.invalid_literal:
    case ZodIssueCode.invalid_union_discriminator:
      return { message: 'Choix invalide' };
    case ZodIssueCode.invalid_date:
      return { message: 'Date invalide' };
    case ZodIssueCode.not_multiple_of:
      return { message: `Multiple de ${groupDigits(issue.multipleOf)} attendu` };
    case ZodIssueCode.unrecognized_keys:
      return { message: `Champ non reconnu : ${issue.keys.join(', ')}` };
    default:
      return { message: 'Valeur invalide' };
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
