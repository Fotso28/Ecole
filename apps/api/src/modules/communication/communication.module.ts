import { Body, Controller, Get, Injectable, Module, NotFoundException, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { announcementCreateSchema } from '@ecole/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { RequireModule, RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ScopeService } from '../../common/scope.service';
import { ZodPipe } from '../../common/zod.pipe';
import { NotificationsService } from '../notifications/notifications.service';
import { subjects, templates } from '../notifications/templates';

/** Inscriptions actives de l'année en cours dans les classes visées. */
export function activeEnrollmentFilter(
  yearId: string,
  classFilter: Prisma.ClassWhereInput,
): Prisma.StudentWhereInput {
  return {
    deletedAt: null,
    enrollments: {
      some: {
        academicYearId: yearId,
        status: { in: ['ENROLLED', 'REPEATING'] },
        class: classFilter,
      },
    },
  };
}

/** Filtre de classes d'une portée école, cycle, niveau ou classe. */
export function classFilterFor(scope: string, targetId?: string | null): Prisma.ClassWhereInput {
  switch (scope) {
    case 'CLASS':
      return { id: targetId ?? '' };
    case 'LEVEL':
      return { levelId: targetId ?? '' };
    case 'CYCLE':
      return { level: { cycleId: targetId ?? '' } };
    default:
      return {};
  }
}

@Injectable()
export class CommunicationService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly scope: ScopeService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.announcement.findMany({ orderBy: { publishedAt: 'desc' }, take: 50 });
  }

  /**
   * Annonce ciblée (école, cycle, niveau, classe ou élèves choisis) ; notification facultative au
   * parent principal de chaque élève concerné, par SMS ou par e-mail selon ses coordonnées.
   */
  async create(input: z.infer<typeof announcementCreateSchema>) {
    const year = await this.scope.currentYear();
    const studentIds = input.scope === 'STUDENTS' ? [...new Set(input.studentIds)] : [];
    if (studentIds.length) {
      const found = await this.db.student.count({
        where: { id: { in: studentIds }, deletedAt: null },
      });
      if (found !== studentIds.length) throw new NotFoundException('Élève introuvable');
    }
    const schoolId = currentSchoolId();
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: schoolId },
      select: { name: true },
    });
    const preferred = await this.notifications.preferredChannel(schoolId);
    return this.db.$transaction(async (tx) => {
      const announcement = await tx.announcement.create({
        data: {
          schoolId,
          title: input.title,
          body: input.body,
          scope: input.scope,
          targetId: input.scope === 'SCHOOL' || input.scope === 'STUDENTS' ? null : input.targetId,
          studentIds,
          authorId: staffContext().userId,
        },
      });
      const sent = { SMS: 0, EMAIL: 0 };
      if (input.sendSms) {
        const links = await tx.studentGuardian.findMany({
          where: {
            isPrimary: true,
            student:
              input.scope === 'STUDENTS'
                ? { id: { in: studentIds }, deletedAt: null }
                : activeEnrollmentFilter(year.id, classFilterFor(input.scope, input.targetId)),
          },
          include: { guardian: { select: { id: true, phone: true, email: true } } },
        });
        const guardians = new Map(links.map((l) => [l.guardian.id, l.guardian]));
        for (const g of guardians.values()) {
          const n = await this.notifications.notifyContact(
            {
              schoolId,
              contact: g,
              template: 'announcement',
              body: templates.announcement({ school: school.name, title: input.title }),
              emailBody: templates.announcementEmail({
                school: school.name,
                title: input.title,
                body: input.body,
              }),
              subject: subjects.announcement({ school: school.name, title: input.title }),
              payload: { announcementId: announcement.id },
            },
            tx,
            preferred,
          );
          if (n) sent[n.channel === 'EMAIL' ? 'EMAIL' : 'SMS']++;
        }
      }
      await this.audit.log(
        {
          action: 'communication.announcement',
          entity: 'Announcement',
          entityId: announcement.id,
          after: { ...input, sms: sent.SMS, emails: sent.EMAIL },
        },
        tx,
      );
      return { ...announcement, sms: sent.SMS, emails: sent.EMAIL };
    });
  }
}

@ApiTags('communication')
@ApiBearerAuth()
@RequireModule('communication')
@Controller('announcements')
export class CommunicationController {
  constructor(private readonly communication: CommunicationService) {}

  @RequirePermissions('dashboard.read')
  @Get()
  list() {
    return this.communication.list();
  }

  @RequirePermissions('communication.write')
  @Post()
  create(
    @Body(new ZodPipe(announcementCreateSchema)) body: z.infer<typeof announcementCreateSchema>,
  ) {
    return this.communication.create(body);
  }
}

@Module({ controllers: [CommunicationController], providers: [CommunicationService] })
export class CommunicationModule {}
