import { z } from 'zod';
import { id, isoDate, timeOfDay } from './schemas';

/** Fichiers déposés : types autorisés, taille maximale, détection du type sur le contenu réel. */

export const ALLOWED_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number];

/** Taille maximale par défaut d'un fichier déposé : 10 Mo. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Valeur de l'attribut `accept` des champs de dépôt. */
export const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

export const FILE_TYPE_LABELS: Record<AllowedFileType, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'Photo JPEG',
  'image/png': 'Image PNG',
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/**
 * Type réel d'un fichier d'après ses premiers octets (signature), indépendamment de son nom et du
 * type annoncé par le navigateur. Renvoie `null` pour tout contenu non autorisé.
 */
export function detectFileType(bytes: Uint8Array): AllowedFileType | null {
  // %PDF- (la norme tolère quelques octets avant l'en-tête : on cherche dans les 1024 premiers).
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const window = Math.min(bytes.length - pdf.length, 1024);
  for (let i = 0; i <= window; i++) if (startsWith(bytes, pdf, i)) return 'application/pdf';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  return null;
}

export type FileCheck =
  | { ok: true; type: AllowedFileType }
  | { ok: false; reason: 'empty' | 'too_large' | 'type' };

/** Contrôle d'un fichier avant enregistrement : non vide, taille maximale, type autorisé. */
export function checkFile(bytes: Uint8Array, maxBytes = MAX_FILE_BYTES): FileCheck {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > maxBytes) return { ok: false, reason: 'too_large' };
  const type = detectFileType(bytes);
  return type ? { ok: true, type } : { ok: false, reason: 'type' };
}

export function fileCheckMessage(
  reason: 'empty' | 'too_large' | 'type',
  maxBytes = MAX_FILE_BYTES,
) {
  switch (reason) {
    case 'empty':
      return 'Le fichier est vide';
    case 'too_large':
      return `Fichier trop volumineux (${formatFileSize(maxBytes)} au maximum)`;
    case 'type':
      return 'Type de fichier refusé : PDF, JPEG ou PNG uniquement';
  }
}

/** Taille lisible en français : « 850 Ko », « 2,4 Mo ». */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  const mo = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `${String(mo).replace('.', ',')} Mo`;
}

/**
 * Nom de fichier assaini pour l'affichage et l'en-tête de téléchargement : sans chemin, sans
 * caractères de contrôle, 120 caractères au plus.
 */
export function sanitizeFileName(name: string | undefined, fallback = 'fichier'): string {
  const base = (name ?? '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    ?.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '');
  const clean = (base ?? '').trim().slice(-120);
  return clean.length > 0 && clean !== '.' && clean !== '..' ? clean : fallback;
}

// Cahier de texte et supports de cours

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const lessonLogSchema = z
  .object({
    classSubjectId: id,
    date: isoDate,
    startTime: timeOfDay.optional(),
    content: z.string().trim().min(3, 'Décrivez le contenu de la séance').max(4000),
    homework: optionalText(2000),
    homeworkDueDate: isoDate.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.homework && !v.homeworkDueDate)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['homeworkDueDate'],
        message: 'Indiquez pour quand le travail est à faire',
      });
    if (v.homeworkDueDate && !v.homework)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['homework'],
        message: 'Décrivez le travail à faire',
      });
    if (v.homeworkDueDate && v.homeworkDueDate < v.date)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['homeworkDueDate'],
        message: 'Le travail ne peut pas être dû avant la séance',
      });
  });
export type LessonLogInput = z.infer<typeof lessonLogSchema>;

export const lessonLogQuerySchema = z.object({
  classId: id.optional(),
  classSubjectId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const courseMaterialSchema = z.object({
  classSubjectId: id,
  lessonLogId: id.optional(),
  title: z.string().trim().min(2, 'Donnez un titre au support').max(120),
});
