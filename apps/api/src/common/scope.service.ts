import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isTeacherOnly } from '@ecole/shared';
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

  /** Vrai si l'utilisateur courant n'a que le rôle enseignant (accès limité à ses classes). */
  isTeacherOnly(): boolean {
    const ctx = currentContext();
    return ctx?.kind === 'staff' && isTeacherOnly(ctx.roles);
  }

  userId(): string | undefined {
    const ctx = currentContext();
    return ctx?.kind === 'staff' ? ctx.userId : undefined;
  }

  async classSubjectForWrite(classSubjectId: string) {
    const cs = await this.db.classSubject.findUnique({
      where: { id: classSubjectId },
      include: { class: true, subject: true },
    });
    if (!cs) throw new NotFoundException('Matière de classe introuvable');
    if (this.isTeacherOnly() && cs.teacherId !== this.userId()) {
      throw new ForbiddenException('Vous n’enseignez pas cette matière dans cette classe');
    }
    return cs;
  }

  async classForTeacher(classId: string) {
    const cls = await this.db.class.findUnique({
      where: { id: classId },
      include: { level: true },
    });
    if (!cls) throw new NotFoundException('Classe introuvable');
    if (this.isTeacherOnly()) {
      const userId = this.userId();
      const teaches = await this.db.classSubject.count({ where: { classId, teacherId: userId } });
      if (teaches === 0 && cls.mainTeacherId !== userId)
        throw new ForbiddenException('Vous n’intervenez pas dans cette classe');
    }
    return cls;
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
