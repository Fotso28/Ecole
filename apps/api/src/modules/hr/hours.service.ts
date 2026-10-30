import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  formatPayrollMonth,
  payrollMonthBounds,
  plannedLessons,
  type lessonMarkSchema,
  type overtimeSchema,
} from '@ecole/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { fromDbDate, toDbDate, todayInCameroon } from '../../common/dates';
import { Db, InjectDb } from '../../common/prisma';

export interface MonthTotals {
  plannedMinutes: number;
  doneMinutes: number;
  absentJustifiedMinutes: number;
  absentUnjustifiedMinutes: number;
  unmarkedMinutes: number;
  overtimeMinutes: number;
}

/** Heures de cours : prévues (emploi du temps), faites, absences et heures supplémentaires. */
@Injectable()
export class HoursService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Refuse toute modification d'un mois dont la paie est validée. */
  async assertMonthOpen(date: string) {
    const month = date.slice(0, 7);
    const run = await this.db.payrollRun.findUnique({
      where: { schoolId_month: { schoolId: currentSchoolId(), month } },
      select: { status: true },
    });
    if (run?.status === 'VALIDATED')
      throw new ConflictException(
        `La paie de ${formatPayrollMonth(month)} est validée : les heures de ce mois sont figées`,
      );
  }

  async teachers() {
    const memberships = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId(), roles: { has: 'TEACHER' }, active: true },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { user: { lastName: 'asc' } },
    });
    return memberships.map((m) => m.user);
  }

  /** Cours prévus du mois pour un enseignant (année scolaire en cours, hors jours fériés). */
  private async planned(teacherId: string, month: string) {
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) return { lessons: [], entries: [] };
    const entries = await this.db.timetableEntry.findMany({
      where: { academicYearId: year.id, teacherId },
    });
    const { first, last } = payrollMonthBounds(month);
    const holidays = await this.db.schoolEvent.findMany({
      where: {
        category: 'HOLIDAY',
        scope: 'SCHOOL',
        startDate: { lte: toDbDate(last) },
        endDate: { gte: toDbDate(first) },
      },
    });
    const closedDays = new Set<string>();
    for (const h of holidays) {
      for (let d = new Date(h.startDate); d <= h.endDate; d.setUTCDate(d.getUTCDate() + 1))
        closedDays.add(fromDbDate(d));
    }
    const lessons = plannedLessons(entries, month, {
      from: fromDbDate(year.startDate),
      to: fromDbDate(year.endDate),
      closedDays,
    });
    return { lessons, entries };
  }

  private async sessions(teacherId: string, month: string) {
    const { first, last } = payrollMonthBounds(month);
    return this.db.teachingSession.findMany({
      where: { teacherId, date: { gte: toDbDate(first), lte: toDbDate(last) } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Totaux du mois, utilisés par la paie. */
  async totals(teacherId: string, month: string): Promise<MonthTotals> {
    const [{ lessons }, sessions] = await Promise.all([
      this.planned(teacherId, month),
      this.sessions(teacherId, month),
    ]);
    const marks = new Map(
      sessions
        .filter((s) => s.kind === 'REGULAR' && s.timetableEntryId)
        .map((s) => [`${s.timetableEntryId}|${fromDbDate(s.date)}`, s]),
    );
    const totals: MonthTotals = {
      plannedMinutes: 0,
      doneMinutes: 0,
      absentJustifiedMinutes: 0,
      absentUnjustifiedMinutes: 0,
      unmarkedMinutes: 0,
      overtimeMinutes: 0,
    };
    for (const l of lessons) {
      totals.plannedMinutes += l.minutes;
      const s = marks.get(`${l.slotId}|${l.date}`);
      if (!s) totals.unmarkedMinutes += l.minutes;
      else if (s.status === 'DONE') totals.doneMinutes += s.minutes;
      else if (s.justified) totals.absentJustifiedMinutes += s.minutes;
      else totals.absentUnjustifiedMinutes += s.minutes;
    }
    for (const s of sessions)
      if (s.kind === 'OVERTIME' && s.status === 'DONE') totals.overtimeMinutes += s.minutes;
    return totals;
  }

  /** Détail du mois : chaque cours prévu avec son état, et les heures supplémentaires. */
  async month(teacherId: string, month: string) {
    const [{ lessons, entries }, sessions, totals] = await Promise.all([
      this.planned(teacherId, month),
      this.sessions(teacherId, month),
      this.totals(teacherId, month),
    ]);
    const css = await this.db.classSubject.findMany({
      where: { id: { in: entries.map((e) => e.classSubjectId) } },
      include: { class: { select: { name: true } }, subject: { select: { name: true } } },
    });
    const csById = new Map(css.map((c) => [c.id, c]));
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const marks = new Map(
      sessions
        .filter((s) => s.kind === 'REGULAR' && s.timetableEntryId)
        .map((s) => [`${s.timetableEntryId}|${fromDbDate(s.date)}`, s]),
    );
    const run = await this.db.payrollRun.findUnique({
      where: { schoolId_month: { schoolId: currentSchoolId(), month } },
      select: { status: true },
    });
    return {
      month,
      locked: run?.status === 'VALIDATED',
      totals,
      lessons: lessons.map((l) => {
        const e = entryById.get(l.slotId);
        const cs = e ? csById.get(e.classSubjectId) : undefined;
        const s = marks.get(`${l.slotId}|${l.date}`);
        return {
          timetableEntryId: l.slotId,
          date: l.date,
          startTime: e?.startTime ?? null,
          endTime: e?.endTime ?? null,
          minutes: l.minutes,
          className: cs?.class.name ?? '',
          subject: cs?.subject.name ?? '',
          sessionId: s?.id ?? null,
          status: s?.status ?? null,
          justified: s?.justified ?? false,
          reason: s?.reason ?? null,
        };
      }),
      overtime: sessions
        .filter((s) => s.kind === 'OVERTIME')
        .map((s) => ({ id: s.id, date: fromDbDate(s.date), minutes: s.minutes, reason: s.reason })),
    };
  }

  /** Marque un cours prévu comme fait ou absent (avec motif). */
  async mark(input: z.infer<typeof lessonMarkSchema>) {
    const entry = await this.db.timetableEntry.findUnique({
      where: { id: input.timetableEntryId },
    });
    if (!entry?.teacherId) throw new NotFoundException('Cours introuvable dans l’emploi du temps');
    const { lessons } = await this.planned(entry.teacherId, input.date.slice(0, 7));
    const lesson = lessons.find((l) => l.slotId === entry.id && l.date === input.date);
    if (!lesson) throw new BadRequestException('Ce cours n’est pas prévu à cette date');
    if (input.date > todayInCameroon())
      throw new BadRequestException('Un cours à venir ne peut pas encore être marqué');
    await this.assertMonthOpen(input.date);
    const data = {
      status: input.status,
      justified: input.status === 'ABSENT' ? input.justified : false,
      reason: input.reason ?? null,
      minutes: lesson.minutes,
      recordedById: staffContext().userId,
    };
    const before = await this.db.teachingSession.findUnique({
      where: { timetableEntryId_date: { timetableEntryId: entry.id, date: toDbDate(input.date) } },
    });
    const session = await this.db.teachingSession.upsert({
      where: { timetableEntryId_date: { timetableEntryId: entry.id, date: toDbDate(input.date) } },
      create: {
        schoolId: currentSchoolId(),
        teacherId: entry.teacherId,
        timetableEntryId: entry.id,
        date: toDbDate(input.date),
        kind: 'REGULAR',
        ...data,
      },
      update: data,
    });
    await this.audit.log({
      action: 'hr.lesson_marked',
      entity: 'TeachingSession',
      entityId: session.id,
      before: before ? { status: before.status, justified: before.justified } : undefined,
      after: { date: input.date, status: data.status, justified: data.justified },
      reason: input.reason,
    });
    return session;
  }

  async addOvertime(input: z.infer<typeof overtimeSchema>) {
    const membership = await this.db.membership.findUnique({
      where: { userId_schoolId: { userId: input.teacherId, schoolId: currentSchoolId() } },
    });
    if (!membership) throw new BadRequestException('Enseignant inconnu');
    if (input.date > todayInCameroon())
      throw new BadRequestException('Une heure à venir ne peut pas encore être saisie');
    await this.assertMonthOpen(input.date);
    const session = await this.db.teachingSession.create({
      data: {
        schoolId: currentSchoolId(),
        teacherId: input.teacherId,
        date: toDbDate(input.date),
        minutes: input.minutes,
        kind: 'OVERTIME',
        status: 'DONE',
        reason: input.reason,
        recordedById: staffContext().userId,
      },
    });
    await this.audit.log({
      action: 'hr.overtime_added',
      entity: 'TeachingSession',
      entityId: session.id,
      after: input,
    });
    return session;
  }

  /** Retire une saisie (heure supplémentaire ou marquage erroné) d'un mois non validé. */
  async remove(id: string) {
    const session = await this.db.teachingSession.findUnique({ where: { id } });
    if (!session) throw new NotFoundException('Saisie introuvable');
    await this.assertMonthOpen(fromDbDate(session.date));
    await this.db.teachingSession.delete({ where: { id } });
    await this.audit.log({
      action: 'hr.session_removed',
      entity: 'TeachingSession',
      entityId: id,
      before: {
        date: fromDbDate(session.date),
        kind: session.kind,
        status: session.status,
        minutes: session.minutes,
      },
    });
    return { ok: true };
  }

  /** Marque comme faits tous les cours passés du mois encore sans état. */
  async confirm(teacherId: string, month: string) {
    await this.assertMonthOpen(`${month}-01`);
    const today = todayInCameroon();
    const [{ lessons }, sessions] = await Promise.all([
      this.planned(teacherId, month),
      this.sessions(teacherId, month),
    ]);
    const marked = new Set(
      sessions
        .filter((s) => s.timetableEntryId)
        .map((s) => `${s.timetableEntryId}|${fromDbDate(s.date)}`),
    );
    const toMark = lessons.filter((l) => l.date <= today && !marked.has(`${l.slotId}|${l.date}`));
    const { count } = await this.db.teachingSession.createMany({
      data: toMark.map((l) => ({
        schoolId: currentSchoolId(),
        teacherId,
        timetableEntryId: l.slotId,
        date: toDbDate(l.date),
        minutes: l.minutes,
        kind: 'REGULAR' as const,
        status: 'DONE' as const,
        recordedById: staffContext().userId,
      })),
      skipDuplicates: true,
    });
    await this.audit.log({
      action: 'hr.lessons_confirmed',
      entity: 'TeachingSession',
      entityId: teacherId,
      after: { month, count },
    });
    return { count };
  }
}
