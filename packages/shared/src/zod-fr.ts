import { z, ZodIssueCode, ZodParsedType, type ZodErrorMap } from 'zod';

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
              : `${Number(issue.minimum)} caractères minimum`,
        };
      if (issue.type === 'array')
        return {
          message:
            Number(issue.minimum) <= 1
              ? 'Choisissez au moins un élément'
              : `Choisissez au moins ${Number(issue.minimum)} éléments`,
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
            ? `Valeur minimale : ${Number(issue.minimum)}`
            : `La valeur doit dépasser ${Number(issue.minimum)}`,
        };
      }
      return { message: 'Valeur trop petite' };
    case ZodIssueCode.too_big:
      if (issue.type === 'string')
        return { message: `${Number(issue.maximum)} caractères au plus` };
      if (issue.type === 'array') return { message: `${Number(issue.maximum)} éléments au plus` };
      if (issue.type === 'number' || issue.type === 'bigint')
        return {
          message: issue.inclusive
            ? `Valeur maximale : ${Number(issue.maximum)}`
            : `La valeur doit rester sous ${Number(issue.maximum)}`,
        };
      return { message: 'Valeur trop grande' };
    case ZodIssueCode.invalid_enum_value:
    case ZodIssueCode.invalid_literal:
    case ZodIssueCode.invalid_union_discriminator:
      return { message: 'Choix invalide' };
    case ZodIssueCode.invalid_date:
      return { message: 'Date invalide' };
    case ZodIssueCode.not_multiple_of:
      return { message: `Multiple de ${Number(issue.multipleOf)} attendu` };
    case ZodIssueCode.unrecognized_keys:
      return { message: `Champ non reconnu : ${issue.keys.join(', ')}` };
    default:
      return { message: 'Valeur invalide' };
  }
};

z.setErrorMap(frenchErrorMap);
