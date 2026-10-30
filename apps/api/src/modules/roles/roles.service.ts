import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  builtinPermissions,
  LOCKED_DIRECTOR_PERMISSIONS,
  normalizePermissions,
  overrideFor,
  resolveAccess,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
  type CustomRoleInput,
  type Permission,
  type StaffRole,
} from '@ecole/shared';
import { Prisma } from '@prisma/client';
import { AccessService } from '../../common/access.service';
import { AuditService } from '../../common/audit.service';
import { currentSchoolId, staffContext } from '../../common/context';
import { Db, InjectDb, Tx } from '../../common/prisma';

const BUILTIN_LABELS = new Set(Object.values(ROLE_LABELS).map((l) => l.toLocaleLowerCase('fr')));

/** Rôles du personnel : rôles intégrés adaptés par l'école et rôles propres à l'école. */
@Injectable()
export class RolesService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async list() {
    const schoolId = currentSchoolId();
    const [config, members] = await Promise.all([
      this.access.load(this.db),
      this.db.membership.findMany({
        where: { schoolId, active: true },
        select: { roles: true, customRoleIds: true },
      }),
    ]);
    const custom = await this.db.customRole.findMany({ orderBy: { name: 'asc' } });
    return {
      builtin: STAFF_ROLES.map((key) => {
        const override = config.overrides[key];
        const permissions = builtinPermissions(key, override);
        return {
          key,
          name: ROLE_LABELS[key],
          permissions,
          defaults: [...ROLE_PERMISSIONS[key]],
          customized: !!override && (override.added.length > 0 || override.removed.length > 0),
          locked: key === 'DIRECTOR' ? [...LOCKED_DIRECTOR_PERMISSIONS] : [],
          classScoped: key === 'TEACHER',
          lineScoped: key === 'TRANSPORT',
          adminAccess: AccessService.resolve(config, { roles: [key], customRoleIds: [] })
            .requiresMfa,
          members: members.filter((m) => m.roles.includes(key)).length,
        };
      }),
      custom: custom.map((r) => {
        const permissions = normalizePermissions(r.permissions);
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          permissions,
          classScoped: r.classScoped,
          lineScoped: r.lineScoped,
          adminAccess: resolveAccess([
            { permissions, classScoped: r.classScoped, lineScoped: r.lineScoped },
          ]).requiresMfa,
          members: members.filter((m) => m.customRoleIds.includes(r.id)).length,
        };
      }),
    };
  }

  /** Transaction de modification des rôles : verrou, nouvelle version, garde-fou, cache. */
  private async change<T>(fn: (tx: Tx, schoolId: string) => Promise<T>): Promise<T> {
    const schoolId = currentSchoolId();
    try {
      return await this.db.$transaction(async (tx) => {
        await this.access.lock(tx, schoolId);
        const result = await fn(tx, schoolId);
        await this.access.assertSomeoneKeepsControl(tx, schoolId);
        await this.access.bump(tx, schoolId);
        return result;
      });
    } finally {
      this.access.invalidate(schoolId);
    }
  }

  async updateBuiltin(role: StaffRole, permissions: Permission[]) {
    const wanted = normalizePermissions(permissions);
    if (role === 'DIRECTOR') {
      const missing = LOCKED_DIRECTOR_PERMISSIONS.filter((p) => !wanted.includes(p));
      if (missing.length > 0)
        throw new ConflictException(
          'La direction garde toujours la gestion du personnel, des rôles et des réglages',
        );
    }
    return this.change(async (tx, schoolId) => {
      const existing = await tx.roleOverride.findUnique({
        where: { schoolId_role: { schoolId, role } },
      });
      const before = builtinPermissions(role, existing);
      this.access.assertCanGrant(wanted.filter((p) => !before.includes(p)));
      const { added, removed } = overrideFor(role, wanted);
      if (added.length === 0 && removed.length === 0) {
        if (existing) await tx.roleOverride.delete({ where: { id: existing.id } });
      } else {
        await tx.roleOverride.upsert({
          where: { schoolId_role: { schoolId, role } },
          create: { schoolId, role, added, removed, updatedById: staffContext().userId },
          update: { added, removed, updatedById: staffContext().userId },
        });
      }
      const after = builtinPermissions(role, { added, removed });
      await this.audit.log(
        {
          action: 'roles.builtin_updated',
          entity: 'StaffRole',
          entityId: role,
          before: { permissions: before },
          after: { permissions: after },
        },
        tx,
      );
      return { key: role, permissions: after };
    });
  }

  async resetBuiltin(role: StaffRole) {
    return this.change(async (tx, schoolId) => {
      const existing = await tx.roleOverride.findUnique({
        where: { schoolId_role: { schoolId, role } },
      });
      const before = builtinPermissions(role, existing);
      const after = builtinPermissions(role);
      this.access.assertCanGrant(after.filter((p) => !before.includes(p)));
      if (existing) await tx.roleOverride.delete({ where: { id: existing.id } });
      await this.audit.log(
        {
          action: 'roles.builtin_reset',
          entity: 'StaffRole',
          entityId: role,
          before: { permissions: before },
          after: { permissions: after },
        },
        tx,
      );
      return { key: role, permissions: after };
    });
  }

  private checkName(name: string) {
    if (BUILTIN_LABELS.has(name.toLocaleLowerCase('fr')))
      throw new ConflictException('Ce nom est déjà celui d’un rôle intégré');
  }

  private snapshot(r: {
    name: string;
    description: string | null;
    permissions: string[];
    classScoped: boolean;
    lineScoped: boolean;
  }) {
    return {
      name: r.name,
      description: r.description,
      permissions: normalizePermissions(r.permissions),
      classScoped: r.classScoped,
      lineScoped: r.lineScoped,
    };
  }

  private async uniqueName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ConflictException('Un rôle porte déjà ce nom');
      throw e;
    }
  }

  async createCustom(input: CustomRoleInput) {
    this.checkName(input.name);
    const permissions = normalizePermissions(input.permissions);
    this.access.assertCanGrant(permissions);
    return this.uniqueName(() =>
      this.change(async (tx, schoolId) => {
        const role = await tx.customRole.create({
          data: {
            schoolId,
            name: input.name,
            description: input.description || null,
            permissions,
            classScoped: input.classScoped,
            lineScoped: input.lineScoped,
            createdById: staffContext().userId,
          },
        });
        await this.audit.log(
          {
            action: 'roles.custom_created',
            entity: 'CustomRole',
            entityId: role.id,
            after: this.snapshot(role),
          },
          tx,
        );
        return role;
      }),
    );
  }

  async updateCustom(id: string, input: CustomRoleInput) {
    this.checkName(input.name);
    const permissions = normalizePermissions(input.permissions);
    return this.uniqueName(() =>
      this.change(async (tx) => {
        const before = await tx.customRole.findUnique({ where: { id } });
        if (!before) throw new NotFoundException('Rôle introuvable');
        this.access.assertCanGrant(permissions.filter((p) => !before.permissions.includes(p)));
        const after = await tx.customRole.update({
          where: { id },
          data: {
            name: input.name,
            description: input.description || null,
            permissions,
            classScoped: input.classScoped,
            lineScoped: input.lineScoped,
          },
        });
        await this.audit.log(
          {
            action: 'roles.custom_updated',
            entity: 'CustomRole',
            entityId: id,
            before: this.snapshot(before),
            after: this.snapshot(after),
          },
          tx,
        );
        return after;
      }),
    );
  }

  async deleteCustom(id: string) {
    return this.change(async (tx, schoolId) => {
      const role = await tx.customRole.findUnique({ where: { id } });
      if (!role) throw new NotFoundException('Rôle introuvable');
      const holders = await tx.membership.count({
        where: { schoolId, active: true, customRoleIds: { has: id } },
      });
      if (holders > 0)
        throw new ConflictException(
          `Ce rôle est encore attribué à ${holders} personne${holders > 1 ? 's' : ''} : retirez-le d’abord`,
        );
      // Les accès désactivés qui portaient ce rôle ne le gardent pas.
      await tx.$executeRaw`UPDATE "Membership" SET "customRoleIds" = array_remove("customRoleIds", ${id}) WHERE "schoolId" = ${schoolId} AND ${id} = ANY("customRoleIds")`;
      await tx.customRole.delete({ where: { id } });
      await this.audit.log(
        {
          action: 'roles.custom_deleted',
          entity: 'CustomRole',
          entityId: id,
          before: this.snapshot(role),
        },
        tx,
      );
      return { ok: true };
    });
  }
}
