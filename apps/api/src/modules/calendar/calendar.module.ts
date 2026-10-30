import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { eventCreateSchema, eventRangeSchema, EVENT_CATEGORY_LABELS } from '@ecole/shared';
import { Prisma, SchoolEvent } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, runAsSystem, staffContext } from '../../common/context';
import { addDays, fromDbDate, todayInCameroon, toDbDate } from '../../common/dates';
import { ParentRoute, RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { activeEnrollmentFilter, classFilterFor } from '../communication/communication.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ParentLinkService } from '../messaging/parent-link';
import { NotificationsService } from '../notifications/notifications.service';
import { subjects, templates } from '../notifications/templates';

type EventInput = z.infer<typeof eventCreateSchema>;
const dayFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
type Range = z.infer<typeof eventRangeSchema>;

/**
 * Calendrier des événements (réunions de parents, congés, fêtes, sorties) visant l'école, un cycle,
 * un niveau ou une classe ; rappel facultatif la veille aux parents concernés.
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger('Calendrier');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly parents: ParentLinkService,
  ) {}

  private overlapping(range: Range): Prisma.SchoolEventWhereInput {
    return { startDate: { lte: toDbDate(range.to) }, endDate: { gte: toDbDate(range.from) } };
  }

  async list(range: Range) {
    const events = await this.db.schoolEvent.findMany({
      where: this.overlapping(range),
      orderBy: [{ startDate: 'asc' }, { startTime: 'asc' }],
      take: 500,
    });
    return this.present(events);
  }

  async create(input: EventInput) {
    if (input.scope !== 'SCHOOL') await this.assertTarget(input.scope, input.targetId!);
    const event = await this.db.schoolEvent.create({
      data: {
        schoolId: currentSchoolId(),
        title: input.title,
        description: input.description || null,
        category: input.category,
        startDate: toDbDate(input.startDate),
        endDate: toDbDate(input.endDate ?? input.startDate),
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        location: input.location || null,
        scope: input.scope,
        targetId: input.scope === 'SCHOOL' ? null : input.targetId,
        remindBySms: input.remindBySms,
        authorId: staffContext().userId,
      },
    });
    await this.audit.log({
      action: 'calendar.event_created',
      entity: 'SchoolEvent',
      entityId: event.id,
      after: input,
    });
    return (await this.present([event]))[0];
  }

  async remove(id: string) {
    const event = await this.db.schoolEvent.findUnique({ where: { id } });
    if (!event) throw new NotFoundException('Événement introuvable');
    await this.db.schoolEvent.delete({ where: { id } });
    await this.audit.log({
      action: 'calendar.event_deleted',
      entity: 'SchoolEvent',
      entityId: id,
      before: {
        ...event,
        startDate: fromDbDate(event.startDate),
        endDate: fromDbDate(event.endDate),
      },
    });
    return { ok: true };
  }

  /** Événements visibles par les parents d'un élève : école, son cycle, son niveau, sa classe. */
  async forChild(studentId: string, range: Range) {
    const link = await this.parents.child(studentId);
    return runAsSystem(
      'portal-events',
      async () => {
        const enrollment = await this.db.enrollment.findFirst({
          where: {
            studentId,
            status: { in: ['ENROLLED', 'REPEATING'] },
            class: { academicYear: { isCurrent: true } },
          },
          include: { class: { include: { level: true } } },
        });
        const events = await this.db.schoolEvent.findMany({
          where: {
            ...this.overlapping(range),
            OR: [
              { scope: 'SCHOOL' },
              ...(enrollment
                ? [
                    { scope: 'CLASS' as const, targetId: enrollment.classId },
                    { scope: 'LEVEL' as const, targetId: enrollment.class.levelId },
                    { scope: 'CYCLE' as const, targetId: enrollment.class.level.cycleId },
                  ]
                : []),
            ],
          },
          orderBy: [{ startDate: 'asc' }, { startTime: 'asc' }],
          take: 500,
        });
        return this.present(events);
      },
      link.schoolId,
    );
  }

  /**
   * Rappels de la veille : pour chaque événement de demain avec rappel demandé, une notification
   * au parent principal de chaque élève concerné (SMS ou e-mail), une seule fois par événement.
   */
  async sendReminders(
    today = todayInCameroon(),
  ): Promise<{ events: number; notifications: number }> {
    const tomorrow = toDbDate(addDays(today, 1));
    const due = await runAsSystem('event-reminders-lookup', () =>
      this.db.schoolEvent.findMany({
        where: { remindBySms: true, reminderSentAt: null, startDate: tomorrow },
        select: { id: true, schoolId: true },
      }),
    );
    let events = 0;
    let notifications = 0;
    for (const { id, schoolId } of due) {
      try {
        const sent = await runAsSystem('event-reminders', () => this.remind(id), schoolId);
        if (sent !== null) {
          events++;
          notifications += sent;
        }
      } catch (e) {
        this.logger.error(`Rappel de l'événement ${id} : ${e instanceof Error ? e.message : e}`);
      }
    }
    return { events, notifications };
  }

  private async remind(eventId: string): Promise<number | null> {
    const schoolId = currentSchoolId();
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { name: true, status: true, modules: true },
    });
    if (school.status !== 'ACTIVE' || !school.modules.includes('communication')) return null;
    const year = await this.db.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) return null;
    const preferred = await this.notifications.preferredChannel(schoolId);
    return this.db.$transaction(async (tx) => {
      // Réservation : un seul envoi par événement, même si la tâche tourne deux fois.
      const claimed = await tx.schoolEvent.updateMany({
        where: { id: eventId, reminderSentAt: null },
        data: { reminderSentAt: new Date() },
      });
      if (claimed.count === 0) return null;
      const event = await tx.schoolEvent.findUniqueOrThrow({ where: { id: eventId } });
      const links = await tx.studentGuardian.findMany({
        where: {
          isPrimary: true,
          student: activeEnrollmentFilter(year.id, classFilterFor(event.scope, event.targetId)),
        },
        include: { guardian: { select: { id: true, phone: true, email: true } } },
      });
      const guardians = new Map(links.map((l) => [l.guardian.id, l.guardian]));
      let count = 0;
      for (const g of guardians.values()) {
        const n = await this.notifications.notifyContact(
          {
            schoolId,
            contact: g,
            template: 'eventReminder',
            body: templates.eventReminder({
              school: school.name,
              title: event.title,
              date: dayFmt.format(event.startDate),
              time: event.startTime,
            }),
            subject: subjects.eventReminder({ title: event.title }),
            payload: { eventId: event.id },
          },
          tx,
          preferred,
        );
        if (n) count++;
      }
      return count;
    });
  }

  private async assertTarget(scope: EventInput['scope'], targetId: string): Promise<void> {
    const found =
      scope === 'CLASS'
        ? await this.db.class.count({ where: { id: targetId } })
        : scope === 'LEVEL'
          ? await this.db.level.count({ where: { id: targetId } })
          : await this.db.cycle.count({ where: { id: targetId } });
    if (found === 0) throw new NotFoundException('Cible introuvable');
  }

  /** Événements au format de l'interface, avec le nom de la cible. */
  private async present(events: SchoolEvent[]) {
    const ids = (scope: string) =>
      events.filter((e) => e.scope === scope && e.targetId).map((e) => e.targetId!);
    const [classes, levels, cycles] = await Promise.all([
      this.db.class.findMany({
        where: { id: { in: ids('CLASS') } },
        select: { id: true, name: true },
      }),
      this.db.level.findMany({
        where: { id: { in: ids('LEVEL') } },
        select: { id: true, name: true },
      }),
      this.db.cycle.findMany({
        where: { id: { in: ids('CYCLE') } },
        select: { id: true, name: true },
      }),
    ]);
    const names = new Map([...classes, ...levels, ...cycles].map((t) => [t.id, t.name]));
    return events.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      category: e.category,
      categoryLabel: EVENT_CATEGORY_LABELS[e.category],
      startDate: fromDbDate(e.startDate),
      endDate: fromDbDate(e.endDate),
      startTime: e.startTime,
      endTime: e.endTime,
      location: e.location,
      scope: e.scope,
      targetId: e.targetId,
      targetName: e.scope === 'SCHOOL' ? 'Toute l’école' : (names.get(e.targetId ?? '') ?? '—'),
      remindBySms: e.remindBySms,
      reminderSent: !!e.reminderSentAt,
    }));
  }
}

@ApiTags('calendar')
@ApiBearerAuth()
@RequireModule('communication')
@Controller('events')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @RequirePermissions('academic.read')
  @Get()
  list(@Query(new ZodPipe(eventRangeSchema)) q: Range) {
    return this.calendar.list(q);
  }

  @RequirePermissions('communication.write')
  @Post()
  create(@Body(new ZodPipe(eventCreateSchema)) body: EventInput) {
    return this.calendar.create(body);
  }

  @RequirePermissions('communication.write')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.calendar.remove(id);
  }
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
export class ParentCalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @ParentRoute()
  @Get('children/:id/events')
  events(@Param('id') id: string, @Query(new ZodPipe(eventRangeSchema)) q: Range) {
    return this.calendar.forChild(id, q);
  }
}

@Module({
  imports: [MessagingModule],
  controllers: [CalendarController, ParentCalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
