import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Permission, StaffRole } from '@ecole/shared';

export interface StaffContext {
  kind: 'staff';
  userId: string;
  schoolId: string;
  roles: StaffRole[];
  permissions: ReadonlySet<Permission>;
  isPlatformAdmin: boolean;
  breakGlass: boolean;
  ip?: string;
}

export interface ParentContext {
  kind: 'parent';
  userId: string;
  ip?: string;
}

export interface SystemContext {
  kind: 'system';
  reason: string;
  /** Si présent, les requêtes sont limitées à cet établissement. */
  schoolId?: string;
  actorId?: string;
  ip?: string;
}

/** Utilisateur authentifié sans établissement actif (ex. super-administrateur). */
export interface AccountContext {
  kind: 'account';
  userId: string;
  isPlatformAdmin: boolean;
  ip?: string;
}

export interface AnonymousContext {
  kind: 'anonymous';
  ip?: string;
}

export type RequestContext =
  | StaffContext
  | ParentContext
  | SystemContext
  | AccountContext
  | AnonymousContext;

interface Holder {
  current: RequestContext;
  /** Identifiant de corrélation des journaux (requête HTTP ou exécution de tâche). */
  requestId?: string;
}

const storage = new AsyncLocalStorage<Holder>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T, requestId?: string): T {
  return storage.run({ current: ctx, requestId }, fn);
}

/** Variante asynchrone : attend `fn` dans le contexte (nécessaire pour les requêtes Prisma, paresseuses). */
export function runInContext<T>(ctx: RequestContext, fn: () => T | PromiseLike<T>): Promise<T> {
  return storage.run({ current: ctx }, async () => await fn());
}

/** Remplace le contexte de la requête en cours (utilisé par le garde d'authentification). */
export function setContext(ctx: RequestContext): void {
  const holder = storage.getStore();
  if (!holder) throw new Error('Aucun contexte de requête actif');
  holder.current = ctx;
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore()?.current;
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Exécute du code avec les droits du système (tâches de fond, webhooks, portail parent
 * après vérification du lien parent-enfant). Préciser `schoolId` dès que possible.
 * La fonction est attendue à l'intérieur du contexte : les requêtes Prisma, paresseuses,
 * s'exécutent ainsi bien avec ces droits.
 */
export function runAsSystem<T>(
  reason: string,
  fn: () => T | PromiseLike<T>,
  schoolId?: string,
): Promise<T> {
  const parent = currentContext();
  return storage.run(
    {
      requestId: currentRequestId(),
      current: {
        kind: 'system',
        reason,
        schoolId,
        actorId:
          parent && 'userId' in parent
            ? parent.userId
            : parent?.kind === 'system'
              ? parent.actorId
              : undefined,
        ip: parent?.ip,
      },
    },
    async () => await fn(),
  );
}

export function staffContext(): StaffContext {
  const ctx = currentContext();
  if (!ctx || ctx.kind === 'anonymous') throw new UnauthorizedException();
  if (ctx.kind !== 'staff') throw new ForbiddenException('Réservé au personnel de l’établissement');
  return ctx;
}

export function parentContext(): ParentContext {
  const ctx = currentContext();
  if (!ctx || ctx.kind === 'anonymous') throw new UnauthorizedException();
  if (ctx.kind !== 'parent') throw new ForbiddenException('Réservé aux parents');
  return ctx;
}

/** Établissement courant : contexte personnel ou contexte système limité à une école. */
export function currentSchoolId(): string {
  const ctx = currentContext();
  if (ctx?.kind === 'staff') return ctx.schoolId;
  if (ctx?.kind === 'system' && ctx.schoolId) return ctx.schoolId;
  throw new ForbiddenException('Aucun établissement dans le contexte');
}

export function currentActorId(): string | undefined {
  const ctx = currentContext();
  if (!ctx) return undefined;
  if (ctx.kind === 'staff' || ctx.kind === 'parent' || ctx.kind === 'account') return ctx.userId;
  if (ctx.kind === 'system') return ctx.actorId;
  return undefined;
}
