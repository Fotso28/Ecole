import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { permissionsForRoles, type StaffRole } from '@ecole/shared';
import { TokenKind, User } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import type { AccessTokenPayload } from '../../common/auth.guard';
import { runAsSystem } from '../../common/context';
import {
  decrypt,
  encrypt,
  generateTotpSecret,
  hmacSha256,
  randomDigits,
  randomToken,
  safeEqual,
  sha256,
  verifyTotp,
} from '../../common/crypto';
import { Db, InjectDb } from '../../common/prisma';
import { NotificationsService } from '../notifications/notifications.service';
import { templates } from '../notifications/templates';

export interface SessionResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  kind: 'staff' | 'parent';
  activeSchoolId: string | null;
}

export type LoginResult = SessionResult | { mfaRequired: true; mfaToken: string };

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_WINDOW = 3;
const OTP_WINDOW_MS = 15 * 60 * 1000;
// Empreinte factice pour garder un temps de réponse constant si l'utilisateur n'existe pas.
let dummyHash: string | undefined;

@Injectable()
export class AuthService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  static hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async loginStaff(email: string, password: string, userAgent?: string): Promise<LoginResult> {
    const user = await this.db.user.findUnique({ where: { email } });
    dummyHash ??= await AuthService.hashPassword(randomToken());
    const ok = await argon2.verify(user?.passwordHash ?? dummyHash, password).catch(() => false);
    if (!user || !user.passwordHash || !ok || user.status !== 'ACTIVE') {
      await this.audit.log({
        action: 'auth.login_failed',
        entity: 'User',
        entityId: user?.id,
        schoolId: null,
        after: { email },
      });
      throw new UnauthorizedException('Adresse e-mail ou mot de passe incorrect');
    }
    if (user.mfaEnabled) {
      const mfaToken = await this.jwt.signAsync({ sub: user.id, typ: 'mfa' }, { expiresIn: 300 });
      return { mfaRequired: true, mfaToken };
    }
    return this.startStaffSession(user, userAgent);
  }

  async verifyMfa(mfaToken: string, code: string, userAgent?: string): Promise<SessionResult> {
    let payload: { sub: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(mfaToken);
    } catch {
      throw new UnauthorizedException('Étape de vérification expirée, reconnectez-vous');
    }
    if (payload.typ !== 'mfa') throw new UnauthorizedException();
    const user = await this.db.user.findUnique({ where: { id: payload.sub } });
    if (!user?.mfaSecret || !user.mfaEnabled || user.status !== 'ACTIVE')
      throw new UnauthorizedException();
    if (!verifyTotp(decrypt(user.mfaSecret, env().DATA_ENCRYPTION_KEY), code)) {
      await this.audit.log({
        action: 'auth.mfa_failed',
        entity: 'User',
        entityId: user.id,
        schoolId: null,
      });
      throw new UnauthorizedException('Code de vérification incorrect');
    }
    return this.startStaffSession(user, userAgent);
  }

  private async startStaffSession(user: User, userAgent?: string): Promise<SessionResult> {
    const membership = await this.db.membership.findFirst({
      where: { userId: user.id, active: true, school: { status: 'ACTIVE' } },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership && !user.isPlatformAdmin)
      throw new ForbiddenException('Aucun établissement associé à ce compte');
    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({
      action: 'auth.login',
      entity: 'User',
      entityId: user.id,
      schoolId: membership?.schoolId ?? null,
    });
    return this.issueSession(
      user.id,
      'STAFF',
      membership?.schoolId ?? null,
      randomUUID(),
      userAgent,
    );
  }

  private async issueSession(
    userId: string,
    kind: TokenKind,
    schoolId: string | null,
    familyId: string,
    userAgent?: string,
  ): Promise<SessionResult> {
    const { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS } = env();
    const payload: AccessTokenPayload = {
      sub: userId,
      typ: kind === 'STAFF' ? 'staff' : 'parent',
      ...(schoolId ? { sch: schoolId } : {}),
    };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
    const refreshToken = randomToken(48);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await this.db.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        familyId,
        kind,
        schoolId,
        expiresAt: refreshExpiresAt,
        userAgent,
      },
    });
    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresAt,
      kind: kind === 'STAFF' ? 'staff' : 'parent',
      activeSchoolId: schoolId,
    };
  }

  /** Rotation du jeton de rafraîchissement ; la réutilisation d'un ancien jeton révoque toute la famille. */
  async refresh(rawToken: string | undefined, userAgent?: string): Promise<SessionResult> {
    if (!rawToken) throw new UnauthorizedException('Session absente');
    const stored = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
    });
    if (!stored) throw new UnauthorizedException('Session inconnue');
    if (stored.revokedAt) {
      await this.db.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({
        action: 'auth.refresh_reuse',
        entity: 'User',
        entityId: stored.userId,
        schoolId: stored.schoolId,
      });
      throw new UnauthorizedException('Session révoquée, reconnectez-vous');
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedException('Session expirée');
    const user = await this.db.user.findUnique({ where: { id: stored.userId } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Compte inactif');
    let schoolId = stored.schoolId;
    if (stored.kind === 'STAFF' && schoolId) {
      const m = await this.db.membership.findUnique({
        where: { userId_schoolId: { userId: user.id, schoolId } },
      });
      if (!m?.active) schoolId = null;
      if (!schoolId && !user.isPlatformAdmin) throw new UnauthorizedException('Accès retiré');
    }
    const next = await this.issueSession(
      user.id,
      stored.kind,
      schoolId,
      stored.familyId,
      userAgent,
    );
    const nextRow = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256(next.refreshToken) },
    });
    const updated = await this.db.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedBy: nextRow?.id },
    });
    if (updated.count === 0) {
      // Rafraîchissement concurrent : l'autre requête a déjà fait tourner le jeton.
      await this.db.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Session révoquée, reconnectez-vous');
    }
    return next;
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const stored = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
    });
    if (stored) {
      await this.db.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }

  async switchSchool(
    userId: string,
    schoolId: string,
    rawToken: string | undefined,
    userAgent?: string,
  ): Promise<SessionResult> {
    const membership = await this.db.membership.findUnique({
      where: { userId_schoolId: { userId, schoolId } },
      include: { school: { select: { status: true } } },
    });
    if (!membership?.active || membership.school.status !== 'ACTIVE')
      throw new ForbiddenException('Établissement non autorisé');
    await this.logout(rawToken);
    return this.issueSession(userId, 'STAFF', schoolId, randomUUID(), userAgent);
  }

  async me(userId: string, kind: 'staff' | 'parent', activeSchoolId: string | null) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        isPlatformAdmin: true,
        mfaEnabled: true,
      },
    });
    if (kind === 'parent') return { user, kind, schools: [], activeSchool: null, permissions: [] };
    const memberships = await this.db.membership.findMany({
      where: { userId, active: true },
      include: {
        school: { select: { id: true, name: true, city: true, modules: true, settings: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const active = memberships.find((m) => m.schoolId === activeSchoolId);
    const roles = (active?.roles ?? []) as StaffRole[];
    return {
      user,
      kind,
      schools: memberships.map((m) => ({
        id: m.school.id,
        name: m.school.name,
        city: m.school.city,
        roles: m.roles,
      })),
      activeSchool: active
        ? {
            id: active.school.id,
            name: active.school.name,
            city: active.school.city,
            modules: active.school.modules,
            mfaRequired: !!(active.school.settings as { mfaRequired?: boolean }).mfaRequired,
          }
        : null,
      roles,
      permissions: [...permissionsForRoles(roles)],
    };
  }

  async setupMfa(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled)
      throw new BadRequestException('La double authentification est déjà active');
    const secret = generateTotpSecret();
    await this.db.user.update({
      where: { id: userId },
      data: { mfaSecret: encrypt(secret, env().DATA_ENCRYPTION_KEY) },
    });
    const label = encodeURIComponent(`Ecole:${user.email ?? user.phone ?? user.id}`);
    return {
      secret,
      otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Ecole&digits=6&period=30`,
    };
  }

  async enableMfa(userId: string, code: string): Promise<void> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaSecret) throw new BadRequestException('Commencez par générer un secret');
    if (!verifyTotp(decrypt(user.mfaSecret, env().DATA_ENCRYPTION_KEY), code)) {
      throw new BadRequestException('Code incorrect');
    }
    await this.db.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
    await this.audit.log({ action: 'auth.mfa_enabled', entity: 'User', entityId: userId });
  }

  /**
   * Demande de code de connexion parent. La réponse est identique que le numéro soit
   * connu ou non, pour ne pas révéler quels numéros sont enregistrés.
   */
  async requestOtp(phone: string): Promise<void> {
    const since = new Date(Date.now() - OTP_WINDOW_MS);
    const recent = await this.db.otpCode.count({ where: { phone, createdAt: { gte: since } } });
    if (recent >= OTP_MAX_PER_WINDOW) {
      throw new HttpException(
        'Trop de demandes de code. Réessayez dans quelques minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const known = await runAsSystem('otp-lookup', () =>
      this.db.guardian.count({ where: { phone } }),
    );
    const code = randomDigits(6);
    await this.db.otpCode.create({
      data: {
        phone,
        codeHash: hmacSha256(env().OTP_SECRET, `${phone}:${code}`),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });
    if (known === 0) return;
    const n = await this.notifications.enqueue({
      recipient: phone,
      template: 'otp',
      body: templates.otp(code),
    });
    await this.notifications.dispatchNow(n.id);
  }

  async verifyOtp(phone: string, code: string, userAgent?: string): Promise<SessionResult> {
    const otp = await this.db.otpCode.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const invalid = new UnauthorizedException('Code incorrect ou expiré');
    if (!otp) throw invalid;
    if (otp.attempts >= OTP_MAX_ATTEMPTS) throw invalid;
    await this.db.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    if (!safeEqual(otp.codeHash, hmacSha256(env().OTP_SECRET, `${phone}:${code}`))) throw invalid;
    const consumed = await this.db.otpCode.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) throw invalid;

    const guardians = await runAsSystem('otp-login', () =>
      this.db.guardian.findMany({ where: { phone }, orderBy: { createdAt: 'asc' } }),
    );
    const first = guardians[0];
    if (!first) throw invalid;
    let user = await this.db.user.findUnique({ where: { phone } });
    user ??= await this.db.user.create({
      data: { phone, firstName: first.firstName, lastName: first.lastName },
    });
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Compte inactif');
    const userId = user.id;
    await runAsSystem('otp-link', () =>
      this.db.guardian.updateMany({ where: { phone, userId: null }, data: { userId } }),
    );
    await this.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.audit.log({
      action: 'auth.parent_login',
      entity: 'User',
      entityId: userId,
      schoolId: null,
    });
    return this.issueSession(userId, 'PARENT', null, randomUUID(), userAgent);
  }
}
