import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  courseMaterialSchema,
  lessonLogQuerySchema,
  lessonLogSchema,
  type LessonLogInput,
} from '@ecole/shared';
import type { CourseMaterial, LessonLog, Prisma, StoredFile } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId } from '../../common/context';
import { fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { FileUpload } from '../files/files.module';
import { FilesService, presentFile, type UploadedFile as Upload } from '../files/files.service';

type MaterialWithFile = CourseMaterial & { file: StoredFile };

interface Labels {
  classes: Map<string, string>;
  subjects: Map<string, string>;
  authors: Map<string, string>;
}

function presentMaterial(m: MaterialWithFile, labels?: Labels) {
  return {
    id: m.id,
    title: m.title,
    classId: m.classId,
    className: labels?.classes.get(m.classId) ?? null,
    classSubjectId: m.classSubjectId,
    subjectName: labels?.subjects.get(m.classSubjectId) ?? null,
    lessonLogId: m.lessonLogId,
    createdAt: m.createdAt,
    file: presentFile(m.file),
  };
}

/**
 * Cahier de texte et supports de cours. L'enseignant saisit les séances de ses classes et matières ;
 * le censeur et la direction consultent tout ; les parents voient les devoirs et supports de la
 * classe de leur enfant (portail).
 */
@Injectable()
export class LessonsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  /** Libellés des classes, matières et auteurs, chargés en une fois. */
  private async labels(classSubjectIds: string[], authorIds: string[]): Promise<Labels> {
    const [classSubjects, authors] = await Promise.all([
      this.db.classSubject.findMany({
        where: { id: { in: [...new Set(classSubjectIds)] } },
        include: { class: { select: { id: true, name: true } }, subject: true },
      }),
      authorIds.length
        ? this.db.user.findMany({
            where: { id: { in: [...new Set(authorIds)] } },
            select: { id: true, firstName: true, lastName: true },
          })
        : [],
    ]);
    return {
      classes: new Map(classSubjects.map((c) => [c.classId, c.class.name])),
      subjects: new Map(classSubjects.map((c) => [c.id, c.subject.name])),
      authors: new Map(authors.map((a) => [a.id, `${a.firstName} ${a.lastName}`])),
    };
  }

  private present(
    l: LessonLog & { materials: MaterialWithFile[] },
    labels: Labels,
    writable: ReadonlySet<string>,
    withAuthor = true,
  ) {
    return {
      id: l.id,
      classId: l.classId,
      className: labels.classes.get(l.classId) ?? null,
      classSubjectId: l.classSubjectId,
      subjectName: labels.subjects.get(l.classSubjectId) ?? null,
      date: fromDbDate(l.date),
      startTime: l.startTime,
      content: l.content,
      homework: l.homework,
      homeworkDueDate: l.homeworkDueDate ? fromDbDate(l.homeworkDueDate) : null,
      author: withAuthor ? (labels.authors.get(l.authorId) ?? null) : null,
      canEdit: writable.has(l.classSubjectId),
      updatedAt: l.updatedAt,
      materials: l.materials
        .filter((m) => !m.deletedAt && !m.file.deletedAt)
        .map((m) => presentMaterial(m, labels)),
    };
  }

  /** Matières de classe de l'année en cours visibles par l'utilisateur, avec le droit d'écriture. */
  async classSubjects() {
    const year = await this.scope.currentYear();
    const userId = this.scope.userId();
    const readScoped = this.scope.isClassScoped('lessons.read');
    const classIds = readScoped ? await this.scope.teacherClassIds() : null;
    const items = await this.db.classSubject.findMany({
      where: {
        class: { academicYearId: year.id },
        ...(classIds ? { classId: { in: classIds } } : {}),
      },
      include: { class: { select: { name: true } }, subject: { select: { name: true } } },
      orderBy: [{ class: { name: 'asc' } }, { subject: { name: 'asc' } }],
    });
    return items.map((c) => ({
      id: c.id,
      classId: c.classId,
      className: c.class.name,
      subjectName: c.subject.name,
      canWrite: this.writeAllowed(c.teacherId, userId),
    }));
  }

  private writeAllowed(teacherId: string | null, userId: string | undefined): boolean {
    if (!this.scope.can('lessons.write')) return false;
    return !this.scope.isClassScoped('lessons.write') || teacherId === userId;
  }

  /** Classes lisibles : toutes, ou celles où l'enseignant intervient. */
  private async readableClassIds(classId?: string): Promise<string[] | null> {
    if (classId) {
      await this.scope.classForTeacher(classId, 'lessons.read');
      return [classId];
    }
    return this.scope.isClassScoped('lessons.read') ? this.scope.teacherClassIds() : null;
  }

  async list(q: z.infer<typeof lessonLogQuerySchema>) {
    let classIds: string[] | null;
    if (q.classSubjectId) {
      const cs = await this.db.classSubject.findUnique({ where: { id: q.classSubjectId } });
      if (!cs) throw new NotFoundException('Matière de classe introuvable');
      classIds = await this.readableClassIds(cs.classId);
    } else {
      classIds = await this.readableClassIds(q.classId);
    }
    const where: Prisma.LessonLogWhereInput = {
      deletedAt: null,
      ...(classIds ? { classId: { in: classIds } } : {}),
      ...(q.classSubjectId ? { classSubjectId: q.classSubjectId } : {}),
      ...(q.from || q.to
        ? {
            date: {
              ...(q.from ? { gte: toDbDate(q.from) } : {}),
              ...(q.to ? { lte: toDbDate(q.to) } : {}),
            },
          }
        : {}),
    };
    const items = await this.db.lessonLog.findMany({
      where,
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: { materials: { include: { file: true }, orderBy: { createdAt: 'asc' } } },
    });
    const labels = await this.labels(
      items.map((i) => i.classSubjectId),
      items.map((i) => i.authorId),
    );
    const writable = await this.writableIds(items.map((i) => i.classSubjectId));
    return items.map((i) => this.present(i, labels, writable));
  }

  /** Matières de classe, parmi celles données, dont l'utilisateur peut écrire le cahier. */
  private async writableIds(classSubjectIds: string[]): Promise<Set<string>> {
    const userId = this.scope.userId();
    const items = await this.db.classSubject.findMany({
      where: { id: { in: [...new Set(classSubjectIds)] } },
      select: { id: true, teacherId: true },
    });
    return new Set(items.filter((c) => this.writeAllowed(c.teacherId, userId)).map((c) => c.id));
  }

  async create(input: LessonLogInput) {
    const cs = await this.scope.classSubject(input.classSubjectId, 'lessons.write');
    const entry = await this.db.lessonLog.create({
      data: {
        schoolId: currentSchoolId(),
        classId: cs.classId,
        classSubjectId: cs.id,
        date: toDbDate(input.date),
        startTime: input.startTime ?? null,
        content: input.content,
        homework: input.homework ?? null,
        homeworkDueDate: input.homeworkDueDate ? toDbDate(input.homeworkDueDate) : null,
        authorId: currentActorId() ?? '',
      },
    });
    await this.audit.log({
      action: 'lessons.created',
      entity: 'LessonLog',
      entityId: entry.id,
      after: input,
    });
    return this.one(entry.id);
  }

  private async editable(id: string) {
    const entry = await this.db.lessonLog.findUnique({ where: { id } });
    if (!entry || entry.deletedAt) throw new NotFoundException('Séance introuvable');
    await this.scope.classSubject(entry.classSubjectId, 'lessons.write');
    return entry;
  }

  async update(id: string, input: LessonLogInput) {
    const before = await this.editable(id);
    if (input.classSubjectId !== before.classSubjectId)
      throw new ForbiddenException('La classe et la matière d’une séance ne changent pas');
    await this.db.lessonLog.update({
      where: { id },
      data: {
        date: toDbDate(input.date),
        startTime: input.startTime ?? null,
        content: input.content,
        homework: input.homework ?? null,
        homeworkDueDate: input.homeworkDueDate ? toDbDate(input.homeworkDueDate) : null,
      },
    });
    await this.audit.log({
      action: 'lessons.updated',
      entity: 'LessonLog',
      entityId: id,
      before: { content: before.content, homework: before.homework },
      after: input,
    });
    return this.one(id);
  }

  async remove(id: string) {
    await this.editable(id);
    await this.db.lessonLog.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({ action: 'lessons.deleted', entity: 'LessonLog', entityId: id });
    return { ok: true };
  }

  private async one(id: string) {
    const entry = await this.db.lessonLog.findUniqueOrThrow({
      where: { id },
      include: { materials: { include: { file: true } } },
    });
    const labels = await this.labels([entry.classSubjectId], [entry.authorId]);
    const writable = await this.writableIds([entry.classSubjectId]);
    return this.present(entry, labels, writable);
  }

  async materials(q: { classId?: string; classSubjectId?: string }) {
    let classIds: string[] | null;
    if (q.classSubjectId) {
      const cs = await this.db.classSubject.findUnique({ where: { id: q.classSubjectId } });
      if (!cs) throw new NotFoundException('Matière de classe introuvable');
      classIds = await this.readableClassIds(cs.classId);
    } else {
      classIds = await this.readableClassIds(q.classId);
    }
    const items = await this.db.courseMaterial.findMany({
      where: {
        deletedAt: null,
        file: { deletedAt: null },
        ...(classIds ? { classId: { in: classIds } } : {}),
        ...(q.classSubjectId ? { classSubjectId: q.classSubjectId } : {}),
      },
      include: { file: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const labels = await this.labels(
      items.map((i) => i.classSubjectId),
      [],
    );
    return items.map((m) => presentMaterial(m, labels));
  }

  async addMaterial(input: z.infer<typeof courseMaterialSchema>, upload: Upload | undefined) {
    const cs = await this.scope.classSubject(input.classSubjectId, 'lessons.write');
    if (input.lessonLogId) {
      const entry = await this.db.lessonLog.findUnique({ where: { id: input.lessonLogId } });
      if (!entry || entry.deletedAt || entry.classSubjectId !== cs.id)
        throw new NotFoundException('Séance introuvable pour cette classe et cette matière');
    }
    this.files.validate(upload);
    const material = await this.db.$transaction(async (tx) => {
      const file = await this.files.store(upload, 'COURSE_MATERIAL', tx);
      const created = await tx.courseMaterial.create({
        data: {
          schoolId: currentSchoolId(),
          classId: cs.classId,
          classSubjectId: cs.id,
          lessonLogId: input.lessonLogId ?? null,
          title: input.title,
          fileId: file.id,
          uploadedById: currentActorId() ?? '',
        },
        include: { file: true },
      });
      await this.audit.log(
        {
          action: 'lessons.material_added',
          entity: 'CourseMaterial',
          entityId: created.id,
          after: { title: input.title, classSubjectId: cs.id, lessonLogId: input.lessonLogId },
        },
        tx,
      );
      return created;
    });
    const labels = await this.labels([cs.id], []);
    return presentMaterial(material, labels);
  }

  async removeMaterial(id: string) {
    const material = await this.db.courseMaterial.findUnique({ where: { id } });
    if (!material || material.deletedAt) throw new NotFoundException('Support introuvable');
    await this.scope.classSubject(material.classSubjectId, 'lessons.write');
    await this.db.$transaction(async (tx) => {
      await tx.courseMaterial.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.files.softDelete(material.fileId, 'Support de cours retiré', tx);
    });
    return { ok: true };
  }

  async materialLink(id: string) {
    const material = await this.db.courseMaterial.findUnique({ where: { id } });
    if (!material || material.deletedAt) throw new NotFoundException('Support introuvable');
    await this.scope.classForTeacher(material.classId, 'lessons.read');
    return this.files.link(material.fileId);
  }

  /**
   * Portail parent (contexte système limité à l'école de l'enfant) : devoirs à faire à partir
   * d'aujourd'hui et supports de cours de la classe.
   */
  async forParents(classId: string) {
    const today = toDbDate(todayInCameroon());
    const [homework, materials] = await Promise.all([
      this.db.lessonLog.findMany({
        where: { classId, deletedAt: null, homeworkDueDate: { gte: today } },
        orderBy: [{ homeworkDueDate: 'asc' }, { date: 'asc' }],
        take: 100,
        include: { materials: { include: { file: true } } },
      }),
      this.db.courseMaterial.findMany({
        where: { classId, deletedAt: null, file: { deletedAt: null } },
        include: { file: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    const labels = await this.labels(
      [...homework.map((h) => h.classSubjectId), ...materials.map((m) => m.classSubjectId)],
      [],
    );
    const none = new Set<string>();
    return {
      homework: homework.map((h) => {
        const p = this.present(h, labels, none, false);
        return {
          id: p.id,
          subjectName: p.subjectName,
          date: p.date,
          content: p.content,
          homework: p.homework,
          homeworkDueDate: p.homeworkDueDate,
          materials: p.materials,
        };
      }),
      materials: materials.map((m) => presentMaterial(m, labels)),
    };
  }

  /** Portail parent : lien d'un support, après vérification par l'appelant du lien parent-classe. */
  async materialFile(id: string) {
    const material = await this.db.courseMaterial.findUnique({ where: { id } });
    if (!material || material.deletedAt) throw new NotFoundException('Support introuvable');
    return this.files.link(material.fileId);
  }
}

const materialsQuerySchema = z.object({
  classId: z.string().min(1).optional(),
  classSubjectId: z.string().min(1).optional(),
});

@ApiTags('lessons')
@ApiBearerAuth()
@Controller('lessons')
export class LessonsController {
  constructor(private readonly lessons: LessonsService) {}

  @RequirePermissions('lessons.read')
  @Get('class-subjects')
  classSubjects() {
    return this.lessons.classSubjects();
  }

  @RequirePermissions('lessons.read')
  @Get()
  list(@Query(new ZodPipe(lessonLogQuerySchema)) q: z.infer<typeof lessonLogQuerySchema>) {
    return this.lessons.list(q);
  }

  @RequirePermissions('lessons.write')
  @Post()
  create(@Body(new ZodPipe(lessonLogSchema)) body: LessonLogInput) {
    return this.lessons.create(body);
  }

  @RequirePermissions('lessons.read')
  @Get('materials')
  materials(@Query(new ZodPipe(materialsQuerySchema)) q: z.infer<typeof materialsQuerySchema>) {
    return this.lessons.materials(q);
  }

  @RequirePermissions('lessons.write')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileUpload)
  @Post('materials')
  addMaterial(
    @Body(new ZodPipe(courseMaterialSchema)) body: z.infer<typeof courseMaterialSchema>,
    @UploadedFile() file: Upload | undefined,
  ) {
    return this.lessons.addMaterial(body, file);
  }

  @RequirePermissions('lessons.write')
  @Delete('materials/:id')
  removeMaterial(@Param('id') id: string) {
    return this.lessons.removeMaterial(id);
  }

  @RequirePermissions('lessons.read')
  @Get('materials/:id/file')
  materialFile(@Param('id') id: string) {
    return this.lessons.materialLink(id);
  }

  @RequirePermissions('lessons.write')
  @Put(':id')
  update(@Param('id') id: string, @Body(new ZodPipe(lessonLogSchema)) body: LessonLogInput) {
    return this.lessons.update(id, body);
  }

  @RequirePermissions('lessons.write')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.lessons.remove(id);
  }
}

@Module({
  controllers: [LessonsController],
  providers: [LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
