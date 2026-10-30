import { z } from 'zod';
import { PAYMENT_METHODS } from './finance';
import { normalizeCameroonPhone } from './identity';
import { STAFF_ROLES } from './permissions';
import { YEAR_END_DECISIONS } from './results';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ')
  .refine(
    (s) =>
      !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) &&
      new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
    'Date invalide',
  );
export const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Heure attendue au format HH:MM');
export const id = z.string().min(1);

export const cameroonPhone = z.string().transform((v, ctx) => {
  const n = normalizeCameroonPhone(v);
  if (!n) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Numéro de téléphone camerounais invalide',
    });
    return z.NEVER;
  }
  return n;
});

const name = z.string().trim().min(1, 'Champ obligatoire').max(80);
const amount = z.number().int('Montant entier en FCFA').nonnegative();
const positiveAmount = z
  .number()
  .int('Montant entier en FCFA')
  .positive('Le montant doit être positif');

// Authentification
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide'),
  password: z.string().min(1, 'Mot de passe obligatoire'),
});
export const mfaVerifySchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Code à 6 chiffres'),
});
export const otpRequestSchema = z.object({ phone: cameroonPhone });
export const otpVerifySchema = z.object({
  phone: cameroonPhone,
  code: z.string().regex(/^\d{6}$/, 'Code à 6 chiffres'),
});
export const switchSchoolSchema = z.object({ schoolId: id });

// Plateforme
export const schoolCreateSchema = z.object({
  name: name,
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'Identifiant : minuscules, chiffres et tirets'),
  city: name,
  matriculePrefix: z
    .string()
    .regex(/^[A-Z0-9]{1,6}$/, 'Préfixe : 1 à 6 lettres majuscules ou chiffres'),
  director: z.object({
    firstName: name,
    lastName: name,
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(10, '10 caractères minimum'),
  }),
});

// Personnel
export const staffCreateSchema = z.object({
  firstName: name,
  lastName: name,
  email: z.string().trim().toLowerCase().email(),
  phone: cameroonPhone.optional(),
  password: z.string().min(10, '10 caractères minimum'),
  roles: z.array(z.enum(STAFF_ROLES)).min(1, 'Au moins un rôle'),
  maxWeeklyHours: z.number().int().positive().max(60).optional(),
});
export const staffRolesSchema = z.object({ roles: z.array(z.enum(STAFF_ROLES)).min(1) });

// Structure académique
export const academicYearCreateSchema = z
  .object({
    name: z.string().regex(/^\d{4}-\d{4}$/, 'Format AAAA-AAAA'),
    startDate: isoDate,
    endDate: isoDate,
  })
  .refine((v) => v.startDate < v.endDate, {
    message: 'La fin doit suivre le début',
    path: ['endDate'],
  });
export const termCreateSchema = z.object({
  academicYearId: id,
  name: name,
  order: z.number().int().min(1).max(6),
  startDate: isoDate,
  endDate: isoDate,
  sequences: z.array(z.object({ name: name, order: z.number().int().min(1).max(12) })).default([]),
});
export const cycleCreateSchema = z.object({ name: name, order: z.number().int().min(1) });
export const levelCreateSchema = z.object({
  cycleId: id,
  name: name,
  order: z.number().int().min(1),
});
export const classCreateSchema = z.object({
  academicYearId: id,
  levelId: id,
  name: z.string().trim().min(1).max(20),
  capacity: z.number().int().positive().max(200).optional(),
  mainTeacherId: id.optional(),
});
export const SUBJECT_GROUPS = ['LITERARY', 'SCIENTIFIC', 'OTHER'] as const;
export const subjectCreateSchema = z.object({
  name: name,
  code: z.string().regex(/^[A-Z0-9-]{2,12}$/),
  group: z.enum(SUBJECT_GROUPS),
});
export const classSubjectCreateSchema = z.object({
  classId: id,
  subjectId: id,
  coefficient: z.number().int().min(1).max(10),
  teacherId: id.optional(),
  weeklyHours: z.number().int().min(0).max(20).optional(),
});

// Élèves
export const GENDERS = ['F', 'M'] as const;
export const GUARDIAN_RELATIONSHIPS = ['FATHER', 'MOTHER', 'TUTOR', 'OTHER'] as const;
export const guardianInputSchema = z.object({
  firstName: name,
  lastName: name,
  phone: cameroonPhone,
  email: z.string().trim().toLowerCase().email().optional(),
  relationship: z.enum(GUARDIAN_RELATIONSHIPS),
  isPrimary: z.boolean().default(false),
  isEmergencyContact: z.boolean().default(false),
  canPickUp: z.boolean().default(true),
});
export const studentCreateSchema = z.object({
  firstName: name,
  lastName: name,
  gender: z.enum(GENDERS),
  birthDate: isoDate,
  birthPlace: z.string().trim().max(80).optional(),
  nationality: z.string().trim().max(60).default('Camerounaise'),
  photoConsent: z.boolean().default(false),
  previousSchool: z.string().trim().max(120).optional(),
  guardians: z.array(guardianInputSchema).min(1, 'Au moins un parent ou tuteur').max(4),
  classId: id.optional(),
  confirmNotDuplicate: z.boolean().default(false),
});
export const studentUpdateSchema = z.object({
  firstName: name.optional(),
  lastName: name.optional(),
  gender: z.enum(GENDERS).optional(),
  birthDate: isoDate.optional(),
  birthPlace: z.string().trim().max(80).optional(),
  nationality: z.string().trim().max(60).optional(),
  photoConsent: z.boolean().optional(),
});
export const duplicateCheckSchema = z.object({
  firstName: name,
  lastName: name,
  birthDate: isoDate,
  birthPlace: z.string().optional(),
  guardianPhones: z.array(z.string()).default([]),
});
export const ENROLLMENT_STATUSES = ['ENROLLED', 'REPEATING', 'TRANSFERRED', 'LEFT'] as const;
export const enrollmentCreateSchema = z.object({
  studentId: id,
  classId: id,
  status: z.enum(['ENROLLED', 'REPEATING']).default('ENROLLED'),
});
export const studentImportSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  classId: id.optional(),
  dryRun: z.boolean().default(true),
});

// Présences
export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LATE'] as const;
export const attendanceSubmitSchema = z.object({
  classId: id,
  classSubjectId: id.optional(),
  date: isoDate,
  startTime: timeOfDay,
  endTime: timeOfDay,
  records: z.array(z.object({ studentId: id, status: z.enum(ATTENDANCE_STATUSES) })).min(1),
});
export const justificationCreateSchema = z.object({
  studentId: id,
  recordIds: z.array(id).min(1),
  reason: z.string().trim().min(3).max(500),
});
export const justificationReviewSchema = z.object({ decision: z.enum(['ACCEPTED', 'REJECTED']) });

// Notes
export const EVALUATION_TYPES = ['QUIZ', 'HOMEWORK', 'EXAM'] as const;
export const evaluationCreateSchema = z.object({
  classSubjectId: id,
  sequenceId: id,
  name: z.string().trim().min(1).max(60),
  type: z.enum(EVALUATION_TYPES),
  weight: z.number().int().min(1).max(10),
  maxScore: z.number().int().min(1).max(100).default(20),
  date: isoDate.optional(),
});
export const gradesUpsertSchema = z.object({
  grades: z.array(z.object({ studentId: id, value: z.string().max(10) })).min(1),
});
export const reportCardGenerateSchema = z.object({ classId: id, termId: id });
/** Motif obligatoire pour publier des bulletins malgré des saisies manquantes. */
export const reportCardPublishSchema = reportCardGenerateSchema.extend({
  overrideReason: z.string().trim().min(10).max(300).optional(),
});
export const councilDecisionSchema = z.object({
  decision: z.enum(['HONOR_ROLL', 'ENCOURAGEMENT', 'WARNING', 'BLAME', 'NONE']),
  comment: z.string().trim().max(300).optional(),
  /** Décision de fin d'année, réservée au dernier trimestre ; `null` l'efface. */
  yearEndDecision: z.enum(YEAR_END_DECISIONS).nullable().optional(),
});
/** Relevé de notes : séquence ou trimestre (identifiant obligatoire), ou année (courante par défaut). */
export const transcriptQuerySchema = z
  .object({
    scope: z.enum(['sequence', 'term', 'year']),
    periodId: id.optional(),
  })
  .refine((q) => q.scope === 'year' || !!q.periodId, {
    message: 'Période obligatoire pour une séquence ou un trimestre',
    path: ['periodId'],
  });

// Finance
export const feeItemCreateSchema = z.object({
  academicYearId: id,
  name: name,
  amount: positiveAmount,
  dueDate: isoDate,
  levelId: id.optional(),
  order: z.number().int().min(0).default(0),
});
export const invoiceGenerateSchema = z.object({
  studentId: id,
  academicYearId: id,
  discounts: z
    .array(
      z.object({
        feeItemId: id,
        amount: positiveAmount,
        reason: z.string().trim().min(2).max(120),
      }),
    )
    .default([]),
});
export const paymentCreateSchema = z
  .object({
    studentId: id,
    amount: positiveAmount,
    method: z.enum(PAYMENT_METHODS),
    lineIds: z.array(id).optional(),
    payerPhone: cameroonPhone.optional(),
    bankName: z.string().trim().max(80).optional(),
    bankReference: z.string().trim().max(60).optional(),
    idempotencyKey: z.string().uuid(),
  })
  .superRefine((v, ctx) => {
    if ((v.method === 'MTN_MOMO' || v.method === 'ORANGE_MONEY') && !v.payerPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payerPhone'],
        message: 'Numéro du payeur obligatoire',
      });
    }
    if (v.method === 'BANK' && !v.bankReference) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bankReference'],
        message: 'Numéro de bordereau obligatoire',
      });
    }
  });
export const portalPaymentSchema = z.object({
  studentId: id,
  amount: positiveAmount,
  method: z.enum(['MTN_MOMO', 'ORANGE_MONEY']),
  payerPhone: cameroonPhone,
  idempotencyKey: z.string().uuid(),
});
export const paymentReverseSchema = z.object({ reason: z.string().trim().min(5).max(300) });
export const cashCloseSchema = z.object({
  countedAmount: amount,
  note: z.string().trim().max(300).optional(),
});

// Communication
export const ANNOUNCEMENT_SCOPES = ['SCHOOL', 'CYCLE', 'LEVEL', 'CLASS'] as const;
export const announcementCreateSchema = z.object({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(3).max(4000),
  scope: z.enum(ANNOUNCEMENT_SCOPES),
  targetId: id.optional(),
  sendSms: z.boolean().default(false),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type StudentCreateInput = z.infer<typeof studentCreateSchema>;
export type GuardianInput = z.infer<typeof guardianInputSchema>;
export type AttendanceSubmitInput = z.infer<typeof attendanceSubmitSchema>;
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;
export type EvaluationCreateInput = z.infer<typeof evaluationCreateSchema>;
