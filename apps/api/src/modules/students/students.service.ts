import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  assessDuplicate,
  formatMatricule,
  GUARDIAN_RELATIONSHIPS,
  guardianInputSchema,
  normalizeCameroonPhone,
  studentCreateSchema,
  studentUpdateSchema,
  type GuardianInput,
} from '@ecole/shared';
import { EnrollmentStatus, Prisma } from '@prisma/client';
import Papa from 'papaparse';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId } from '../../common/context';
import { CountersService } from '../../common/counters.service';
import { decrypt, encrypt } from '../../common/crypto';
import { fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
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
              { lastName: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { matricule: { contains: search, mode: 'insensitive' } },
              ...(phone ? [{ guardians: { some: { guardian: { phone } } } }] : []),
            ],
          }
        : {}),
    };
    const [total, students, statusCounts] = await Promise.all([
      this.db.student.count({ where }),
      this.db.student.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
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
        previousSchool: input.previousSchool,
      },
    });
    for (const g of input.guardians) await this.linkGuardian(tx, student.id, g);
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
      },
    });
    if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    await this.scope.assertStudentInScope(id, 'students.read');
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

  async update(id: string, input: z.infer<typeof studentUpdateSchema>) {
    const before = await this.ensureStudent(id);
    const after = await this.db.student.update({
      where: { id },
      data: { ...input, birthDate: input.birthDate ? toDbDate(input.birthDate) : undefined },
    });
    await this.audit.log({
      action: 'students.updated',
      entity: 'Student',
      entityId: id,
      before,
      after,
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

  /** Inscription pour l'année en cours (nouvelle classe, redoublement). */
  async enroll(studentId: string, classId: string, status: 'ENROLLED' | 'REPEATING') {
    await this.ensureStudent(studentId);
    const year = await this.scope.currentYear();
    const cls = await this.db.class.findUnique({ where: { id: classId } });
    if (!cls || cls.academicYearId !== year.id)
      throw new BadRequestException('Classe inconnue pour l’année en cours');
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

  async changeEnrollment(
    enrollmentId: string,
    input: { classId?: string; status?: EnrollmentStatus },
  ) {
    const before = await this.db.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!before) throw new NotFoundException('Inscription introuvable');
    if (input.classId) {
      const cls = await this.db.class.findUnique({ where: { id: input.classId } });
      if (!cls || cls.academicYearId !== before.academicYearId)
        throw new BadRequestException('La classe doit appartenir à la même année');
    }
    const after = await this.db.enrollment.update({ where: { id: enrollmentId }, data: input });
    await this.audit.log({
      action: 'enrollments.changed',
      entity: 'Enrollment',
      entityId: enrollmentId,
      before,
      after,
    });
    return after;
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
      parsed.data.map((raw, i) => ({ line: i + 2, raw })),
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
      const errors: string[] = [];
      const guardian = guardianInputSchema.safeParse({
        firstName: raw.parent_prenom ?? raw.parent_prenoms ?? '',
        lastName: raw.parent_nom ?? '',
        phone: raw.parent_telephone ?? raw.telephone ?? '',
        relationship: relationshipOf(raw.lien ?? ''),
        isPrimary: true,
      });
      const candidate = studentCreateSchema.safeParse({
        firstName: raw.prenoms ?? raw.prenom ?? '',
        lastName: raw.nom ?? '',
        gender: (raw.sexe ?? '').trim().toUpperCase().startsWith('F')
          ? 'F'
          : (raw.sexe ?? '').trim().toUpperCase().startsWith('M')
            ? 'M'
            : '',
        birthDate: toIso(raw.date_naissance ?? ''),
        birthPlace: raw.lieu_naissance || undefined,
        guardians: guardian.success ? [guardian.data] : [],
        classId,
        confirmNotDuplicate: false,
      });
      if (!guardian.success)
        errors.push(
          ...guardian.error.issues.map((e) => `Parent (${e.path.join('.')}) : ${e.message}`),
        );
      if (!candidate.success)
        errors.push(
          ...candidate.error.issues
            .filter((e) => e.path[0] !== 'guardians')
            .map((e) => `${e.path.join('.')} : ${e.message}`),
        );
      if (candidate.success) {
        const key =
          `${candidate.data.lastName}|${candidate.data.firstName}|${candidate.data.birthDate}`.toUpperCase();
        const dup = seen.get(key);
        if (dup) errors.push(`Doublon de la ligne ${dup}`);
        else seen.set(key, line);
        if (errors.length === 0) {
          const existing = await this.findDuplicates({
            ...candidate.data,
            guardianPhones: candidate.data.guardians.map((g) => g.phone),
          });
          if (existing[0])
            errors.push(
              `Existe déjà : ${existing[0].lastName} ${existing[0].firstName} (${existing[0].matricule})`,
            );
        }
      }
      rows.push({ line, input: candidate.success ? candidate.data : undefined, errors });
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
