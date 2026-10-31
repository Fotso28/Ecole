import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
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

  /** Annonces récentes, avec leurs destinataires en clair et leur éventuel retrait. */
  async list() {
    const items = await this.db.announcement.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 50,
    });
    const ids = (scope: string) =>
      items.filter((a) => a.scope === scope && a.targetId).map((a) => a.targetId as string);
    const [classes, levels, cycles, students] = await Promise.all([
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
      this.db.student.findMany({
        where: { id: { in: [...new Set(items.flatMap((a) => a.studentIds))] } },
        select: { id: true, firstName: true, lastName: true },
      }),
    ]);
    const name = (rows: { id: string; name: string }[], id: string | null) =>
      rows.find((r) => r.id === id)?.name ?? 'Cible supprimée';
    return items.map((a) => ({
      ...a,
      audience:
        a.scope === 'SCHOOL'
          ? 'Toute l’école'
          : a.scope === 'CLASS'
            ? `Classe ${name(classes, a.targetId)}`
            : a.scope === 'LEVEL'
              ? `Niveau ${name(levels, a.targetId)}`
              : a.scope === 'CYCLE'
                ? `Cycle ${name(cycles, a.targetId)}`
                : students
                    .filter((st) => a.studentIds.includes(st.id))
                    .map((st) => `${st.lastName} ${st.firstName}`)
                    .join(', '),
    }));
  }

  /**
   * Retrait d'une annonce (erreur de destinataire…) : elle disparaît du portail des parents, les
   * notifications pas encore parties sont annulées, et le retrait est journalisé.
   */
  async withdraw(id: string) {
    const announcement = await this.db.announcement.findUnique({ where: { id } });
    if (!announcement) throw new NotFoundException('Annonce introuvable');
    if (announcement.withdrawnAt) throw new ConflictException('Cette annonce est déjà retirée');
    return this.db.$transaction(async (tx) => {
      const updated = await tx.announcement.update({
        where: { id },
        data: { withdrawnAt: new Date(), withdrawnById: staffContext().userId },
      });
      const cancelled = await tx.$executeRaw`
        UPDATE "NotificationOutbox" SET "status" = 'FAILED', "lastError" = 'Annulé : annonce retirée'
        WHERE "status" = 'PENDING' AND "template" = 'announcement'
          AND "payload"->>'announcementId' = ${id}`;
      await this.audit.log(
        {
          action: 'communication.announcement_withdrawn',
          entity: 'Announcement',
          entityId: id,
          before: {
            title: announcement.title,
            scope: announcement.scope,
            targetId: announcement.targetId,
            studentIds: announcement.studentIds,
          },
          after: { withdrawnAt: updated.withdrawnAt, cancelledNotifications: cancelled },
        },
        tx,
      );
      return { ...updated, cancelledNotifications: cancelled };
    });
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

  @RequirePermissions('communication.write')
  @Delete(':id')
  withdraw(@Param('id') id: string) {
    return this.communication.withdraw(id);
  }
}

@Module({ controllers: [CommunicationController], providers: [CommunicationService] })
export class CommunicationModule {}
