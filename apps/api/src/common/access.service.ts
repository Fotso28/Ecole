import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  builtinGrant,
  hasLockedRights,
  normalizePermissions,
  resolveAccess,
  STAFF_ROLES,
  type Permission,
  type ResolvedAccess,
  type RoleGrant,
  type RoleOverride,
  type StaffRole,
} from '@ecole/shared';
import { runAsSystem, staffContext } from './context';
import { Db, InjectDb, Tx } from './prisma';

/** Rôle propre à une école, tel qu'utilisé pour calculer les droits. */
export interface CustomRoleGrant extends RoleGrant {
  id: string;
  name: string;
}

/** Configuration des rôles d'une école : adaptations des rôles intégrés et rôles propres. */
export interface SchoolRoleConfig {
  overrides: Partial<Record<StaffRole, RoleOverride>>;
  customRoles: Map<string, CustomRoleGrant>;
}

/** Membre à évaluer : rôles intégrés et rôles propres attribués. */
export interface RoleAssignment {
  roles: readonly StaffRole[];
  customRoleIds: readonly string[];
}

/** Assez de place pour toutes les écoles actives d'une instance ; au-delà, la plus ancienne sort. */
const MAX_CACHED_SCHOOLS = 2000;

/**
 * Droits effectifs du personnel, calculés depuis la base (rôles intégrés adaptés par l'école et
 * rôles propres). La configuration de chaque école est gardée en mémoire avec son numéro de version
 * (`School.rolesVersion`), relu à chaque requête par le garde : toute modification incrémente ce
 * numéro dans sa transaction, ce qui invalide le cache de toutes les instances de l'API.
 */
@Injectable()
export class AccessService {
  private readonly cache = new Map<string, { version: number; config: SchoolRoleConfig }>();

  constructor(@InjectDb() private readonly db: Db) {}

  /** Configuration des rôles de l'école pour la version donnée (cache, sinon base). */
  async config(schoolId: string, version: number): Promise<SchoolRoleConfig> {
    const hit = this.cache.get(schoolId);
    if (hit && hit.version === version) return hit.config;
    const config = await runAsSystem('roles-config', () => this.load(this.db), schoolId);
    this.cache.delete(schoolId);
    if (this.cache.size >= MAX_CACHED_SCHOOLS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(schoolId, { version, config });
    return config;
  }

  /** Charge la configuration (dans le contexte de l'école, éventuellement dans une transaction). */
  async load(db: Db | Tx): Promise<SchoolRoleConfig> {
    const [overrides, customRoles] = await Promise.all([
      db.roleOverride.findMany(),
      db.customRole.findMany({ orderBy: { name: 'asc' } }),
    ]);
    return {
      overrides: Object.fromEntries(
        overrides.map((o) => [o.role, { added: o.added, removed: o.removed }]),
      ),
      customRoles: new Map(
        customRoles.map((r) => [
          r.id,
          {
            id: r.id,
            name: r.name,
            permissions: normalizePermissions(r.permissions),
            classScoped: r.classScoped,
            lineScoped: r.lineScoped,
          },
        ]),
      ),
    };
  }

  /** Droits effectifs d'un membre selon une configuration. */
  static resolve(config: SchoolRoleConfig, assignment: RoleAssignment): ResolvedAccess {
    const grants: RoleGrant[] = assignment.roles
      .filter((r) => STAFF_ROLES.includes(r))
      .map((r) => builtinGrant(r, config.overrides[r]));
    for (const id of assignment.customRoleIds) {
      const role = config.customRoles.get(id);
      if (role) grants.push(role);
    }
    return resolveAccess(grants);
  }

  async resolve(
    schoolId: string,
    version: number,
    assignment: RoleAssignment,
  ): Promise<ResolvedAccess> {
    return AccessService.resolve(await this.config(schoolId, version), assignment);
  }

  /**
   * Verrouille l'école pour la durée de la transaction : deux modifications simultanées des rôles
   * ou du personnel ne peuvent pas, ensemble, retirer à tout le monde la gestion de l'école.
   */
  async lock(tx: Tx, schoolId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${schoolId} FOR UPDATE`;
  }

  /** À appeler dans la transaction de toute modification des rôles d'une école. */
  async bump(tx: Tx, schoolId: string): Promise<void> {
    await tx.school.update({ where: { id: schoolId }, data: { rolesVersion: { increment: 1 } } });
    this.cache.delete(schoolId);
  }

  /** Oublie la configuration en cache d'une école (après validation de la transaction). */
  invalidate(schoolId: string): void {
    this.cache.delete(schoolId);
  }

  /**
   * Vrai si, dans l'état de la transaction, au moins une personne active de l'école garde la
   * gestion du personnel, des rôles et des réglages.
   */
  async someoneKeepsControl(tx: Tx, schoolId: string): Promise<boolean> {
    const config = await this.load(tx);
    const members = await tx.membership.findMany({
      where: { schoolId, active: true, user: { status: 'ACTIVE' } },
      select: { roles: true, customRoleIds: true },
    });
    return members.some((m) => hasLockedRights(AccessService.resolve(config, m).permissions));
  }

  /** Refuse la modification si plus personne d'actif ne garde la gestion de l'école. */
  async assertSomeoneKeepsControl(tx: Tx, schoolId: string): Promise<void> {
    if (!(await this.someoneKeepsControl(tx, schoolId)))
      throw new ConflictException(
        'Au moins une personne active doit garder la gestion du personnel, des rôles et des réglages',
      );
  }

  /**
   * Empêche l'élévation de privilèges : on n'accorde (par un rôle ou une attribution) que des droits
   * que l'on détient soi-même, sauf à disposer de la gestion complète de l'école (direction).
   */
  assertCanGrant(permissions: Iterable<Permission>): void {
    const ctx = staffContext();
    if (hasLockedRights(ctx.permissions)) return;
    for (const p of permissions) {
      if (!ctx.permissions.has(p))
        throw new ForbiddenException('Vous ne pouvez pas accorder des droits que vous n’avez pas');
    }
  }

  /** Vérifie que les rôles propres existent dans l'école ; renvoie la liste sans doublon. */
  async checkCustomRoleIds(db: Db | Tx, ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return unique;
    const found = await db.customRole.count({ where: { id: { in: unique } } });
    if (found !== unique.length) throw new BadRequestException('Rôle propre à l’école introuvable');
    return unique;
  }
}
