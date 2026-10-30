import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { currentContext } from './context';

export interface RateWindow {
  limit: number;
  windowMs: number;
}

/** « 5/600,20/86400 » : 5 requêtes par 600 s et 20 par 86 400 s. */
export function parseRateSpec(spec: string): RateWindow[] {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [limit, seconds] = part.split('/').map(Number);
      if (!Number.isInteger(limit) || !Number.isInteger(seconds) || !limit || !seconds)
        throw new Error(`Limite de débit invalide : « ${part} »`);
      return { limit, windowMs: seconds * 1000 };
    });
}

/**
 * Compteurs à fenêtre fixe en mémoire (une instance d'API). Une requête refusée n'est pas
 * comptée : un client bloqué retrouve l'accès à la fin de la fenêtre.
 */
export class RateLimiter {
  private static readonly buckets = new Map<string, { count: number; resetAt: number }>();

  static hit(
    key: string,
    windows: RateWindow[],
    now = Date.now(),
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    if (this.buckets.size > 50_000) this.purge(now);
    const states = windows.map((w) => {
      const id = `${key}|${w.windowMs}`;
      let b = this.buckets.get(id);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + w.windowMs };
        this.buckets.set(id, b);
      }
      return { w, b };
    });
    const blocked = states.filter(({ w, b }) => b.count >= w.limit);
    if (blocked.length > 0) {
      const resetAt = Math.max(...blocked.map(({ b }) => b.resetAt));
      return { allowed: false, retryAfterSeconds: Math.ceil((resetAt - now) / 1000) };
    }
    for (const { b } of states) b.count++;
    return { allowed: true };
  }

  static reset(): void {
    this.buckets.clear();
  }

  private static purge(now: number): void {
    for (const [id, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(id);
  }
}

export type RateLimitBucket = 'portal-payment' | 'cashier-payment' | 'operator-callback';

const RATE_LIMIT_KEY = 'ecole:rate-limit';

function windowsFor(bucket: RateLimitBucket): RateWindow[] {
  const e = env();
  if (bucket === 'portal-payment') return parseRateSpec(e.PAYMENT_RATE_PORTAL);
  if (bucket === 'cashier-payment') return parseRateSpec(e.PAYMENT_RATE_CASHIER);
  return parseRateSpec(e.PAYMENT_RATE_CALLBACK);
}

/**
 * Limite de débit dédiée, appliquée après l'authentification : par utilisateur connecté,
 * ou par adresse IP pour les appels anonymes (confirmations des opérateurs).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const bucket = this.reflector.getAllAndOverride<RateLimitBucket | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!bucket) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const ctx = currentContext();
    const who =
      ctx && 'userId' in ctx
        ? `user:${ctx.userId}`
        : ctx?.kind === 'system' && ctx.actorId
          ? `user:${ctx.actorId}`
          : `ip:${req.ip ?? 'inconnue'}`;
    const result = RateLimiter.hit(`${bucket}:${who}`, windowsFor(bucket));
    if (result.allowed) return true;
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(result.retryAfterSeconds));
    const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
    throw new HttpException(
      `Trop de demandes de paiement. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** Applique la limite de débit `bucket` à une route. */
export const RateLimit = (bucket: RateLimitBucket) =>
  applyDecorators(SetMetadata(RATE_LIMIT_KEY, bucket), UseGuards(RateLimitGuard));
