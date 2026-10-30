import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { currentSchoolId, staffContext } from '../../common/context';
import { todayInCameroon, toDbDate } from '../../common/dates';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';

@Injectable()
export class TeacherService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Journée de l'enseignant : ses classes, et selon les modules activés par l'école, ses cours
   * du jour (emploi du temps) et les appels déjà faits.
   */
  async today() {
    const userId = staffContext().userId;
    const year = await this.scope.currentYear();
    const today = todayInCameroon();
    const dayOfWeek = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const { modules } = await this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { modules: true },
    });
    const [classSubjects, entries, sessions] = await Promise.all([
      this.db.classSubject.findMany({
        where: { teacherId: userId, class: { academicYearId: year.id } },
        include: {
          class: {
            include: {
              _count: {
                select: { enrollments: { where: { status: { in: ['ENROLLED', 'REPEATING'] } } } },
              },
            },
          },
          subject: true,
        },
        orderBy: [{ class: { name: 'asc' } }, { subject: { name: 'asc' } }],
      }),
      modules.includes('timetable')
        ? this.db.timetableEntry.findMany({
            where: { teacherId: userId, academicYearId: year.id, dayOfWeek },
            orderBy: { startTime: 'asc' },
          })
        : Promise.resolve([]),
      modules.includes('attendance')
        ? this.db.attendanceSession.findMany({
            where: { takenById: userId, date: toDbDate(today) },
            select: { classId: true, startTime: true },
          })
        : Promise.resolve([]),
    ]);
    const byCs = new Map(classSubjects.map((c) => [c.id, c]));
    return {
      today,
      lessons: entries.map((e) => {
        const cs = byCs.get(e.classSubjectId);
        return {
          id: e.id,
          startTime: e.startTime,
          endTime: e.endTime,
          classId: e.classId,
          className: cs?.class.name ?? '',
          classSubjectId: e.classSubjectId,
          subjectName: cs?.subject.name ?? '',
          attendanceTaken: sessions.some(
            (s) => s.classId === e.classId && s.startTime === e.startTime,
          ),
        };
      }),
      classSubjects: classSubjects.map((c) => ({
        id: c.id,
        classId: c.classId,
        className: c.class.name,
        subjectName: c.subject.name,
        coefficient: c.coefficient,
        students: c.class._count.enrollments,
      })),
    };
  }
}

@ApiTags('teacher')
@ApiBearerAuth()
@RequireModule('grades')
@Controller('teacher')
export class TeacherController {
  constructor(private readonly teacher: TeacherService) {}

  @RequirePermissions('grades.read')
  @Get('today')
  today() {
    return this.teacher.today();
  }
}

@Module({ controllers: [TeacherController], providers: [TeacherService] })
export class TeacherModule {}
