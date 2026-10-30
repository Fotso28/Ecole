import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
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
  totpStep,
} from '../../common/crypto';
import { Db, InjectDb, Tx } from '../../common/prisma';
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

/**
 * Codes SMS des parents (voir docs/exploitation.md, « Codes SMS de connexion ») :
 * - deux quotas par numéro, l'un pour les appareils de confiance (déjà connectés avec ce numéro),
 *   l'autre pour les demandes anonymes : un tiers qui épuise le second ne bloque pas le premier ;
 * - un code reste valable toute la fenêtre et une nouvelle demande n'annule pas les précédents :
 *   quand le quota anonyme est atteint, le dernier SMS reçu par le parent est encore utilisable ;
 * - plafonds journaliers par numéro et budget SMS global pour les demandes anonymes.
 */
const OTP_TTL_MS = 15 * 60 * 1000;
const OTP_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_PER_WINDOW = 3;
const OTP_MAX_PER_DAY = 6;
const OTP_MAX_FAILURES_PER_WINDOW = 5;
const OTP_MAX_FAILURES_PER_DAY = 20;
const DAY_MS = 24 * 3600 * 1000;
export const DEVICE_TOKEN_TTL_DAYS = 180;
const MFA_MAX_FAILURES = 5;
const MFA_LOCK_MS = 15 * 60 * 1000;
// Empreinte factice pour garder un temps de réponse constant si l'utilisateur n'existe pas.
let dummyHash: string | undefined;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    @InjectDb() private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  static hashPassword(password: string): Promise<string> {
    // Paramètres allégés uniquement pour les tests automatisés ; argon2id par défaut sinon.
    const light = process.env.NODE_ENV === 'test' ? { memoryCost: 4096, timeCost: 2 } : {};
    return argon2.hash(password, { type: argon2.argon2id, ...light });
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
    if (user.mfaLockedUntil && user.mfaLockedUntil > new Date())
      throw new HttpException(
        'Trop de codes erronés. Réessayez dans quelques minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const step = totpStep(decrypt(user.mfaSecret, env().DATA_ENCRYPTION_KEY), code);
    // Le pas est enregistré de façon atomique : un code déjà utilisé est refusé.
    const accepted =
      step !== null &&
      (
        await this.db.user.updateMany({
          where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
          data: { mfaLastStep: step, mfaFailedAttempts: 0, mfaLockedUntil: null },
        })
      ).count === 1;
    if (!accepted) {
      const updated = await this.db.user.update({
        where: { id: user.id },
        data: { mfaFailedAttempts: { increment: 1 } },
      });
      if (updated.mfaFailedAttempts >= MFA_MAX_FAILURES)
        await this.db.user.update({
          where: { id: user.id },
          data: { mfaFailedAttempts: 0, mfaLockedUntil: new Date(Date.now() + MFA_LOCK_MS) },
        });
      await this.audit.log({
        action: 'auth.mfa_failed',
        entity: 'User',
        entityId: user.id,
        schoolId: null,
        after: { replay: step !== null },
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
    const currentYear = active
      ? await runAsSystem(
          'me-year',
          () =>
            this.db.academicYear.findFirst({
              where: { isCurrent: true },
              select: { id: true, name: true },
            }),
          active.schoolId,
        )
      : null;
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
            currentYear,
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
    const step = totpStep(decrypt(user.mfaSecret, env().DATA_ENCRYPTION_KEY), code);
    if (step === null) throw new BadRequestException('Code incorrect');
    await this.db.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaLastStep: step },
    });
    await this.audit.log({ action: 'auth.mfa_enabled', entity: 'User', entityId: userId });
  }

  /** Jeton d'appareil de confiance pour un numéro, remis après une connexion réussie. */
  static deviceToken(phone: string, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + DEVICE_TOKEN_TTL_DAYS * 86_400;
    return `v1.${exp}.${hmacSha256(env().OTP_SECRET, `device:${phone}:${exp}`).slice(0, 32)}`;
  }

  static isTrustedDevice(phone: string, token: string | undefined, now = Date.now()): boolean {
    const m = /^v1\.(\d{1,12})\.([0-9a-f]{32})$/.exec(token ?? '');
    if (!m?.[1] || !m[2] || Number(m[1]) * 1000 < now) return false;
    return safeEqual(m[2], hmacSha256(env().OTP_SECRET, `device:${phone}:${m[1]}`).slice(0, 32));
  }

  /** Sérialise les opérations sur les codes d'un numéro (quotas exacts malgré les requêtes simultanées). */
  private lockPhone(tx: Tx, phone: string) {
    return tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`otp:${phone}`}))) AS l`;
  }

  /**
   * Demande de code de connexion parent. La réponse est identique que le numéro soit
   * connu ou non, et que le quota soit atteint ou non, pour ne rien révéler.
   */
  async requestOtp(phone: string, deviceToken?: string): Promise<{ sent: boolean }> {
    const trusted = AuthService.isTrustedDevice(phone, deviceToken);
    const known = await runAsSystem('otp-lookup', () =>
      this.db.guardian.count({ where: { phone } }),
    );
    const code = randomDigits(6);
    const outcome = await this.db.$transaction(async (tx) => {
      await this.lockPhone(tx, phone);
      const now = Date.now();
      const [inWindow, inDay] = await Promise.all([
        tx.otpCode.count({
          where: { phone, trusted, createdAt: { gte: new Date(now - OTP_WINDOW_MS) } },
        }),
        tx.otpCode.count({ where: { phone, trusted, createdAt: { gte: new Date(now - DAY_MS) } } }),
      ]);
      if (inWindow >= OTP_MAX_PER_WINDOW || inDay >= OTP_MAX_PER_DAY) return 'throttled' as const;
      // Budget SMS global des demandes anonymes : plafonne le coût d'une attaque sur de nombreux
      // numéros. Les appareils de confiance n'y sont pas soumis.
      const overBudget =
        !trusted &&
        known > 0 &&
        (await tx.otpCode.count({
          where: { sent: true, trusted: false, createdAt: { gte: new Date(now - DAY_MS) } },
        })) >= env().OTP_DAILY_SMS_BUDGET;
      const send = known > 0 && !overBudget;
      await tx.otpCode.create({
        data: {
          phone,
          codeHash: hmacSha256(env().OTP_SECRET, `${phone}:${code}`),
          expiresAt: new Date(now + OTP_TTL_MS),
          trusted,
          sent: send,
        },
      });
      if (overBudget) return 'over-budget' as const;
      return send ? ('send' as const) : ('unknown' as const);
    });
    if (outcome === 'throttled') {
      this.logger.warn(`Quota de codes atteint (${trusted ? 'appareil de confiance' : 'anonyme'})`);
      return { sent: false };
    }
    if (outcome === 'over-budget') {
      this.logger.error('Budget journalier de SMS de connexion atteint : demandes anonymes suspendues');
      return { sent: false };
    }
    if (outcome !== 'send') return { sent: false };
    const n = await this.notifications.enqueue({
      recipient: phone,
      template: 'otp',
      body: templates.otp(code),
    });
    // Envoi sans attendre la passerelle SMS : le temps de réponse ne révèle pas si le numéro
    // est connu. En cas d'échec, le worker reprend le message de la table d'envoi.
    void this.notifications.dispatchNow(n.id);
    return { sent: true };
  }

  async verifyOtp(
    phone: string,
    code: string,
    userAgent?: string,
    deviceToken?: string,
  ): Promise<SessionResult> {
    const trusted = AuthService.isTrustedDevice(phone, deviceToken);
    const invalid = new UnauthorizedException('Code incorrect ou expiré');
    const result = await this.db.$transaction(async (tx) => {
      await this.lockPhone(tx, phone);
      const now = Date.now();
      // Essais erronés comptés par numéro et séparément pour les appareils de confiance :
      // un tiers qui multiplie les faux codes ne bloque pas le parent sur son téléphone habituel.
      const [failuresInWindow, failuresInDay] = await Promise.all([
        tx.otpFailure.count({
          where: { phone, trusted, createdAt: { gte: new Date(now - OTP_WINDOW_MS) } },
        }),
        tx.otpFailure.count({
          where: { phone, trusted, createdAt: { gte: new Date(now - DAY_MS) } },
        }),
      ]);
      if (
        failuresInWindow >= OTP_MAX_FAILURES_PER_WINDOW ||
        failuresInDay >= OTP_MAX_FAILURES_PER_DAY
      )
        return 'locked' as const;
      // Tous les codes encore valables sont acceptés : une demande d'un tiers n'annule pas le
      // code que le parent vient de recevoir.
      const active = await tx.otpCode.findMany({
        where: { phone, consumedAt: null, expiresAt: { gt: new Date(now) } },
        orderBy: { createdAt: 'desc' },
        take: 2 * OTP_MAX_PER_WINDOW,
      });
      const hash = hmacSha256(env().OTP_SECRET, `${phone}:${code}`);
      const match = active.find((o) => safeEqual(o.codeHash, hash));
      if (!match) {
        await tx.otpFailure.create({ data: { phone, trusted } });
        if (active[0])
          await tx.otpCode.update({
            where: { id: active[0].id },
            data: { attempts: { increment: 1 } },
          });
        return 'invalid' as const;
      }
      await tx.otpCode.update({ where: { id: match.id }, data: { consumedAt: new Date(now) } });
      return 'ok' as const;
    });
    if (result === 'locked')
      throw new HttpException(
        'Trop de codes erronés. Réessayez dans quelques minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (result === 'invalid') throw invalid;

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
