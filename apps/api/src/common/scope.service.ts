import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isClassScoped, type Permission } from '@ecole/shared';
import { currentContext } from './context';
import { Db, InjectDb, Tx } from './prisma';

/** Règles de périmètre partagées : année en cours, accès d'un enseignant à ses classes. */
@Injectable()
export class ScopeService {
  constructor(@InjectDb() private readonly db: Db) {}

  async currentYear(tx?: Tx) {
    const year = await (tx ?? this.db).academicYear.findFirst({ where: { isCurrent: true } });
    if (!year)
      throw new ConflictException(
        'Aucune année scolaire en cours : définissez-la dans la structure académique',
      );
    return year;
  }

  /** Vrai si la permission ne vient que du rôle enseignant (accès limité à ses classes). */
  isClassScoped(permission: Permission): boolean {
    const ctx = currentContext();
    return ctx?.kind === 'staff' && isClassScoped(ctx.roles, permission);
  }

  can(permission: Permission): boolean {
    const ctx = currentContext();
    return ctx?.kind === 'staff' && ctx.permissions.has(permission);
  }

  userId(): string | undefined {
    const ctx = currentContext();
    return ctx?.kind === 'staff' ? ctx.userId : undefined;
  }

  async classSubject(classSubjectId: string, permission: Permission) {
    const cs = await this.db.classSubject.findUnique({
      where: { id: classSubjectId },
      include: { class: true, subject: true },
    });
    if (!cs) throw new NotFoundException('Matière de classe introuvable');
    if (this.isClassScoped(permission) && cs.teacherId !== this.userId()) {
      throw new ForbiddenException('Vous n’enseignez pas cette matière dans cette classe');
    }
    return cs;
  }

  async classForTeacher(classId: string, permission: Permission) {
    const cls = await this.db.class.findUnique({
      where: { id: classId },
      include: { level: true },
    });
    if (!cls) throw new NotFoundException('Classe introuvable');
    if (this.isClassScoped(permission)) {
      const userId = this.userId();
      const teaches = await this.db.classSubject.count({ where: { classId, teacherId: userId } });
      if (teaches === 0 && cls.mainTeacherId !== userId)
        throw new ForbiddenException('Vous n’intervenez pas dans cette classe');
    }
    return cls;
  }

  /** Classes de l'année en cours où l'utilisateur enseigne ou est professeur principal. */
  async teacherClassIds(): Promise<string[]> {
    const year = await this.currentYear();
    const userId = this.userId();
    const classes = await this.db.class.findMany({
      where: {
        academicYearId: year.id,
        OR: [{ mainTeacherId: userId }, { subjects: { some: { teacherId: userId } } }],
      },
      select: { id: true },
    });
    return classes.map((c) => c.id);
  }

  /**
   * Un enseignant ne voit que les élèves de ses classes de l'année en cours. Hors de son périmètre,
   * l'élève est signalé introuvable, pour ne pas révéler son existence.
   */
  async assertStudentInScope(studentId: string, permission: Permission): Promise<void> {
    if (!this.isClassScoped(permission)) return;
    const classIds = await this.teacherClassIds();
    const enrolled = await this.db.enrollment.count({
      where: { studentId, classId: { in: classIds } },
    });
    if (enrolled === 0) throw new NotFoundException('Élève introuvable');
  }

  /** Élèves inscrits (non sortis) d'une classe, triés par nom. */
  async classStudents(classId: string, tx?: Tx) {
    const enrollments = await (tx ?? this.db).enrollment.findMany({
      where: { classId, status: { in: ['ENROLLED', 'REPEATING'] }, student: { deletedAt: null } },
      include: { student: true },
    });
    return enrollments
      .map((e) => e.student)
      .sort(
        (a, b) =>
          a.lastName.localeCompare(b.lastName, 'fr') ||
          a.firstName.localeCompare(b.firstName, 'fr'),
      );
  }
}
