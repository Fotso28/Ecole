/** Numéros de téléphone camerounais, noms et matricules. */

const CM_PREFIX = '237';

/**
 * Normalise un numéro camerounais au format E.164 (+2376XXXXXXXX).
 * Accepte « 6 77 12 34 56 », « 677123456 », « +237 677 12 34 56 », « 00237677123456 ».
 * Renvoie `null` si le numéro n'est pas un numéro camerounais à 9 chiffres.
 */
export function normalizeCameroonPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/[\s.\-()]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12 && digits.startsWith(CM_PREFIX)) digits = digits.slice(3);
  if (digits.length !== 9) return null;
  // Mobiles : 6XXXXXXXX ; fixes : 2XXXXXXXX.
  if (!/^[62]/.test(digits)) return null;
  return `+${CM_PREFIX}${digits}`;
}

/** +237677123456 → « 6 77 12 34 56 ». */
export function formatCameroonPhone(e164: string): string {
  const local = e164.replace(/^\+237/, '');
  if (!/^\d{9}$/.test(local)) return e164;
  return `${local[0]} ${local.slice(1, 3)} ${local.slice(3, 5)} ${local.slice(5, 7)} ${local.slice(7, 9)}`;
}

/** Supprime accents, ponctuation et casse pour comparer des noms. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Distance de Levenshtein classique. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** Similarité entre 0 et 1, insensible à l'ordre des mots (« Marie Claire NGONO » = « Ngono Marie-Claire »). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a).split(' ').sort().join(' ');
  const nb = normalizeName(b).split(' ').sort().join(' ');
  const max = Math.max(na.length, nb.length);
  if (max === 0) return 1;
  return 1 - levenshtein(na, nb) / max;
}

export interface DuplicateCandidateInput {
  fullName: string;
  /** Date ISO AAAA-MM-JJ. */
  birthDate: string;
  birthPlace?: string | null;
  guardianPhones?: readonly string[];
}

export type DuplicateReason =
  | 'same_name'
  | 'similar_name'
  | 'same_birth_date'
  | 'same_birth_place'
  | 'same_guardian_phone';

export interface DuplicateAssessment {
  score: number;
  reasons: DuplicateReason[];
  isLikelyDuplicate: boolean;
}

/**
 * Évalue si deux dossiers désignent probablement le même enfant.
 * Un doublon probable exige un nom proche ET au moins un autre indice
 * (même date de naissance ou même téléphone de parent).
 */
export function assessDuplicate(
  a: DuplicateCandidateInput,
  b: DuplicateCandidateInput,
): DuplicateAssessment {
  const reasons: DuplicateReason[] = [];
  let score = 0;
  const sim = nameSimilarity(a.fullName, b.fullName);
  if (sim === 1) {
    reasons.push('same_name');
    score += 50;
  } else if (sim >= 0.85) {
    reasons.push('similar_name');
    score += 35;
  }
  if (a.birthDate === b.birthDate) {
    reasons.push('same_birth_date');
    score += 30;
  }
  if (a.birthPlace && b.birthPlace && normalizeName(a.birthPlace) === normalizeName(b.birthPlace)) {
    reasons.push('same_birth_place');
    score += 10;
  }
  const phonesA = new Set((a.guardianPhones ?? []).map(normalizeCameroonPhone).filter(Boolean));
  const sharedPhone = (b.guardianPhones ?? []).some((p) => {
    const n = normalizeCameroonPhone(p);
    return n !== null && phonesA.has(n);
  });
  if (sharedPhone) {
    reasons.push('same_guardian_phone');
    score += 30;
  }
  const nameMatches = sim >= 0.85;
  const corroborated =
    reasons.includes('same_birth_date') || reasons.includes('same_guardian_phone');
  return { score, reasons, isLikelyDuplicate: nameMatches && corroborated };
}

/** CD + 2026 + 19 → « CD-2026-0019 ». */
export function formatMatricule(prefix: string, year: number, sequence: number): string {
  if (!/^[A-Z0-9]{1,6}$/.test(prefix)) throw new RangeError('Préfixe de matricule invalide');
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new RangeError('Année invalide');
  if (!Number.isInteger(sequence) || sequence <= 0) throw new RangeError('Séquence invalide');
  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`;
}

/** Initiales pour les avatars : « Ngono Marie-Claire » → « NM ». */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
