import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { staffCreateSchema, staffRolesSchema, type StaffRole } from '@ecole/shared';
import { z } from 'zod';
import { AccessService } from '../../common/access.service';
import { AuditService } from '../../common/audit.service';
import { currentContext, currentSchoolId, runAsSystem, staffContext } from '../../common/context';
import { AccountRoute, AllowWithoutMfa, RequirePermissions } from '../../common/decorators';
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

  async list() {
    const memberships = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId() },
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

  /**
   * Enseignants actifs, pour les listes de choix (affectations, emploi du temps) : nom seulement,
   * sans coordonnées, puisque tout enseignant y a accès.
   */
  async teachers() {
    const memberships = await this.db.membership.findMany({
      where: { schoolId: currentSchoolId(), roles: { has: 'TEACHER' }, active: true },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { user: { lastName: 'asc' } },
    });
    return memberships.map((m) => ({ ...m.user, maxWeeklyHours: m.maxWeeklyHours }));
  }

  /** Invitations en attente : seule l'adresse saisie par l'école est rappelée. */
  async invitations() {
    const pending = await this.db.staffInvitation.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    const users = await this.db.user.findMany({
      where: { id: { in: pending.map((i) => i.userId) } },
      select: { id: true, email: true },
    });
    const email = new Map(users.map((u) => [u.id, u.email]));
    return pending.map((i) => ({
      id: i.id,
      email: email.get(i.userId) ?? null,
      roles: i.roles,
      customRoleIds: i.customRoleIds,
      createdAt: i.createdAt,
    }));
  }

  async cancelInvitation(id: string) {
    const updated = await this.db.staffInvitation.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    if (updated.count === 0) throw new NotFoundException('Invitation introuvable');
    await this.audit.log({
      action: 'staff.invitation_cancelled',
      entity: 'StaffInvitation',
      entityId: id,
    });
    return { ok: true };
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
    // Compte existant (autre école) : invitation à accepter à sa prochaine connexion. Rien de son
    // compte (nom, téléphone) n'est communiqué avant, et le mot de passe saisi est ignoré.
    if (existing) return this.invite(existing.id, input, customRoleIds);
    const user = await this.db.user.create({
      data: {
        email: input.email,
        phone: input.phone,
        firstName: input.firstName,
        lastName: input.lastName,
        passwordHash: await AuthService.hashPassword(input.password),
      },
    });
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
      status: 'CREATED' as const,
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roles: input.roles,
      customRoleIds,
    };
  }

  private async invite(
    userId: string,
    input: z.infer<typeof staffCreateSchema>,
    customRoleIds: string[],
  ) {
    const invitedById = staffContext().userId;
    const already = await this.db.staffInvitation.findFirst({
      where: { userId, status: 'PENDING' },
    });
    if (!already) {
      try {
        const invitation = await this.db.staffInvitation.create({
          data: {
            schoolId: currentSchoolId(),
            userId,
            roles: input.roles,
            customRoleIds,
            maxWeeklyHours: input.maxWeeklyHours,
            invitedById,
          },
        });
        await this.audit.log({
          action: 'staff.invited',
          entity: 'StaffInvitation',
          entityId: invitation.id,
          after: { email: input.email, roles: input.roles, customRoleIds },
        });
      } catch (e) {
        // Deux envois simultanés : une seule invitation en attente (index unique partiel).
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      }
    }
    return {
      status: 'INVITED' as const,
      email: input.email,
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
    return this.staff.teachers();
  }

  @RequirePermissions('staff.read')
  @Get('invitations')
  invitations() {
    return this.staff.invitations();
  }

  @RequirePermissions('staff.write')
  @Post('invitations/:id/cancel')
  cancelInvitation(@Param('id') id: string) {
    return this.staff.cancelInvitation(id);
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

/**
 * Réponse aux invitations reçues par la personne connectée, toutes écoles confondues : elle les
 * voit à sa connexion (profil `GET /auth/me`) et les accepte ou les refuse.
 */
@Injectable()
export class StaffInvitationsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async respond(invitationId: string, accept: boolean) {
    const ctx = currentContext();
    if (!ctx || !('userId' in ctx) || ctx.kind === 'parent')
      throw new ForbiddenException('Réservé au personnel');
    const userId = ctx.userId;
    const invitation = await runAsSystem('staff-invitation-lookup', () =>
      this.db.staffInvitation.findUnique({ where: { id: invitationId } }),
    );
    if (!invitation || invitation.userId !== userId || invitation.status !== 'PENDING')
      throw new NotFoundException('Invitation introuvable');
    return runAsSystem(
      'staff-invitation-response',
      () =>
        this.db.$transaction(async (tx) => {
          const updated = await tx.staffInvitation.updateMany({
            where: { id: invitationId, status: 'PENDING' },
            data: { status: accept ? 'ACCEPTED' : 'DECLINED', respondedAt: new Date() },
          });
          if (updated.count === 0) throw new NotFoundException('Invitation introuvable');
          if (accept) {
            const existing = await tx.membership.findUnique({
              where: { userId_schoolId: { userId, schoolId: invitation.schoolId } },
            });
            if (existing) throw new ConflictException('Vous faites déjà partie de ce personnel');
            await tx.membership.create({
              data: {
                userId,
                schoolId: invitation.schoolId,
                roles: invitation.roles,
                customRoleIds: invitation.customRoleIds,
                maxWeeklyHours: invitation.maxWeeklyHours,
              },
            });
          }
          await this.audit.log(
            {
              action: accept ? 'staff.invitation_accepted' : 'staff.invitation_declined',
              entity: 'StaffInvitation',
              entityId: invitationId,
              schoolId: invitation.schoolId,
              after: accept ? { roles: invitation.roles } : undefined,
            },
            tx,
          );
          return { ok: true, schoolId: invitation.schoolId };
        }),
      invitation.schoolId,
    );
  }
}

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/invitations')
export class StaffInvitationsController {
  constructor(private readonly invitations: StaffInvitationsService) {}

  @AccountRoute()
  @AllowWithoutMfa()
  @Post(':id/accept')
  accept(@Param('id') id: string) {
    return this.invitations.respond(id, true);
  }

  @AccountRoute()
  @AllowWithoutMfa()
  @Post(':id/decline')
  decline(@Param('id') id: string) {
    return this.invitations.respond(id, false);
  }
}

@Module({
  controllers: [StaffController, StaffInvitationsController],
  providers: [StaffService, StaffInvitationsService],
})
export class StaffModule {}
