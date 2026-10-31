import { z } from 'zod';
import { isoDate } from './schemas';

/** Secrétariat et vie scolaire : documents administratifs, registre des incidents, réinscriptions. */

const id = z.string().min(1);

// Registre des incidents
export const INCIDENT_TYPES = [
  'INDISCIPLINE',
  'INSOLENCE',
  'VIOLENCE',
  'FRAUD',
  'DAMAGE',
  'TRUANCY',
  'DRESS_CODE',
  'OTHER',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  INDISCIPLINE: 'Indiscipline',
  INSOLENCE: 'Insolence',
  VIOLENCE: 'Violence',
  FRAUD: 'Fraude',
  DAMAGE: 'Dégradation',
  TRUANCY: 'École buissonnière',
  DRESS_CODE: 'Tenue',
  OTHER: 'Autre',
};

export const SANCTION_TYPES = [
  'NONE',
  'WARNING',
  'DETENTION',
  'BLAME',
  'TEMPORARY_EXCLUSION',
  'DISCIPLINARY_COUNCIL',
  'PERMANENT_EXCLUSION',
  'OTHER',
] as const;
export type SanctionType = (typeof SANCTION_TYPES)[number];

export const SANCTION_TYPE_LABELS: Record<SanctionType, string> = {
  NONE: 'Aucune sanction',
  WARNING: 'Avertissement',
  DETENTION: 'Consigne',
  BLAME: 'Blâme',
  TEMPORARY_EXCLUSION: 'Exclusion temporaire',
  DISCIPLINARY_COUNCIL: 'Conseil de discipline',
  PERMANENT_EXCLUSION: 'Exclusion définitive',
  OTHER: 'Autre sanction',
};

/** Date du jour au Cameroun (UTC+1, sans heure d'été), au format AAAA-MM-JJ. */
export function cameroonToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 3_600_000).toISOString().slice(0, 10);
}

/** Date d'un fait déjà survenu : aujourd'hui au plus tard (heure du Cameroun). */
export const pastOrTodayDate = isoDate.refine((d) => d <= cameroonToday(), {
  message: 'La date ne peut pas être dans le futur',
});

/** Signalement ou correction d'un incident (la correction reprend tous les champs). */
export const incidentCreateSchema = z.object({
  studentId: id,
  date: pastOrTodayDate,
  type: z.enum(INCIDENT_TYPES).default('OTHER'),
  description: z.string().trim().min(3, 'Décrivez l’incident (3 caractères minimum)').max(1000),
  sanctionType: z.enum(SANCTION_TYPES).default('NONE'),
  sanction: z.string().trim().max(300).optional(),
});

export const incidentFilterSchema = z
  .object({
    classId: id.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    type: z.enum(INCIDENT_TYPES).optional(),
    sanctionType: z.enum(SANCTION_TYPES).optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    path: ['to'],
    message: 'La date de fin précède la date de début',
  });

export interface IncidentStatRow {
  studentId: string;
  type: string;
  sanctionType: string;
  /** Date ISO (AAAA-MM-JJ). */
  date: string;
}

export interface IncidentStats {
  total: number;
  students: number;
  /** Élèves ayant reçu au moins une sanction (jamais plus que `students`). */
  sanctioned: number;
  byType: { type: string; count: number }[];
  bySanction: { sanctionType: string; count: number }[];
  /** Mois (AAAA-MM) dans l'ordre chronologique. */
  byMonth: { month: string; count: number }[];
  /** Élèves les plus souvent signalés (au moins deux incidents), cinq au plus. */
  repeatStudents: { studentId: string; count: number }[];
}

function countBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(key(r), (map.get(key(r)) ?? 0) + 1);
  return map;
}

/** Tri décroissant par effectif, puis par clé pour un ordre stable. */
const byCount = (a: [string, number], b: [string, number]) =>
  b[1] - a[1] || a[0].localeCompare(b[0]);

/** Statistiques simples du registre : volumes par type, sanction, mois et récidives. */
export function summarizeIncidents(rows: readonly IncidentStatRow[]): IncidentStats {
  const perStudent = countBy(rows, (r) => r.studentId);
  return {
    total: rows.length,
    students: perStudent.size,
    sanctioned: new Set(rows.filter((r) => r.sanctionType !== 'NONE').map((r) => r.studentId)).size,
    byType: [...countBy(rows, (r) => r.type)]
      .sort(byCount)
      .map(([type, count]) => ({ type, count })),
    bySanction: [...countBy(rows, (r) => r.sanctionType)]
      .sort(byCount)
      .map(([sanctionType, count]) => ({ sanctionType, count })),
    byMonth: [...countBy(rows, (r) => r.date.slice(0, 7))]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, count]) => ({ month, count })),
    repeatStudents: [...perStudent]
      .filter(([, count]) => count >= 2)
      .sort(byCount)
      .slice(0, 5)
      .map(([studentId, count]) => ({ studentId, count })),
  };
}

// Documents administratifs
export const ADMIN_DOCUMENT_TYPES = [
  'SCHOOL_CERTIFICATE',
  'ENROLLMENT_ATTESTATION',
  'STUDENT_CARD',
] as const;
export type AdminDocumentType = (typeof ADMIN_DOCUMENT_TYPES)[number];

export const ADMIN_DOCUMENT_LABELS: Record<AdminDocumentType, string> = {
  SCHOOL_CERTIFICATE: 'Certificat de scolarité',
  ENROLLMENT_ATTESTATION: 'Attestation d’inscription',
  STUDENT_CARD: 'Carte d’élève',
};

/** Accord du participe selon le genre du document : « Certificat annulé », « Carte annulée ». */
export const ADMIN_DOCUMENT_FEMININE: Record<AdminDocumentType, boolean> = {
  SCHOOL_CERTIFICATE: false,
  ENROLLMENT_ATTESTATION: true,
  STUDENT_CARD: true,
};

/** Préfixe du numéro d'enregistrement, par type de document. */
export const ADMIN_DOCUMENT_PREFIXES: Record<AdminDocumentType, string> = {
  SCHOOL_CERTIFICATE: 'CS',
  ENROLLMENT_ATTESTATION: 'AI',
  STUDENT_CARD: 'CE',
};

export interface DocumentTemplateContent {
  title: string;
  headerLines: string[];
  signatoryName: string | null;
  signatoryTitle: string;
  mentions: string;
}

/** Modèle par défaut, utilisé tant que l'école n'a pas personnalisé le sien. */
export const DEFAULT_DOCUMENT_TEMPLATES: Record<AdminDocumentType, DocumentTemplateContent> = {
  SCHOOL_CERTIFICATE: {
    title: 'CERTIFICAT DE SCOLARITÉ',
    headerLines: [],
    signatoryName: null,
    signatoryTitle: 'Le Chef d’établissement',
    mentions:
      'En foi de quoi, le présent certificat lui est délivré pour servir et valoir ce que de droit.',
  },
  ENROLLMENT_ATTESTATION: {
    title: 'ATTESTATION D’INSCRIPTION',
    headerLines: [],
    signatoryName: null,
    signatoryTitle: 'Le Chef d’établissement',
    mentions:
      'La présente attestation est délivrée à l’intéressé(e) pour servir et valoir ce que de droit.',
  },
  STUDENT_CARD: {
    title: 'CARTE D’ÉLÈVE',
    headerLines: [],
    signatoryName: null,
    signatoryTitle: 'Le Chef d’établissement',
    mentions: 'Carte strictement personnelle, à présenter à toute réquisition.',
  },
};

/** Numéro lisible et unique dans l'école : CS-2026-2027-0007. */
export function formatDocumentNumber(
  type: AdminDocumentType,
  yearName: string,
  sequence: number,
): string {
  return `${ADMIN_DOCUMENT_PREFIXES[type]}-${yearName}-${String(sequence).padStart(4, '0')}`;
}

/** Clé du compteur : une série par type et par année scolaire. */
export function documentCounterKey(type: AdminDocumentType, academicYearId: string): string {
  return `document:${type}:${academicYearId}`;
}

export const documentIssueSchema = z.object({
  studentId: id,
  type: z.enum(ADMIN_DOCUMENT_TYPES),
});
export const documentCancelSchema = z.object({
  reason: z.string().trim().min(5, 'Motif obligatoire (5 caractères minimum)').max(300),
});
export const documentListSchema = z.object({
  type: z.enum(ADMIN_DOCUMENT_TYPES).optional(),
  status: z.enum(['ISSUED', 'CANCELLED']).optional(),
  studentId: id.optional(),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
export const documentTemplateSchema = z.object({
  title: optionalText(80),
  headerLines: z.array(z.string().trim().max(100)).max(6).default([]),
  signatoryName: optionalText(80),
  signatoryTitle: optionalText(80),
  mentions: optionalText(600),
});

// Réinscriptions de rentrée
export const REENROLLMENT_DECISIONS = ['PROMOTED', 'REPEATING', 'LEFT'] as const;
export type ReenrollmentDecision = (typeof REENROLLMENT_DECISIONS)[number];

export const REENROLLMENT_LABELS: Record<ReenrollmentDecision, string> = {
  PROMOTED: 'Admis',
  REPEATING: 'Redoublant',
  LEFT: 'Sortant',
};

export const reenrollmentSchema = z.object({
  fromYearId: id,
  items: z
    .array(
      z
        .object({
          studentId: id,
          decision: z.enum(REENROLLMENT_DECISIONS),
          classId: id.optional(),
        })
        .refine((v) => v.decision === 'LEFT' || !!v.classId, {
          path: ['classId'],
          message: 'Classe d’arrivée obligatoire',
        }),
    )
    .min(1, 'Aucun élève sélectionné')
    .max(500),
});

/**
 * Proposition de réinscription à partir d'une décision du conseil de classe. Les décisions
 * inconnues (types ajoutés plus tard, distinctions trimestrielles) ne préremplissent rien :
 * le secrétariat choisit alors lui-même.
 */
export function suggestReenrollment(
  decision: string | null | undefined,
): ReenrollmentDecision | null {
  if (!decision) return null;
  const d = decision
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  if (/REDOUBL|REPEAT|RETAIN/.test(d)) return 'REPEATING';
  if (/EXCLU|EXPEL|DISMISS|SORTI|SORTANT|LEFT|LEAV|TRANSFER|RENVOI|DEPART/.test(d)) return 'LEFT';
  if (/PROMO|ADMIS|ADMIT|PASS/.test(d)) return 'PROMOTED';
  return null;
}

export interface ClassRef {
  id: string;
  name: string;
  levelId: string;
  levelName: string;
  levelOrder: number;
}

/** Suffixe de la classe une fois le niveau retiré : « 4e A » → « A », « 2nde C » → « C ». */
function classSuffix(c: ClassRef): string {
  const name = c.name.trim();
  const stripped = name.toLowerCase().startsWith(c.levelName.toLowerCase())
    ? name.slice(c.levelName.length)
    : name;
  return stripped.trim().toUpperCase();
}

const byName = (a: ClassRef, b: ClassRef) => a.name.localeCompare(b.name, 'fr');

/** Classe d'arrivée proposée pour un élève admis : niveau suivant, même suffixe si possible. */
export function suggestPromotionClass(
  source: ClassRef,
  targets: readonly ClassRef[],
): string | null {
  const higher = targets.filter((t) => t.levelOrder > source.levelOrder);
  if (higher.length === 0) return null;
  const nextOrder = Math.min(...higher.map((t) => t.levelOrder));
  const candidates = higher.filter((t) => t.levelOrder === nextOrder).sort(byName);
  const suffix = classSuffix(source);
  return (candidates.find((t) => classSuffix(t) === suffix) ?? candidates[0])?.id ?? null;
}

/** Classe proposée pour un redoublant : même nom l'année suivante, sinon même niveau. */
export function suggestRepeatClass(source: ClassRef, targets: readonly ClassRef[]): string | null {
  const sameName = targets.find(
    (t) => t.name.trim().toUpperCase() === source.name.trim().toUpperCase(),
  );
  if (sameName) return sameName.id;
  return [...targets].filter((t) => t.levelId === source.levelId).sort(byName)[0]?.id ?? null;
}
