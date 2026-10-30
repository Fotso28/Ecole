import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ADMIN_DOCUMENT_LABELS,
  ADMIN_DOCUMENT_TYPES,
  DEFAULT_DOCUMENT_TEMPLATES,
  documentCounterKey,
  documentListSchema,
  documentTemplateSchema,
  formatDocumentNumber,
  type AdminDocumentType,
  type DocumentTemplateContent,
} from '@ecole/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId } from '../../common/context';
import { CountersService } from '../../common/counters.service';
import { verificationCode } from '../../common/crypto';
import { fromDbDate } from '../../common/dates';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';

/** Instantané figé d'un document délivré : il ne dépend plus de la fiche élève ensuite. */
export interface AdminDocumentData {
  school: { name: string; city: string; address: string | null; phone: string | null };
  template: DocumentTemplateContent;
  student: {
    firstName: string;
    lastName: string;
    matricule: string;
    gender: 'F' | 'M';
    birthDate: string;
    birthPlace: string | null;
    nationality: string;
    /** Clé de la photo d'identité (carte d'élève), quand le stockage de fichiers la fournira. */
    photoKey: string | null;
  };
  class: { name: string; level: string };
  year: { name: string; startDate: string; endDate: string };
  enrollmentStatus: 'ENROLLED' | 'REPEATING';
  /** Document d'origine, pour un duplicata. */
  duplicateOf: { number: string; issuedAt: string } | null;
}

type ListQuery = z.infer<typeof documentListSchema>;
type TemplateInput = z.infer<typeof documentTemplateSchema>;

@Injectable()
export class DocumentsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly counters: CountersService,
    private readonly audit: AuditService,
  ) {}

  /** Modèles des trois documents, complétés par les valeurs par défaut. */
  async templates() {
    const rows = await this.db.documentTemplate.findMany();
    return ADMIN_DOCUMENT_TYPES.map((type) => {
      const row = rows.find((r) => r.type === type);
      return {
        type,
        label: ADMIN_DOCUMENT_LABELS[type],
        customized: !!row,
        ...this.merge(type, row),
      };
    });
  }

  private merge(
    type: AdminDocumentType,
    row:
      | {
          title: string | null;
          headerLines: string[];
          signatoryName: string | null;
          signatoryTitle: string | null;
          mentions: string | null;
        }
      | null
      | undefined,
  ): DocumentTemplateContent {
    const d = DEFAULT_DOCUMENT_TEMPLATES[type];
    return {
      title: row?.title || d.title,
      headerLines: row?.headerLines.length ? row.headerLines : d.headerLines,
      signatoryName: row?.signatoryName || d.signatoryName,
      signatoryTitle: row?.signatoryTitle || d.signatoryTitle,
      mentions: row?.mentions || d.mentions,
    };
  }

  async saveTemplate(type: AdminDocumentType, input: TemplateInput) {
    const before = await this.db.documentTemplate.findFirst({ where: { type } });
    const data = {
      title: input.title ?? null,
      headerLines: input.headerLines.filter((l) => l.length > 0),
      signatoryName: input.signatoryName ?? null,
      signatoryTitle: input.signatoryTitle ?? null,
      mentions: input.mentions ?? null,
      updatedById: currentActorId() ?? null,
    };
    const after = await this.db.documentTemplate.upsert({
      where: { schoolId_type: { schoolId: currentSchoolId(), type } },
      create: { schoolId: currentSchoolId(), type, ...data },
      update: data,
    });
    await this.audit.log({
      action: 'documents.template_updated',
      entity: 'DocumentTemplate',
      entityId: after.id,
      before,
      after,
    });
    return {
      type,
      label: ADMIN_DOCUMENT_LABELS[type],
      customized: true,
      ...this.merge(type, after),
    };
  }

  /** Délivre un document pour l'année en cours, rempli depuis la fiche élève. */
  async issue(studentId: string, type: AdminDocumentType) {
    const student = await this.db.student.findUnique({ where: { id: studentId } });
    if (!student || student.deletedAt) throw new NotFoundException('Élève introuvable');
    const year = await this.scope.currentYear();
    const enrollment = await this.db.enrollment.findFirst({
      where: { studentId, academicYearId: year.id, status: { in: ['ENROLLED', 'REPEATING'] } },
      include: { class: { include: { level: true } } },
    });
    if (!enrollment)
      throw new ConflictException('L’élève n’est pas inscrit pour l’année scolaire en cours');
    const [school, templateRow] = await Promise.all([
      this.db.school.findUniqueOrThrow({ where: { id: currentSchoolId() } }),
      this.db.documentTemplate.findFirst({ where: { type } }),
    ]);
    const data: AdminDocumentData = {
      school: {
        name: school.name,
        city: school.city,
        address: school.address,
        phone: school.phone,
      },
      template: this.merge(type, templateRow),
      student: {
        firstName: student.firstName,
        lastName: student.lastName,
        matricule: student.matricule,
        gender: student.gender,
        birthDate: fromDbDate(student.birthDate),
        birthPlace: student.birthPlace,
        nationality: student.nationality,
        photoKey: null,
      },
      class: { name: enrollment.class.name, level: enrollment.class.level.name },
      year: {
        name: year.name,
        startDate: fromDbDate(year.startDate),
        endDate: fromDbDate(year.endDate),
      },
      enrollmentStatus: enrollment.status === 'REPEATING' ? 'REPEATING' : 'ENROLLED',
      duplicateOf: null,
    };
    return this.record(type, year.id, studentId, data, null);
  }

  /** Duplicata : copie conforme du document d'origine, enregistrée sous un nouveau numéro. */
  async duplicate(id: string) {
    const original = await this.db.adminDocument.findUnique({ where: { id } });
    if (!original) throw new NotFoundException('Document introuvable');
    if (original.status === 'CANCELLED')
      throw new ConflictException('Un document annulé ne peut pas faire l’objet d’un duplicata');
    const source = original.data as unknown as AdminDocumentData;
    const data: AdminDocumentData = {
      ...source,
      duplicateOf: source.duplicateOf ?? {
        number: original.number,
        issuedAt: original.issuedAt.toISOString(),
      },
    };
    return this.record(
      original.type,
      original.academicYearId,
      original.studentId,
      data,
      original.duplicateOfId ?? original.id,
    );
  }

  /**
   * Numéro attribué dans la même transaction que l'enregistrement : le compteur avance
   * atomiquement (aucun doublon) et revient en arrière si l'écriture échoue (aucun trou).
   */
  private async record(
    type: AdminDocumentType,
    academicYearId: string,
    studentId: string,
    data: AdminDocumentData,
    duplicateOfId: string | null,
  ) {
    const doc = await this.db.$transaction(async (tx: Tx) => {
      const sequence = await this.counters.next(documentCounterKey(type, academicYearId), tx);
      const created = await tx.adminDocument.create({
        data: {
          schoolId: currentSchoolId(),
          type,
          number: formatDocumentNumber(type, data.year.name, sequence),
          sequence,
          academicYearId,
          studentId,
          data: data as unknown as Prisma.InputJsonValue,
          verificationCode: verificationCode(12),
          duplicateOfId,
          photoKey: data.student.photoKey,
          issuedById: currentActorId() ?? '',
        },
      });
      await this.audit.log(
        {
          action: duplicateOfId ? 'documents.duplicated' : 'documents.issued',
          entity: 'AdminDocument',
          entityId: created.id,
          after: { type, number: created.number, studentId, duplicateOfId },
        },
        tx,
      );
      return created;
    });
    return this.view(doc);
  }

  async cancel(id: string, reason: string) {
    const doc = await this.db.adminDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document introuvable');
    if (doc.status === 'CANCELLED') throw new ConflictException('Ce document est déjà annulé');
    const updated = await this.db.$transaction(async (tx: Tx) => {
      const res = await tx.adminDocument.updateMany({
        where: { id, status: 'ISSUED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledById: currentActorId() ?? null,
          cancelReason: reason,
        },
      });
      if (res.count !== 1) throw new ConflictException('Ce document est déjà annulé');
      await this.audit.log(
        {
          action: 'documents.cancelled',
          entity: 'AdminDocument',
          entityId: id,
          before: { status: 'ISSUED', number: doc.number },
          after: { status: 'CANCELLED' },
          reason,
        },
        tx,
      );
      return tx.adminDocument.findUniqueOrThrow({ where: { id } });
    });
    return this.view(updated);
  }

  async get(id: string) {
    const doc = await this.db.adminDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document introuvable');
    return doc;
  }

  /** Registre des documents délivrés, du plus récent au plus ancien. */
  async list(q: ListQuery) {
    const search = q.search?.trim();
    const where: Prisma.AdminDocumentWhereInput = {
      ...(q.type ? { type: q.type } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.studentId ? { studentId: q.studentId } : {}),
    };
    if (search) {
      const students = await this.db.student.findMany({
        where: {
          OR: [
            { lastName: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { matricule: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: 200,
      });
      where.OR = [
        { number: { contains: search, mode: 'insensitive' } },
        { studentId: { in: students.map((s) => s.id) } },
      ];
    }
    const [total, rows] = await Promise.all([
      this.db.adminDocument.count({ where }),
      this.db.adminDocument.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.issuedById, r.cancelledById]).filter((x): x is string => !!x),
      ),
    ];
    const users = await this.db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const name = (userId: string | null) => {
      const u = users.find((x) => x.id === userId);
      return u ? `${u.firstName} ${u.lastName}` : null;
    };
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((r) => ({
        ...this.view(r),
        issuedBy: name(r.issuedById),
        cancelledBy: name(r.cancelledById),
      })),
    };
  }

  /** Vue de liste : l'instantané complet reste côté serveur (PDF, vérification). */
  view(doc: {
    id: string;
    type: AdminDocumentType;
    number: string;
    studentId: string;
    data: Prisma.JsonValue;
    verificationCode: string;
    status: 'ISSUED' | 'CANCELLED';
    duplicateOfId: string | null;
    issuedAt: Date;
    cancelledAt: Date | null;
    cancelReason: string | null;
  }) {
    const data = doc.data as unknown as AdminDocumentData;
    return {
      id: doc.id,
      type: doc.type,
      label: ADMIN_DOCUMENT_LABELS[doc.type],
      number: doc.number,
      status: doc.status,
      verificationCode: doc.verificationCode,
      student: {
        id: doc.studentId,
        firstName: data.student.firstName,
        lastName: data.student.lastName,
        matricule: data.student.matricule,
      },
      class: data.class.name,
      year: data.year.name,
      duplicateOf: data.duplicateOf?.number ?? null,
      issuedAt: doc.issuedAt,
      cancelledAt: doc.cancelledAt,
      cancelReason: doc.cancelReason,
    };
  }

  static assertType(type: string): AdminDocumentType {
    if (!(ADMIN_DOCUMENT_TYPES as readonly string[]).includes(type))
      throw new BadRequestException('Type de document inconnu');
    return type as AdminDocumentType;
  }
}
