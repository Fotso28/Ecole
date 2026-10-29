import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
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
import { templates } from '../notifications/templates';

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

  /** Annonce ciblée ; envoi SMS facultatif au parent principal de chaque élève concerné. */
  async create(input: z.infer<typeof announcementCreateSchema>) {
    if (input.scope !== 'SCHOOL' && !input.targetId) throw new Error('Cible obligatoire');
    const year = await this.scope.currentYear();
    const announcement = await this.db.announcement.create({
      data: { schoolId: currentSchoolId(), title: input.title, body: input.body, scope: input.scope, targetId: input.targetId, authorId: staffContext().userId },
    });
    let sms = 0;
    if (input.sendSms) {
      const classFilter: Prisma.ClassWhereInput =
        input.scope === 'CLASS' ? { id: input.targetId } : input.scope === 'LEVEL' ? { levelId: input.targetId } : input.scope === 'CYCLE' ? { level: { cycleId: input.targetId } } : {};
      const links = await this.db.studentGuardian.findMany({
        where: {
          isPrimary: true,
          student: { deletedAt: null, enrollments: { some: { academicYearId: year.id, status: { in: ['ENROLLED', 'REPEATING'] }, class: classFilter } } },
        },
        include: { guardian: { select: { phone: true } } },
      });
      const school = await this.db.school.findUniqueOrThrow({ where: { id: currentSchoolId() }, select: { name: true } });
      const phones = [...new Set(links.map((l) => l.guardian.phone))];
      for (const phone of phones) {
        await this.notifications.enqueue({
          schoolId: currentSchoolId(),
          recipient: phone,
          template: 'announcement',
          body: templates.announcement({ school: school.name, title: input.title }),
          payload: { announcementId: announcement.id },
        });
      }
      sms = phones.length;
    }
    await this.audit.log({ action: 'communication.announcement', entity: 'Announcement', entityId: announcement.id, after: { ...input, sms } });
    return { ...announcement, sms };
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
  create(@Body(new ZodPipe(announcementCreateSchema)) body: z.infer<typeof announcementCreateSchema>) {
    return this.communication.create(body);
  }
}

@Module({ controllers: [CommunicationController], providers: [CommunicationService] })
export class CommunicationModule {}
