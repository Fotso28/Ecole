import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { currentSchoolId } from '../../common/context';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';

const querySchema = z.object({
  entity: z.string().optional(),
  entityId: z.string().optional(),
  action: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(@InjectDb() private readonly db: Db) {}

  @RequirePermissions('audit.read')
  @Get()
  async list(@Query(new ZodPipe(querySchema)) q: z.infer<typeof querySchema>) {
    const where = { schoolId: currentSchoolId(), entity: q.entity, entityId: q.entityId, action: q.action ? { startsWith: q.action } : undefined };
    const [total, items] = await Promise.all([
      this.db.auditLog.count({ where }),
      this.db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const actors = await this.db.user.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.actorId).filter((x): x is string => !!x))] } },
      select: { id: true, firstName: true, lastName: true },
    });
    return { total, items: items.map((i) => ({ ...i, actor: actors.find((a) => a.id === i.actorId) ?? null })) };
  }
}

@Module({ controllers: [AuditController] })
export class AuditModule {}
