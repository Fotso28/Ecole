import { Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { staffCreateSchema, staffRolesSchema } from '@ecole/shared';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { RequirePermissions } from '../../common/decorators';
import { Db, InjectDb } from '../../common/prisma';
import { ZodPipe } from '../../common/zod.pipe';
import { AuthService } from '../auth/auth.service';

const userSelect = { id: true, firstName: true, lastName: true, email: true, phone: true, mfaEnabled: true, lastLoginAt: true } as const;

@Injectable()
export class StaffService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(onlyTeachers = false) {
    const memberships = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId(), ...(onlyTeachers ? { roles: { has: 'TEACHER' }, active: true } : {}) },
      include: { user: { select: userSelect } },
      orderBy: { user: { lastName: 'asc' } },
    });
    return memberships.map((m) => ({ ...m.user, roles: m.roles, active: m.active, maxWeeklyHours: m.maxWeeklyHours }));
  }

  async create(input: z.infer<typeof staffCreateSchema>) {
    const schoolId = currentSchoolId();
    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing) {
      const m = await this.db.membership.findUnique({ where: { userId_schoolId: { userId: existing.id, schoolId } } });
      if (m) throw new ConflictException('Cette personne fait déjà partie du personnel');
    }
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
      data: { userId: user.id, schoolId, roles: input.roles, maxWeeklyHours: input.maxWeeklyHours },
    });
    await this.audit.log({ action: 'staff.created', entity: 'User', entityId: user.id, after: { email: input.email, roles: input.roles } });
    return { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, roles: input.roles };
  }

  async setRoles(userId: string, roles: z.infer<typeof staffRolesSchema>['roles']) {
    const schoolId = currentSchoolId();
    if (userId === staffContext().userId && !roles.includes('DIRECTOR')) {
      const directors = await this.db.membership.count({ where: { schoolId, roles: { has: 'DIRECTOR' }, active: true } });
      if (directors <= 1) throw new ConflictException('L’établissement doit garder au moins un directeur');
    }
    const before = await this.db.membership.findUnique({ where: { userId_schoolId: { userId, schoolId } } });
    if (!before) throw new NotFoundException('Membre du personnel introuvable');
    const after = await this.db.membership.update({ where: { id: before.id }, data: { roles } });
    await this.audit.log({ action: 'staff.roles_changed', entity: 'Membership', entityId: before.id, before: before.roles, after: after.roles });
    return after;
  }

  async deactivate(userId: string) {
    const schoolId = currentSchoolId();
    if (userId === staffContext().userId) throw new ConflictException('Vous ne pouvez pas désactiver votre propre accès');
    const m = await this.db.membership.findUnique({ where: { userId_schoolId: { userId, schoolId } } });
    if (!m) throw new NotFoundException('Membre du personnel introuvable');
    await this.db.membership.update({ where: { id: m.id }, data: { active: false } });
    await this.db.refreshToken.updateMany({ where: { userId, schoolId, revokedAt: null }, data: { revokedAt: new Date() } });
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
  setRoles(@Param('userId') userId: string, @Body(new ZodPipe(staffRolesSchema)) body: z.infer<typeof staffRolesSchema>) {
    return this.staff.setRoles(userId, body.roles);
  }

  @RequirePermissions('staff.write')
  @Post(':userId/deactivate')
  deactivate(@Param('userId') userId: string) {
    return this.staff.deactivate(userId);
  }
}

@Module({ controllers: [StaffController], providers: [StaffService] })
export class StaffModule {}
