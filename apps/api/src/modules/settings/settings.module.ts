import { Body, Controller, Get, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId } from '../../common/context';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';

const settingsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  address: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  settings: z
    .object({
      absenceAlertThreshold: z.number().int().min(1).max(30).optional(),
      absenceAlertWindowDays: z.number().int().min(1).max(60).optional(),
      absenceNotificationDelayMinutes: z.number().int().min(0).max(1440).optional(),
      reminderOffsets: z.array(z.number().int().min(1).max(120)).max(5).optional(),
      mfaRequired: z.boolean().optional(),
    })
    .optional(),
});

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions('dashboard.read')
  @Get()
  get() {
    return this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: {
        id: true,
        name: true,
        slug: true,
        city: true,
        address: true,
        phone: true,
        matriculePrefix: true,
        modules: true,
        settings: true,
      },
    });
  }

  @RequirePermissions('settings.write')
  @Patch()
  async update(@Body(new ZodPipe(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    const before = await this.db.school.findUniqueOrThrow({ where: { id: currentSchoolId() } });
    const merged = {
      ...((before.settings ?? {}) as Record<string, unknown>),
      ...(body.settings ?? {}),
    };
    const after = await this.db.school.update({
      where: { id: before.id },
      data: {
        name: body.name,
        address: body.address,
        phone: body.phone,
        settings: merged as Prisma.InputJsonValue,
      },
    });
    await this.audit.log({
      action: 'settings.updated',
      entity: 'School',
      entityId: before.id,
      before: before.settings,
      after: merged,
    });
    return after;
  }
}

@Module({ controllers: [SettingsController] })
export class SettingsModule {}
