import { auditActionLabel, isoDate, SELF_ATTRIBUTED_AUDIT_ACTIONS } from '@ecole/shared';
import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { currentSchoolId } from '../../common/context';
import { addDays } from '../../common/dates';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';

const querySchema = z.object({
  entity: z.string().optional(),
  entityId: z.string().optional(),
  /** Code exact (« finance.payment_reversed ») ou famille (« finance. » / « finance »). */
  action: z.string().trim().max(80).optional(),
  actorId: z.string().trim().max(40).optional(),
  /** Période en jours calendaires de Douala, bornes incluses. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Début d'un jour calendaire de Douala (UTC+1, sans heure d'été). */
const doualaDayStart = (day: string) => new Date(`${day}T00:00:00+01:00`);

/** Filtre de famille : « finance » ou « finance. » désignent toutes les actions finance.*. */
function actionFilter(action?: string): Prisma.StringFilter | undefined {
  if (!action) return undefined;
  if (action.endsWith('.')) return { startsWith: action };
  return action.includes('.') ? { equals: action } : { startsWith: `${action}.` };
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(@InjectDb() private readonly db: Db) {}

  @RequirePermissions('audit.read')
  @Get()
  async list(@Query(new ZodPipe(querySchema)) q: z.infer<typeof querySchema>) {
    const createdAt =
      q.from || q.to
        ? {
            ...(q.from ? { gte: doualaDayStart(q.from) } : {}),
            ...(q.to ? { lt: doualaDayStart(addDays(q.to, 1)) } : {}),
          }
        : undefined;
    // Les connexions écrites avant l'attribution à la personne : auteur = compte connecté.
    const actor: Prisma.AuditLogWhereInput | undefined = q.actorId
      ? {
          OR: [
            { actorId: q.actorId },
            {
              actorId: null,
              action: { in: [...SELF_ATTRIBUTED_AUDIT_ACTIONS] },
              entityId: q.actorId,
            },
          ],
        }
      : undefined;
    const where: Prisma.AuditLogWhereInput = {
      schoolId: currentSchoolId(),
      entity: q.entity,
      entityId: q.entityId,
      action: actionFilter(q.action),
      createdAt,
      ...(actor ?? {}),
    };
    const [total, items] = await Promise.all([
      this.db.auditLog.count({ where }),
      this.db.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    const authorOf = (i: (typeof items)[number]) =>
      i.actorId ??
      (SELF_ATTRIBUTED_AUDIT_ACTIONS.includes(i.action) && i.entity === 'User' ? i.entityId : null);
    const actors = await this.db.user.findMany({
      where: {
        id: { in: [...new Set(items.map(authorOf).filter((x): x is string => !!x))] },
      },
      select: { id: true, firstName: true, lastName: true },
    });
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      pages: Math.max(1, Math.ceil(total / q.pageSize)),
      items: items.map((i) => {
        const author = authorOf(i);
        return {
          ...i,
          label: auditActionLabel(i.action),
          actor: author ? (actors.find((a) => a.id === author) ?? null) : null,
        };
      }),
    };
  }

  /** Personnes présentes dans le journal de l'école, pour le filtre « Personne ». */
  @RequirePermissions('audit.read')
  @Get('actors')
  async actors() {
    const schoolId = currentSchoolId();
    const [byActor, logins] = await Promise.all([
      this.db.auditLog.groupBy({
        by: ['actorId'],
        where: { schoolId, actorId: { not: null } },
      }),
      this.db.auditLog.groupBy({
        by: ['entityId'],
        where: {
          schoolId,
          actorId: null,
          action: { in: [...SELF_ATTRIBUTED_AUDIT_ACTIONS] },
          entityId: { not: null },
        },
      }),
    ]);
    const ids = [
      ...new Set([...byActor.map((a) => a.actorId), ...logins.map((l) => l.entityId)]),
    ].filter((x): x is string => !!x);
    return this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }
}

@Module({ controllers: [AuditController] })
export class AuditModule {}
