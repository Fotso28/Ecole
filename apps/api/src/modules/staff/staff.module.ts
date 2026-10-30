import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { staffCreateSchema, staffRolesSchema, type StaffRole } from '@ecole/shared';
import { z } from 'zod';
import { AccessService } from '../../common/access.service';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { AuthService } from '../auth/auth.service';

const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  mfaEnabled: true,
  lastLoginAt: true,
} as const;

@Injectable()
export class StaffService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  /** Permissions effectives d'une attribution de rôles, dans l'état de la transaction. */
  private async permissionsOf(
    tx: Db | Tx,
    roles: readonly StaffRole[],
    customRoleIds: readonly string[],
  ) {
    const config = await this.access.load(tx);
    return AccessService.resolve(config, { roles, customRoleIds }).permissions;
  }

  async list(onlyTeachers = false) {
    const memberships = await this.db.membership.findMany({
      where: {
        schoolId: currentSchoolId(),
        ...(onlyTeachers ? { roles: { has: 'TEACHER' }, active: true } : {}),
      },
      include: { user: { select: userSelect } },
      orderBy: { user: { lastName: 'asc' } },
    });
    return memberships.map((m) => ({
      ...m.user,
      roles: m.roles,
      customRoleIds: m.customRoleIds,
      active: m.active,
      maxWeeklyHours: m.maxWeeklyHours,
    }));
  }

  async create(input: z.infer<typeof staffCreateSchema>) {
    const schoolId = currentSchoolId();
    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing) {
      const m = await this.db.membership.findUnique({
        where: { userId_schoolId: { userId: existing.id, schoolId } },
      });
      if (m) throw new ConflictException('Cette personne fait déjà partie du personnel');
    }
    const customRoleIds = await this.access.checkCustomRoleIds(this.db, input.customRoleIds);
    this.access.assertCanGrant(await this.permissionsOf(this.db, input.roles, customRoleIds));
    const user =
      existing ??
      (await this.db.user.create({
        data: {
          email: input.email,
          phone: input.phone,
          firstName: input.firstName,
          lastName: input.lastName,
          passwordHash: await AuthService.hashPassword(input.password),
        },
      }));
    await this.db.membership.create({
      data: {
        userId: user.id,
        schoolId,
        roles: input.roles,
        customRoleIds,
        maxWeeklyHours: input.maxWeeklyHours,
      },
    });
    await this.audit.log({
      action: 'staff.created',
      entity: 'User',
      entityId: user.id,
      after: { email: input.email, roles: input.roles, customRoleIds },
    });
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roles: input.roles,
      customRoleIds,
    };
  }

  async setRoles(userId: string, input: z.infer<typeof staffRolesSchema>) {
    const schoolId = currentSchoolId();
    return this.db.$transaction(async (tx) => {
      await this.access.lock(tx, schoolId);
      const before = await tx.membership.findUnique({
        where: { userId_schoolId: { userId, schoolId } },
      });
      if (!before) throw new NotFoundException('Membre du personnel introuvable');
      const customRoleIds = await this.access.checkCustomRoleIds(
        tx,
        input.customRoleIds ?? before.customRoleIds,
      );
      if (input.roles.length + customRoleIds.length === 0)
        throw new BadRequestException('Au moins un rôle');
      const [had, gets] = await Promise.all([
        this.permissionsOf(tx, before.roles, before.customRoleIds),
        this.permissionsOf(tx, input.roles, customRoleIds),
      ]);
      this.access.assertCanGrant([...gets].filter((p) => !had.has(p)));
      const after = await tx.membership.update({
        where: { id: before.id },
        data: { roles: input.roles, customRoleIds },
      });
      await this.access.assertSomeoneKeepsControl(tx, schoolId);
      await this.audit.log(
        {
          action: 'staff.roles_changed',
          entity: 'Membership',
          entityId: before.id,
          before: { roles: before.roles, customRoleIds: before.customRoleIds },
          after: { roles: after.roles, customRoleIds: after.customRoleIds },
        },
        tx,
      );
      return after;
    });
  }

  async deactivate(userId: string) {
    const schoolId = currentSchoolId();
    if (userId === staffContext().userId)
      throw new ConflictException('Vous ne pouvez pas désactiver votre propre accès');
    const m = await this.db.membership.findUnique({
      where: { userId_schoolId: { userId, schoolId } },
    });
    if (!m) throw new NotFoundException('Membre du personnel introuvable');
    await this.db.$transaction(async (tx) => {
      await this.access.lock(tx, schoolId);
      await tx.membership.update({ where: { id: m.id }, data: { active: false } });
      await this.access.assertSomeoneKeepsControl(tx, schoolId);
    });
    await this.db.refreshToken.updateMany({
      where: { userId, schoolId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({ action: 'staff.deactivated', entity: 'Membership', entityId: m.id });
    return { ok: true };
  }
}

@ApiTags('staff')
@ApiBearerAuth()
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @RequirePermissions('staff.read')
  @Get()
  list() {
    return this.staff.list();
  }

  @RequirePermissions('academic.read')
  @Get('teachers')
  teachers() {
    return this.staff.list(true);
  }

  @RequirePermissions('staff.write')
  @Post()
  create(@Body(new ZodPipe(staffCreateSchema)) body: z.infer<typeof staffCreateSchema>) {
    return this.staff.create(body);
  }

  @RequirePermissions('staff.write')
  @Patch(':userId/roles')
  setRoles(
    @Param('userId') userId: string,
    @Body(new ZodPipe(staffRolesSchema)) body: z.infer<typeof staffRolesSchema>,
  ) {
    return this.staff.setRoles(userId, body);
  }

  @RequirePermissions('staff.write')
  @Post(':userId/deactivate')
  deactivate(@Param('userId') userId: string) {
    return this.staff.deactivate(userId);
  }
}

@Module({ controllers: [StaffController], providers: [StaffService] })
export class StaffModule {}
