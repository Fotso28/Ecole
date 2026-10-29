import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PERMISSIONS, permissionsForRoles, type Permission, type StaffRole } from '@ecole/shared';
import type { Request } from 'express';
import { setContext } from './context';
import {
  ACCOUNT_KEY,
  ALLOW_WITHOUT_MFA_KEY,
  MODULE_KEY,
  PARENT_KEY,
  PERMISSIONS_KEY,
  PLATFORM_ADMIN_KEY,
  PUBLIC_KEY,
} from './decorators';
import { Db, InjectDb } from './prisma';

export interface AccessTokenPayload {
  sub: string;
  typ: 'staff' | 'parent';
  /** Établissement actif (personnel). */
  sch?: string;
  /** Accès exceptionnel du super-administrateur, en lecture seule. */
  bg?: boolean;
}

const ADMIN_ROLES: readonly StaffRole[] = ['DIRECTOR', 'CENSOR', 'SECRETARY', 'ACCOUNTANT'];
const READ_ONLY: ReadonlySet<Permission> = new Set(
  PERMISSIONS.filter((p) => p.endsWith('.read') && p !== 'health.read'),
);

interface SchoolSettings {
  mfaRequired?: boolean;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectDb() private readonly db: Db,
  ) {}

  private meta<T>(context: ExecutionContext, key: string): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip;
    if (this.meta<boolean>(context, PUBLIC_KEY)) return true;

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Authentification requise');
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Session expirée');
    }

    const isParentRoute = !!this.meta<boolean>(context, PARENT_KEY);
    const isAccountRoute = !!this.meta<boolean>(context, ACCOUNT_KEY);
    const user = await this.db.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, isPlatformAdmin: true, mfaEnabled: true },
    });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Compte inactif');

    if (payload.typ === 'parent') {
      if (!isParentRoute && !isAccountRoute) throw new ForbiddenException('Réservé au personnel');
      setContext({ kind: 'parent', userId: payload.sub, ip });
      return true;
    }
    if (payload.typ !== 'staff') throw new UnauthorizedException();
    if (isParentRoute) throw new ForbiddenException('Réservé aux parents');

    if (this.meta<boolean>(context, PLATFORM_ADMIN_KEY)) {
      if (!user.isPlatformAdmin) throw new ForbiddenException('Réservé au super-administrateur');
      setContext({ kind: 'system', reason: 'platform-admin', actorId: payload.sub, ip });
      return true;
    }

    if (!payload.sch) {
      if (!isAccountRoute) throw new ForbiddenException('Aucun établissement actif');
      setContext({
        kind: 'account',
        userId: payload.sub,
        isPlatformAdmin: user.isPlatformAdmin,
        ip,
      });
      return true;
    }

    const school = await this.db.school.findUnique({
      where: { id: payload.sch },
      select: { status: true, modules: true, settings: true },
    });
    if (!school || school.status !== 'ACTIVE')
      throw new ForbiddenException('Établissement inaccessible');

    let roles: StaffRole[] = [];
    let permissions: ReadonlySet<Permission>;
    if (payload.bg) {
      if (!user.isPlatformAdmin) throw new UnauthorizedException();
      permissions = READ_ONLY;
    } else {
      const membership = await this.db.membership.findUnique({
        where: { userId_schoolId: { userId: payload.sub, schoolId: payload.sch } },
        select: { roles: true, active: true },
      });
      if (!membership?.active) throw new ForbiddenException('Accès retiré pour cet établissement');
      roles = membership.roles;
      permissions = permissionsForRoles(roles);
    }

    const settings = (school.settings ?? {}) as SchoolSettings;
    if (
      settings.mfaRequired &&
      !payload.bg &&
      !user.mfaEnabled &&
      roles.some((r) => ADMIN_ROLES.includes(r)) &&
      !this.meta<boolean>(context, ALLOW_WITHOUT_MFA_KEY)
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'MFA_SETUP_REQUIRED',
        message: 'Activez la double authentification',
      });
    }

    const required = this.meta<Permission[]>(context, PERMISSIONS_KEY) ?? [];
    const missing = required.filter((p) => !permissions.has(p));
    if (missing.length > 0) throw new ForbiddenException('Permission insuffisante');

    const module = this.meta<string>(context, MODULE_KEY);
    if (module && !school.modules.includes(module)) {
      throw new ForbiddenException('Module non activé pour cet établissement');
    }

    setContext({
      kind: 'staff',
      userId: payload.sub,
      schoolId: payload.sch,
      roles,
      permissions,
      isPlatformAdmin: user.isPlatformAdmin,
      breakGlass: !!payload.bg,
      ip,
    });
    return true;
  }
}
