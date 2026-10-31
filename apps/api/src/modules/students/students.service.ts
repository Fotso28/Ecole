import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  assessDuplicate,
  describeGuardian,
  enrollmentChangeSchema,
  formatMatricule,
  GUARDIAN_RELATIONSHIPS,
  guardianInputSchema,
  normalizeCameroonPhone,
  sameGuardianName,
  studentCreateSchema,
  studentUpdateSchema,
  type GuardianInput,
} from '@ecole/shared';
import { EnrollmentStatus, Prisma } from '@prisma/client';
import Papa from 'papaparse';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId } from '../../common/context';
import { CountersService } from '../../common/counters.service';
import { decrypt, encrypt } from '../../common/crypto';
import { fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { matchStudentIds } from '../../common/student-search';
import { FinanceService } from '../finance/finance.service';
import { normalizeImportHeader, readStudentSheet } from './xlsx';
import { FilesService, presentFile, type UploadedFile } from '../files/files.service';

export const DEFAULT_DOCUMENTS = [
  'Acte de naissance',
  'Photo d’identité',
  'Certificat médical',
  'Bulletin de l’année précédente',
];

type StudentInput = z.infer<typeof studentCreateSchema>;
type EnrollmentChange = z.infer<typeof enrollmentChangeSchema>;

/** Parent déjà enregistré sous un numéro, avec ses enfants (pour le désigner sans ambiguïté). */
export interface KnownGuardian {
  phone: string;
  id: string;
  firstName: string;
  lastName: string;
  children: { firstName: string; lastName: string }[];
  /** « Pierre Ngono (parent de Marie-Claire et Paul-Henri) ». */
  label: string;
}

/** Numéro déjà attribué à un parent dont le nom diffère de celui saisi. */
export interface GuardianConflict {
  /** Rang du parent dans la saisie (0 pour le premier). */
  index: number;
  phone: string;
  existing: KnownGuardian;
  message: string;
}

const PHOTO_DOCUMENT = 'Photo d’identité';

/** Champs du fichier d'import : libellé lisible et colonne lue, dans l'ordre du rapport. */
const IMPORT_FIELDS = {
  lastName: { label: 'Nom', columns: ['nom'] },
  firstName: { label: 'Prénoms', columns: ['prenoms', 'prenom'] },
  gender: { label: 'Sexe', columns: ['sexe'] },
  birthDate: { label: 'Date de naissance', columns: ['date_naissance'] },
  birthPlace: { label: 'Lieu de naissance', columns: ['lieu_naissance'] },
  'parent.lastName': { label: 'Nom du parent', columns: ['parent_nom'] },
  'parent.firstName': { label: 'Prénom du parent', columns: ['parent_prenom', 'parent_prenoms'] },
  'parent.phone': {
    label: 'Téléphone du parent',
    columns: ['parent_telephone', 'telephone'],
  },
} as const;
type ImportField = keyof typeof IMPORT_FIELDS;
const IMPORT_ORDER = Object.keys(IMPORT_FIELDS) as ImportField[];

/** Valeur lue dans la ligne pour un champ (première colonne renseignée). */
function importValue(raw: Record<string, string>, field: ImportField): string {
  for (const c of IMPORT_FIELDS[field].columns) {
    const v = raw[c]?.trim();
    if (v) return v;
  }
  return '';
}

/**
 * Message du rapport d'import, en français clair : libellé de la colonne, explication et valeur
 * lue (« Sexe : indiquez F ou M (valeur lue : X) »). Jamais de nom de champ technique.
 */
function importMessage(field: ImportField, value: string, message: string): string {
  const label = IMPORT_FIELDS[field].label;
  if (!value) return `${label} : champ obligatoire`;
  let text = message.charAt(0).toLowerCase() + message.slice(1);
  if (field === 'gender') text = 'indiquez F ou M';
  if (field === 'birthDate') text = 'date invalide, attendue au format JJ/MM/AAAA';
  if (field === 'parent.phone') text = 'numéro de téléphone camerounais invalide';
  return `${label} : ${text} (valeur lue : ${value})`;
}
const ACTIVE_STATUSES: readonly EnrollmentStatus[] = ['ENROLLED', 'REPEATING'];

export interface ListQuery {
  search?: string;
  classId?: string;
  status?: EnrollmentStatus;
  page: number;
  pageSize: number;
}

@Injectable()
export class StudentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
    private readonly finance: FinanceService,
    private readonly files: FilesService,
  ) {}

  async list(q: ListQuery) {
    const year = await this.scope.currentYear();
    const teacherOnly = this.scope.isClassScoped('students.read');
    const canSeeFinance = this.scope.can('finance.read');
    const teacherClassIds = teacherOnly ? await this.scope.teacherClassIds() : null;
    const search = q.search?.trim();
    const phone = search ? normalizeCameroonPhone(search) : null;
    // Nom, prénoms ou matricule : sans accents ni casse, mots dans n'importe quel ordre.
    const matching = search ? ((await matchStudentIds(this.db, search)) ?? []) : [];
    const where: Prisma.StudentWhereInput = {
      deletedAt: null,
      enrollments: {
        some: {
          academicYearId: year.id,
          ...(q.classId ? { classId: q.classId } : {}),
          ...(teacherClassIds
            ? {
                classId: {
                  in: q.classId ? teacherClassIds.filter((c) => c === q.classId) : teacherClassIds,
                },
              }
            : {}),
          ...(q.status ? { status: q.status } : {}),
        },
      },
      ...(search
        ? {
            OR: [
              { id: { in: matching } },
              ...(phone ? [{ guardians: { some: { guardian: { phone } } } }] : []),
            ],
          }
        : {}),
    };
    const [total, students, statusCounts] = await Promise.all([
      this.db.student.count({ where }),
      this.db.student.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          enrollments: {
            where: { academicYearId: year.id },
            include: { class: { select: { id: true, name: true } } },
          },
          guardians: { include: { guardian: true }, orderBy: { isPrimary: 'desc' }, take: 1 },
        },
      }),
      this.db.enrollment.groupBy({
        by: ['status'],
        where: {
          academicYearId: year.id,
          student: { deletedAt: null },
          ...(teacherClassIds ? { classId: { in: teacherClassIds } } : {}),
        },
        _count: { _all: true },
      }),
    ]);
    const ids = students.map((s) => s.id);
    const [lines, absences] = await Promise.all([
      !canSeeFinance
        ? Promise.resolve([])
        : this.finance.lineStates({ invoice: { studentId: { in: ids }, academicYearId: year.id } }),
      this.db.attendanceRecord.groupBy({
        by: ['studentId'],
        where: {
          studentId: { in: ids },
          status: 'ABSENT',
          session: { date: { gte: year.startDate } },
        },
        _count: { _all: true },
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      counts: Object.fromEntries(statusCounts.map((c) => [c.status, c._count._all])),
      items: students.map((s) => {
        const enrollment = s.enrollments[0];
        const guardian = s.guardians[0]?.guardian;
        const mine = lines.filter((l) => l.studentId === s.id);
        return {
          id: s.id,
          matricule: s.matricule,
          firstName: s.firstName,
          lastName: s.lastName,
          gender: s.gender,
          birthDate: fromDbDate(s.birthDate),
          class: enrollment ? enrollment.class : null,
          status: enrollment?.status ?? null,
          guardian: guardian
            ? { name: `${guardian.firstName} ${guardian.lastName}`, phone: guardian.phone }
            : null,
          overdue: !canSeeFinance
            ? null
            : mine.filter((l) => l.overdue).reduce((n, l) => n + l.outstanding, 0),
          absences: absences.find((a) => a.studentId === s.id)?._count._all ?? 0,
        };
      }),
    };
  }

  async findDuplicates(
    input: {
      firstName: string;
      lastName: string;
      birthDate: string;
      birthPlace?: string;
      guardianPhones: string[];
    },
    excludeId?: string,
  ) {
    const fullName = `${input.lastName} ${input.firstName}`;
    const phones = input.guardianPhones.map(normalizeCameroonPhone).filter((p): p is string => !!p);
    const candidates = await this.db.student.findMany({
      where: {
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        OR: [
          { birthDate: toDbDate(input.birthDate) },
          { lastName: { equals: input.lastName.trim(), mode: 'insensitive' } },
          ...(phones.length
            ? [{ guardians: { some: { guardian: { phone: { in: phones } } } } }]
            : []),
        ],
      },
      include: {
        guardians: { include: { guardian: { select: { phone: true } } } },
        enrollments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { class: { select: { name: true } } },
        },
      },
      take: 200,
    });
    return candidates
      .map((c) => {
        const assessment = assessDuplicate(
          {
            fullName,
            birthDate: input.birthDate,
            birthPlace: input.birthPlace,
            guardianPhones: phones,
          },
          {
            fullName: `${c.lastName} ${c.firstName}`,
            birthDate: fromDbDate(c.birthDate),
            birthPlace: c.birthPlace,
            guardianPhones: c.guardians.map((g) => g.guardian.phone),
          },
        );
        return {
          id: c.id,
          matricule: c.matricule,
          firstName: c.firstName,
          lastName: c.lastName,
          birthDate: fromDbDate(c.birthDate),
          className: c.enrollments[0]?.class.name ?? null,
          ...assessment,
        };
      })
      .filter((c) => c.isLikelyDuplicate)
      .sort((a, b) => b.score - a.score);
  }

  /** Inscription d'un nouvel élève : contrôle des doublons, matricule, parents, inscription, échéancier. */
  async create(input: StudentInput) {
    if (!input.confirmNotDuplicate) {
      const duplicates = await this.findDuplicates({
        ...input,
        guardianPhones: input.guardians.map((g) => g.phone),
      });
      if (duplicates.length > 0) {
        throw new ConflictException({
          statusCode: 409,
          code: 'POSSIBLE_DUPLICATE',
          message: 'Ce dossier existe peut-être déjà',
          candidates: duplicates,
        });
      }
    }
    await this.assertNoGuardianConflict(input.guardians);
    const year = await this.scope.currentYear();
    if (input.classId) {
      const cls = await this.db.class.findUnique({ where: { id: input.classId } });
      if (!cls || cls.academicYearId !== year.id)
        throw new BadRequestException('Classe inconnue pour l’année en cours');
    }
    const result = await this.db.$transaction(async (tx) => {
      const student = await this.createInTx(tx, input, year.id);
      if (input.confirmNotDuplicate) {
        await this.audit.log(
          { action: 'students.duplicate_dismissed', entity: 'Student', entityId: student.id },
          tx,
        );
      }
      return student;
    });
    return result;
  }

  private async createInTx(tx: Tx, input: StudentInput, academicYearId: string) {
    const schoolId = currentSchoolId();
    const school = await tx.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { matriculePrefix: true },
    });
    const calendarYear = Number(todayInCameroon().slice(0, 4));
    const seq = await this.counters.next(`matricule:${calendarYear}`, tx);
    const student = await tx.student.create({
      data: {
        schoolId,
        matricule: formatMatricule(school.matriculePrefix, calendarYear, seq),
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        gender: input.gender,
        birthDate: toDbDate(input.birthDate),
        birthPlace: input.birthPlace,
        nationality: input.nationality,
        photoConsent: input.photoConsent,
        ...(input.photoConsent
          ? { photoConsentAt: new Date(), photoConsentById: currentActorId() ?? null }
          : {}),
        previousSchool: input.previousSchool,
      },
    });
    for (const g of input.guardians) await this.linkGuardian(tx, student.id, g);
    if (input.classId) await this.scope.assertYearOpen(academicYearId, tx);
    for (const type of DEFAULT_DOCUMENTS) {
      await tx.studentDocument.create({
        data: { schoolId, studentId: student.id, type, status: 'MISSING' },
      });
    }
    if (input.classId) {
      await tx.enrollment.create({
        data: {
          schoolId,
          studentId: student.id,
          classId: input.classId,
          academicYearId,
          status: 'ENROLLED',
        },
      });
      const fees = await tx.feeItem.count({ where: { academicYearId } });
      if (fees > 0) await this.finance.generateInvoice(student.id, academicYearId, [], tx);
    }
    await this.audit.log(
      {
        action: 'students.created',
        entity: 'Student',
        entityId: student.id,
        after: { matricule: student.matricule, classId: input.classId },
      },
      tx,
    );
    return student;
  }

  /** Parents déjà enregistrés sous ces numéros (formats libres), avec leurs enfants. */
  async knownGuardians(phones: readonly string[], db: Db | Tx = this.db): Promise<KnownGuardian[]> {
    const normalized = [
      ...new Set(phones.map(normalizeCameroonPhone).filter((p): p is string => !!p)),
    ];
    if (normalized.length === 0) return [];
    const guardians = await db.guardian.findMany({
      where: { phone: { in: normalized } },
      include: {
        students: {
          where: { student: { deletedAt: null } },
          orderBy: { student: { createdAt: 'asc' } },
          include: { student: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    return guardians.map((g) => {
      const children = g.students.map((l) => ({
        firstName: l.student.firstName,
        lastName: l.student.lastName,
      }));
      return {
        phone: g.phone,
        id: g.id,
        firstName: g.firstName,
        lastName: g.lastName,
        children,
        label: describeGuardian({ firstName: g.firstName, lastName: g.lastName, children }),
      };
    });
  }

  /**
   * Numéros saisis qui appartiennent déjà à un autre parent (nom différent), sans choix explicite
   * de rattachement. Un même nom (accents, casse et ordre ignorés) désigne le même parent : le
   * rattachement des frères et sœurs reste automatique.
   */
  async guardianConflicts(
    guardians: readonly GuardianInput[],
    db: Db | Tx = this.db,
  ): Promise<GuardianConflict[]> {
    const pending = guardians
      .map((g, index) => ({ g, index }))
      .filter(({ g }) => !g.linkExistingGuardian);
    if (pending.length === 0) return [];
    const known = await this.knownGuardians(
      pending.map(({ g }) => g.phone),
      db,
    );
    return pending.flatMap(({ g, index }) => {
      const existing = known.find((k) => k.phone === g.phone);
      if (!existing || sameGuardianName(g, existing)) return [];
      return [
        {
          index,
          phone: g.phone,
          existing,
          message: `Ce numéro appartient déjà à ${existing.label}`,
        },
      ];
    });
  }

  private async assertNoGuardianConflict(guardians: readonly GuardianInput[]) {
    const conflicts = await this.guardianConflicts(guardians);
    if (conflicts.length === 0) return;
    throw new ConflictException({
      statusCode: 409,
      code: 'GUARDIAN_PHONE_TAKEN',
      message: `${conflicts[0]!.message}. Rattachez l’élève à ce parent ou corrigez le numéro.`,
      conflicts,
    });
  }

  private async linkGuardian(tx: Tx, studentId: string, g: GuardianInput) {
    const schoolId = currentSchoolId();
    const guardian = await tx.guardian.upsert({
      where: { schoolId_phone: { schoolId, phone: g.phone } },
      create: {
        schoolId,
        firstName: g.firstName,
        lastName: g.lastName,
        phone: g.phone,
        email: g.email,
      },
      update: g.email ? { email: g.email } : {},
    });
    const hasPrimary = await tx.studentGuardian.count({ where: { studentId, isPrimary: true } });
    return tx.studentGuardian.upsert({
      where: { studentId_guardianId: { studentId, guardianId: guardian.id } },
      create: {
        schoolId,
        studentId,
        guardianId: guardian.id,
        relationship: g.relationship,
        isPrimary: g.isPrimary || hasPrimary === 0,
        isEmergencyContact: g.isEmergencyContact,
        canPickUp: g.canPickUp,
      },
      update: {
        relationship: g.relationship,
        isEmergencyContact: g.isEmergencyContact,
        canPickUp: g.canPickUp,
      },
    });
  }

  async addGuardian(studentId: string, g: GuardianInput) {
    await this.ensureStudent(studentId);
    await this.assertNoGuardianConflict([g]);
    return this.db.$transaction(async (tx) => {
      if (g.isPrimary)
        await tx.studentGuardian.updateMany({ where: { studentId }, data: { isPrimary: false } });
      const link = await this.linkGuardian(tx, studentId, g);
      if (g.isPrimary)
        await tx.studentGuardian.update({ where: { id: link.id }, data: { isPrimary: true } });
      await this.audit.log(
        {
          action: 'students.guardian_added',
          entity: 'Student',
          entityId: studentId,
          after: { phone: g.phone },
        },
        tx,
      );
      return link;
    });
  }

  /** Adresse e-mail facultative du parent (notifications par e-mail). */
  async setGuardianEmail(studentId: string, linkId: string, email: string | null) {
    const link = await this.db.studentGuardian.findFirst({
      where: { id: linkId, studentId },
      include: { guardian: true },
    });
    if (!link) throw new NotFoundException('Lien introuvable');
    await this.db.guardian.update({ where: { id: link.guardianId }, data: { email } });
    await this.audit.log({
      action: 'students.guardian_contact_updated',
      entity: 'Guardian',
      entityId: link.guardianId,
      before: { email: link.guardian.email },
      after: { email },
    });
    return { ok: true, email };
  }

  async removeGuardian(studentId: string, linkId: string) {
    const links = await this.db.studentGuardian.findMany({ where: { studentId } });
    if (!links.some((l) => l.id === linkId)) throw new NotFoundException('Lien introuvable');
    if (links.length === 1)
      throw new ConflictException('Un élève doit garder au moins un parent ou tuteur');
    await this.db.studentGuardian.delete({ where: { id: linkId } });
    await this.audit.log({
      action: 'students.guardian_removed',
      entity: 'Student',
      entityId: studentId,
      after: { linkId },
    });
    return { ok: true };
  }

  async overview(id: string) {
    const student = await this.db.student.findUnique({
      where: { id },
      include: {
        guardians: { include: { guardian: true }, orderBy: { isPrimary: 'desc' } },
        enrollments: {
          orderBy: { createdAt: 'desc' },
          include: { class: { include: { academicYear: true, level: true } } },
        },
        documents: { orderBy: { type: 'asc' }, include: { file: true } },
        photoFile: true,
      },
    });
    if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    await this.scope.assertStudentInScope(id, 'students.read');
    const consentBy = student.photoConsentById
      ? await this.db.user.findUnique({
          where: { id: student.photoConsentById },
          select: { firstName: true, lastName: true },
        })
      : null;
    const year = await this.scope.currentYear();
    const [records, reportCards, incidents, guardianUsers] = await Promise.all([
      this.db.attendanceRecord.findMany({
        where: {
          studentId: id,
          status: { in: ['ABSENT', 'LATE'] },
          session: { date: { gte: year.startDate } },
        },
        include: { session: true, justification: { select: { status: true } } },
        orderBy: { session: { date: 'desc' } },
      }),
      this.db.reportCard.findMany({
        where: { studentId: id, status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          termId: true,
          version: true,
          generalAverageCenti: true,
          rank: true,
          classSize: true,
          publishedAt: true,
        },
      }),
      this.db.incident.findMany({ where: { studentId: id }, orderBy: { date: 'desc' }, take: 10 }),
      this.db.user.findMany({
        where: {
          id: {
            in: student.guardians.map((g) => g.guardian.userId).filter((x): x is string => !!x),
          },
        },
        select: { id: true, lastLoginAt: true },
      }),
    ]);
    const canSeeFinance = this.scope.can('finance.read');
    const account = canSeeFinance ? await this.finance.account(id) : null;
    return {
      id: student.id,
      matricule: student.matricule,
      firstName: student.firstName,
      lastName: student.lastName,
      gender: student.gender,
      birthDate: fromDbDate(student.birthDate),
      birthPlace: student.birthPlace,
      nationality: student.nationality,
      photoConsent: student.photoConsent,
      photo: {
        consent: student.photoConsent,
        consentAt: student.photoConsentAt,
        consentBy: consentBy ? `${consentBy.firstName} ${consentBy.lastName}` : null,
        hasPhoto: student.photoConsent && !!presentFile(student.photoFile),
      },
      previousSchool: student.previousSchool,
      guardians: student.guardians.map((l) => ({
        linkId: l.id,
        id: l.guardian.id,
        firstName: l.guardian.firstName,
        lastName: l.guardian.lastName,
        phone: l.guardian.phone,
        email: l.guardian.email,
        relationship: l.relationship,
        isPrimary: l.isPrimary,
        isEmergencyContact: l.isEmergencyContact,
        canPickUp: l.canPickUp,
        portalActive: !!guardianUsers.find((u) => u.id === l.guardian.userId)?.lastLoginAt,
      })),
      enrollments: student.enrollments.map((e) => ({
        id: e.id,
        status: e.status,
        academicYear: e.class.academicYear.name,
        academicYearId: e.academicYearId,
        isCurrent: e.academicYearId === year.id,
        class: { id: e.class.id, name: e.class.name, level: e.class.level.name },
        exitDate: e.exitDate ? fromDbDate(e.exitDate) : null,
        destinationSchool: e.destinationSchool,
        // Le motif d'une sortie peut être personnel : réservé à qui gère les inscriptions.
        exitReason: this.scope.can('enrollments.write') ? e.exitReason : null,
      })),
      documents: student.documents.map((d) => ({
        id: d.id,
        type: d.type,
        status: d.status,
        hasFile: !!presentFile(d.file),
        file: this.scope.can('students.documents') ? presentFile(d.file) : null,
      })),
      attendance: {
        absences: records.filter((r) => r.status === 'ABSENT').length,
        unjustified: records.filter(
          (r) => r.status === 'ABSENT' && r.justification?.status !== 'ACCEPTED',
        ).length,
        lates: records.filter((r) => r.status === 'LATE').length,
        recent: records.slice(0, 10).map((r) => ({
          id: r.id,
          date: fromDbDate(r.session.date),
          startTime: r.session.startTime,
          endTime: r.session.endTime,
          status: r.status,
          justification: r.justification?.status ?? null,
        })),
      },
      incidents: incidents.map((i) => ({
        id: i.id,
        date: fromDbDate(i.date),
        description: i.description,
        sanction: i.sanction,
      })),
      reportCards,
      finance: account ? { totals: account.totals, nextDue: account.nextDue } : null,
    };
  }

  /**
   * Correction de l'identité (nom, prénoms, sexe, date et lieu de naissance, nationalité). Le
   * journal d'audit garde la valeur avant et après de chaque champ modifié. Les documents déjà
   * délivrés et les bulletins publiés restent figés.
   */
  async update(id: string, input: z.infer<typeof studentUpdateSchema>) {
    const before = await this.ensureStudent(id);
    const { photoConsent, ...rest } = input;
    // Le consentement à la photo passe par son propre circuit (date, auteur, retrait de la photo).
    if (photoConsent !== undefined && photoConsent !== before.photoConsent)
      await this.setPhotoConsent(id, photoConsent);
    const identity = {
      firstName: rest.firstName,
      lastName: rest.lastName,
      gender: rest.gender,
      birthDate: rest.birthDate,
      birthPlace: rest.birthPlace,
      nationality: rest.nationality,
    };
    const current: Record<keyof typeof identity, string | null> = {
      firstName: before.firstName,
      lastName: before.lastName,
      gender: before.gender,
      birthDate: fromDbDate(before.birthDate),
      birthPlace: before.birthPlace,
      nationality: before.nationality,
    };
    const changed = (Object.keys(identity) as (keyof typeof identity)[]).filter(
      (k) => identity[k] !== undefined && identity[k] !== current[k],
    );
    if (changed.length === 0) return before;
    const after = await this.db.$transaction(async (tx) => {
      const updated = await tx.student.update({
        where: { id },
        data: {
          ...Object.fromEntries(changed.map((k) => [k, identity[k]])),
          ...(changed.includes('birthDate') ? { birthDate: toDbDate(rest.birthDate!) } : {}),
        },
      });
      await this.audit.log(
        {
          action: 'students.updated',
          entity: 'Student',
          entityId: id,
          before: Object.fromEntries(changed.map((k) => [k, current[k]])),
          after: Object.fromEntries(changed.map((k) => [k, identity[k]])),
        },
        tx,
      );
      return updated;
    });
    return after;
  }

  /** Suppression logique : le dossier reste consultable dans l'historique et l'audit. */
  async softDelete(id: string, reason: string) {
    await this.ensureStudent(id);
    await this.db.student.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({ action: 'students.deleted', entity: 'Student', entityId: id, reason });
    return { ok: true };
  }

  async setDocument(studentId: string, documentId: string, status: 'RECEIVED' | 'MISSING') {
    const doc = await this.db.studentDocument.findFirst({ where: { id: documentId, studentId } });
    if (!doc) throw new NotFoundException('Pièce introuvable');
    const updated = await this.db.studentDocument.update({
      where: { id: documentId },
      data: { status },
    });
    await this.audit.log({
      action: 'students.document',
      entity: 'StudentDocument',
      entityId: documentId,
      before: doc.status,
      after: status,
    });
    return updated;
  }

  /**
   * Dépôt (ou remplacement) du fichier d'une pièce d'inscription : la pièce passe à « fournie »,
   * l'ancien fichier est supprimé logiquement.
   */
  async uploadDocument(studentId: string, documentId: string, upload: UploadedFile | undefined) {
    await this.ensureStudent(studentId);
    const doc = await this.db.studentDocument.findFirst({ where: { id: documentId, studentId } });
    if (!doc) throw new NotFoundException('Pièce introuvable');
    this.files.validate(upload);
    return this.db.$transaction(async (tx) => {
      const file = await this.files.store(upload, 'STUDENT_DOCUMENT', tx);
      if (doc.fileId) await this.files.softDelete(doc.fileId, 'Pièce remplacée', tx);
      const updated = await tx.studentDocument.update({
        where: { id: documentId },
        data: { fileId: file.id, status: 'RECEIVED' },
      });
      await this.audit.log(
        {
          action: doc.fileId ? 'students.document_replaced' : 'students.document_uploaded',
          entity: 'StudentDocument',
          entityId: documentId,
          before: { status: doc.status, fileId: doc.fileId },
          after: { status: updated.status, fileId: file.id },
        },
        tx,
      );
      return {
        id: updated.id,
        type: updated.type,
        status: updated.status,
        hasFile: true,
        file: presentFile(file),
      };
    });
  }

  /** Lien de consultation du fichier d'une pièce, journalisé (donnée personnelle). */
  async documentLink(studentId: string, documentId: string) {
    await this.ensureStudent(studentId);
    const doc = await this.db.studentDocument.findFirst({ where: { id: documentId, studentId } });
    if (!doc) throw new NotFoundException('Pièce introuvable');
    return this.files.link(doc.fileId, true);
  }

  /**
   * Consentement à la photo (loi sur les données personnelles) : date et auteur enregistrés,
   * changement journalisé. Le retrait supprime logiquement la photo, qui n'apparaît plus nulle part.
   */
  async setPhotoConsent(studentId: string, consent: boolean) {
    const before = await this.ensureStudent(studentId);
    return this.db.$transaction(async (tx) => {
      if (!consent && before.photoFileId)
        await this.files.softDelete(before.photoFileId, 'Retrait du consentement à la photo', tx);
      const after = await tx.student.update({
        where: { id: studentId },
        data: {
          photoConsent: consent,
          photoConsentAt: new Date(),
          photoConsentById: currentActorId() ?? null,
          ...(consent ? {} : { photoFileId: null }),
        },
      });
      await this.audit.log(
        {
          action: consent ? 'students.photo_consent_given' : 'students.photo_consent_withdrawn',
          entity: 'Student',
          entityId: studentId,
          before: { photoConsent: before.photoConsent, photoFileId: before.photoFileId },
          after: { photoConsent: after.photoConsent, photoFileId: after.photoFileId },
        },
        tx,
      );
      return {
        consent: after.photoConsent,
        consentAt: after.photoConsentAt,
        hasPhoto: !!after.photoFileId,
      };
    });
  }

  /** Dépôt (ou remplacement) de la photo d'identité, chiffrée, seulement avec le consentement. */
  async uploadPhoto(studentId: string, upload: UploadedFile | undefined) {
    const student = await this.ensureStudent(studentId);
    if (!student.photoConsent)
      throw new ConflictException(
        'Consentement à la photo requis : enregistrez-le avant de déposer une photo',
      );
    if (this.files.validate(upload) === 'application/pdf')
      throw new BadRequestException('La photo doit être une image JPEG ou PNG');
    return this.db.$transaction(async (tx) => {
      const file = await this.files.store(upload, 'STUDENT_PHOTO', tx);
      if (student.photoFileId)
        await this.files.softDelete(student.photoFileId, 'Photo remplacée', tx);
      await tx.student.update({ where: { id: studentId }, data: { photoFileId: file.id } });
      await this.audit.log(
        {
          action: student.photoFileId ? 'students.photo_replaced' : 'students.photo_uploaded',
          entity: 'Student',
          entityId: studentId,
          before: { photoFileId: student.photoFileId },
          after: { photoFileId: file.id },
        },
        tx,
      );
      // La photo déposée vaut pièce « Photo d'identité » fournie.
      const piece = await tx.studentDocument.findFirst({
        where: { studentId, type: PHOTO_DOCUMENT, status: 'MISSING' },
      });
      if (piece) {
        await tx.studentDocument.update({ where: { id: piece.id }, data: { status: 'RECEIVED' } });
        await this.audit.log(
          {
            action: 'students.document',
            entity: 'StudentDocument',
            entityId: piece.id,
            before: 'MISSING',
            after: 'RECEIVED',
            reason: 'Photo d’identité déposée',
          },
          tx,
        );
      }
      return { consent: true, hasPhoto: true };
    });
  }

  async removePhoto(studentId: string) {
    const student = await this.ensureStudent(studentId);
    if (!student.photoFileId) return { consent: student.photoConsent, hasPhoto: false };
    await this.db.$transaction(async (tx) => {
      await this.files.softDelete(student.photoFileId!, 'Photo retirée', tx);
      await tx.student.update({ where: { id: studentId }, data: { photoFileId: null } });
      await this.audit.log(
        {
          action: 'students.photo_removed',
          entity: 'Student',
          entityId: studentId,
          before: { photoFileId: student.photoFileId },
        },
        tx,
      );
    });
    return { consent: student.photoConsent, hasPhoto: false };
  }

  /** Lien de courte durée vers la photo, pour qui peut voir l'élève (enseignant : ses classes). */
  async photoLink(studentId: string) {
    const student = await this.ensureStudent(studentId);
    await this.scope.assertStudentInScope(studentId, 'students.read');
    if (!student.photoConsent || !student.photoFileId)
      throw new NotFoundException('Aucune photo pour cet élève');
    return this.files.link(student.photoFileId);
  }

  /** Inscription pour l'année en cours (nouvelle classe, redoublement). */
  async enroll(studentId: string, classId: string, status: 'ENROLLED' | 'REPEATING') {
    await this.ensureStudent(studentId);
    const year = await this.scope.currentYear();
    const cls = await this.db.class.findUnique({ where: { id: classId } });
    if (!cls || cls.academicYearId !== year.id)
      throw new BadRequestException('Classe inconnue pour l’année en cours');
    await this.scope.assertYearOpen(year.id);
    const existing = await this.db.enrollment.findFirst({
      where: { studentId, academicYearId: year.id },
    });
    if (existing) throw new ConflictException('L’élève est déjà inscrit cette année');
    const previous = await this.db.enrollment.findFirst({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
    });
    return this.db.$transaction(async (tx) => {
      const enrollment = await tx.enrollment.create({
        data: {
          schoolId: currentSchoolId(),
          studentId,
          classId,
          academicYearId: year.id,
          status,
          previousEnrollmentId: previous?.id,
        },
      });
      const fees = await tx.feeItem.count({ where: { academicYearId: year.id } });
      if (fees > 0) await this.finance.generateInvoice(studentId, year.id, [], tx);
      await this.audit.log(
        {
          action: 'enrollments.created',
          entity: 'Enrollment',
          entityId: enrollment.id,
          after: { classId, status },
        },
        tx,
      );
      return enrollment;
    });
  }

  /**
   * Changement d'inscription en cours d'année : changement de classe (même année), transfert ou
   * sortie (date dans l'année scolaire, motif, établissement d'accueil pour un transfert), ou
   * réintégration. L'élève qui quitte l'établissement disparaît des listes d'appel et de notes ;
   * son dossier et son historique restent consultables. Chaque changement est journalisé.
   */
  async changeEnrollment(enrollmentId: string, input: EnrollmentChange) {
    const before = await this.db.enrollment.findUnique({
      where: { id: enrollmentId },
      include: { class: { select: { name: true } } },
    });
    if (!before) throw new NotFoundException('Inscription introuvable');
    await this.ensureStudent(before.studentId);
    await this.scope.assertYearOpen(before.academicYearId);
    const status = input.status ?? before.status;
    const leaving = status === 'TRANSFERRED' || status === 'LEFT';
    let newClass: { id: string; name: string } | null = null;
    if (input.classId && input.classId !== before.classId) {
      const cls = await this.db.class.findUnique({ where: { id: input.classId } });
      if (!cls || cls.academicYearId !== before.academicYearId)
        throw new BadRequestException('La classe doit appartenir à la même année');
      if (leaving)
        throw new ConflictException(
          'L’élève a quitté l’établissement : réintégrez-le avant de changer de classe',
        );
      newClass = cls;
    }
    if (input.status === 'TRANSFERRED' || input.status === 'LEFT') {
      const year = await this.db.academicYear.findUniqueOrThrow({
        where: { id: before.academicYearId },
      });
      const exitDate = input.exitDate!;
      if (exitDate < fromDbDate(year.startDate) || exitDate > fromDbDate(year.endDate))
        throw new BadRequestException({
          statusCode: 400,
          message: 'Données invalides',
          errors: [
            {
              path: 'exitDate',
              message: `La date de sortie doit se situer dans l’année scolaire ${year.name}`,
            },
          ],
        });
    }
    const exit =
      input.status === 'TRANSFERRED' || input.status === 'LEFT'
        ? {
            exitDate: toDbDate(input.exitDate!),
            exitReason: input.exitReason!,
            destinationSchool: input.status === 'TRANSFERRED' ? input.destinationSchool! : null,
          }
        : input.status
          ? { exitDate: null, exitReason: null, destinationSchool: null }
          : {};
    const action =
      input.status === 'TRANSFERRED'
        ? 'enrollments.transferred'
        : input.status === 'LEFT'
          ? 'enrollments.left'
          : input.status && !ACTIVE_STATUSES.includes(before.status)
            ? 'enrollments.reinstated'
            : newClass
              ? 'enrollments.class_changed'
              : 'enrollments.changed';
    const snapshot = (e: {
      classId: string;
      status: EnrollmentStatus;
      exitDate: Date | null;
      exitReason: string | null;
      destinationSchool: string | null;
    }) => ({
      classId: e.classId,
      status: e.status,
      exitDate: e.exitDate ? fromDbDate(e.exitDate) : null,
      exitReason: e.exitReason,
      destinationSchool: e.destinationSchool,
    });
    return this.db.$transaction(async (tx) => {
      const after = await tx.enrollment.update({
        where: { id: enrollmentId },
        data: {
          ...(newClass ? { classId: newClass.id } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...exit,
        },
      });
      await this.audit.log(
        {
          action,
          entity: 'Enrollment',
          entityId: enrollmentId,
          before: { ...snapshot(before), className: before.class.name },
          after: { ...snapshot(after), className: newClass?.name ?? before.class.name },
          reason: input.exitReason,
        },
        tx,
      );
      return after;
    });
  }

  async health(studentId: string, reason: string) {
    await this.ensureStudent(studentId);
    const record = await this.db.healthRecord.findUnique({ where: { studentId } });
    await this.audit.log({
      action: 'health.read',
      entity: 'HealthRecord',
      entityId: studentId,
      reason,
    });
    return record
      ? (JSON.parse(decrypt(record.encryptedPayload, env().DATA_ENCRYPTION_KEY)) as Record<
          string,
          unknown
        >)
      : null;
  }

  async saveHealth(studentId: string, payload: Record<string, unknown>) {
    await this.ensureStudent(studentId);
    const encryptedPayload = encrypt(JSON.stringify(payload), env().DATA_ENCRYPTION_KEY);
    await this.db.healthRecord.upsert({
      where: { studentId },
      create: { schoolId: currentSchoolId(), studentId, encryptedPayload },
      update: { encryptedPayload },
    });
    await this.audit.log({ action: 'health.updated', entity: 'HealthRecord', entityId: studentId });
    return { ok: true };
  }

  /**
   * Import CSV (séparateur ; ou ,). Colonnes : nom, prenoms, sexe, date_naissance,
   * lieu_naissance, parent_nom, parent_prenom, parent_telephone, lien.
   * En mode aperçu, rien n'est enregistré ; l'import est refusé s'il reste une erreur.
   */
  async importCsv(csv: string, classId: string | undefined, dryRun: boolean) {
    const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
      header: true,
      skipEmptyLines: true,
      transformHeader: normalizeImportHeader,
    });
    return this.importRecords(
      parsed.data
        .map((raw, i) => ({ line: i + 2, raw }))
        // Ligne sans aucune valeur (« ;;;; ») : ignorée, comme dans un classeur Excel.
        .filter(({ raw }) => Object.values(raw).some((v) => (v ?? '').trim() !== '')),
      classId,
      dryRun,
    );
  }

  /** Import Excel (.xlsx) : mêmes colonnes, même aperçu et même rapport que le CSV. */
  async importXlsx(file: Buffer, classId: string | undefined, dryRun: boolean) {
    return this.importRecords(await readStudentSheet(file), classId, dryRun);
  }

  /** Lignes déjà lues (en-têtes normalisés), avec leur numéro dans le fichier d'origine. */
  private async importRecords(
    records: { line: number; raw: Record<string, string> }[],
    classId: string | undefined,
    dryRun: boolean,
  ) {
    const year = await this.scope.currentYear();
    if (classId) {
      const cls = await this.db.class.findUnique({ where: { id: classId } });
      if (!cls || cls.academicYearId !== year.id)
        throw new BadRequestException('Classe inconnue pour l’année en cours');
    }
    const relationshipOf = (v: string): (typeof GUARDIAN_RELATIONSHIPS)[number] => {
      const s = v.trim().toLowerCase();
      if (s.startsWith('p') || s === 'father') return 'FATHER';
      if (s.startsWith('m') || s === 'mother') return 'MOTHER';
      if (s.startsWith('t')) return 'TUTOR';
      return 'OTHER';
    };
    const toIso = (v: string) => {
      const s = (v ?? '').trim();
      const fr = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
      return fr ? `${fr[3]}-${fr[2]}-${fr[1]}` : s;
    };
    const rows: { line: number; input?: StudentInput; errors: string[] }[] = [];
    const seen = new Map<string, number>();
    for (const { line, raw } of records) {
      const errors = new Map<ImportField, string>();
      const value = (field: ImportField) => importValue(raw, field);
      const guardian = guardianInputSchema.safeParse({
        firstName: value('parent.firstName'),
        lastName: value('parent.lastName'),
        phone: value('parent.phone'),
        relationship: relationshipOf(raw.lien ?? ''),
        isPrimary: true,
      });
      const sex = value('gender').toUpperCase();
      const candidate = studentCreateSchema.safeParse({
        firstName: value('firstName'),
        lastName: value('lastName'),
        // F (fille, féminin) ou M (masculin) ; G (garçon) vaut M. Toute autre valeur est signalée.
        gender: sex.startsWith('F') ? 'F' : sex.startsWith('M') || sex.startsWith('G') ? 'M' : sex,
        birthDate: toIso(value('birthDate')),
        birthPlace: value('birthPlace') || undefined,
        guardians: guardian.success ? [guardian.data] : [],
        classId,
        confirmNotDuplicate: false,
      });
      if (!guardian.success)
        for (const issue of guardian.error.issues) {
          const field = `parent.${String(issue.path[0])}` as ImportField;
          if (field in IMPORT_FIELDS && !errors.has(field))
            errors.set(field, importMessage(field, value(field), issue.message));
        }
      if (!candidate.success)
        for (const issue of candidate.error.issues) {
          const field = String(issue.path[0]) as ImportField;
          if (issue.path[0] === 'guardians' || !(field in IMPORT_FIELDS) || errors.has(field))
            continue;
          errors.set(field, importMessage(field, value(field), issue.message));
        }
      const messages = IMPORT_ORDER.filter((f) => errors.has(f)).map((f) => errors.get(f)!);
      // Ligne refusée sans champ identifié : jamais d'élève ignoré en silence.
      if (!candidate.success && messages.length === 0)
        messages.push(`Ligne invalide : ${candidate.error.issues[0]?.message ?? 'à vérifier'}`);
      if (candidate.success) {
        const key =
          `${candidate.data.lastName}|${candidate.data.firstName}|${candidate.data.birthDate}`.toUpperCase();
        const dup = seen.get(key);
        if (dup) messages.push(`Doublon de la ligne ${dup}`);
        else seen.set(key, line);
        if (messages.length === 0) {
          const existing = await this.findDuplicates({
            ...candidate.data,
            guardianPhones: candidate.data.guardians.map((g) => g.phone),
          });
          if (existing[0])
            messages.push(
              `Existe déjà : ${existing[0].lastName} ${existing[0].firstName} (${existing[0].matricule})`,
            );
        }
      }
      rows.push({ line, input: candidate.success ? candidate.data : undefined, errors: messages });
    }
    // Numéro de parent déjà attribué à un autre parent (base ou ligne précédente du fichier) :
    // jamais de rattachement silencieux à une autre famille.
    const known = await this.knownGuardians(
      rows.flatMap((r) => r.input?.guardians.map((g) => g.phone) ?? []),
    );
    const filePhones = new Map<string, { line: number; firstName: string; lastName: string }>();
    for (const r of rows) {
      const g = r.input?.guardians[0];
      if (!g) continue;
      const existing = known.find((k) => k.phone === g.phone);
      if (existing) {
        if (!sameGuardianName(g, existing))
          r.errors.push(
            `Téléphone du parent : ce numéro appartient déjà à ${existing.label} ; reprenez le nom de ce parent ou corrigez le numéro`,
          );
        continue;
      }
      const earlier = filePhones.get(g.phone);
      if (!earlier) filePhones.set(g.phone, { line: r.line, ...g });
      else if (!sameGuardianName(g, earlier))
        r.errors.push(
          `Téléphone du parent : même numéro qu’à la ligne ${earlier.line}, pour un autre parent (${earlier.firstName} ${earlier.lastName})`,
        );
    }
    const invalid = rows.filter((r) => r.errors.length > 0);
    const report = {
      total: rows.length,
      valid: rows.length - invalid.length,
      errors: invalid.map((r) => ({ line: r.line, messages: r.errors })),
      created: 0,
    };
    if (dryRun || invalid.length > 0 || rows.length === 0) return report;
    await this.db.$transaction(
      async (tx) => {
        for (const r of rows) if (r.input) await this.createInTx(tx, r.input, year.id);
        await this.audit.log(
          {
            action: 'students.imported',
            entity: 'Student',
            after: { count: rows.length, classId },
          },
          tx,
        );
      },
      { timeout: 60_000 },
    );
    return { ...report, created: rows.length };
  }

  private async ensureStudent(id: string) {
    const student = await this.db.student.findUnique({ where: { id } });
    if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    return student;
  }
}
