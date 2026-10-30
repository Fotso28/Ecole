import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { currentContext, runWithContext } from './context';
import { appLogger } from './logger';

const REQUEST_ID = /^[\w.:-]{8,64}$/;

/** Chemin journalisé : sans la chaîne de requête, qui peut contenir des données personnelles. */
function routeOf(req: Request): string {
  return (req.originalUrl ?? req.url).split('?')[0]!.slice(0, 200);
}

/**
 * Ouvre un contexte de requête (anonyme) que le garde d'authentification complète,
 * avec un identifiant de requête (repris de Nginx s'il est valide) renvoyé dans
 * l'en-tête `x-request-id`, puis journalise l'accès à la fin de la réponse.
 */
export function contextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  const started = process.hrtime.bigint();
  runWithContext(
    { kind: 'anonymous', ip: req.ip },
    () => {
      // Lié au contexte de la requête : l'école renseignée par le garde y figure.
      res.on(
        'finish',
        AsyncLocalStorage.bind(() => {
          const ctx = currentContext();
          const status = res.statusCode;
          // Les sondes de santé (Docker, worker) ne remplissent pas les journaux.
          if (status < 400 && req.path.endsWith('/health')) return;
          appLogger().event(
            status >= 500 ? 'error' : status >= 400 ? 'warn' : 'log',
            'HTTP',
            'accès',
            {
              method: req.method,
              path: routeOf(req),
              status,
              durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
              actor: ctx?.kind,
            },
          );
        }),
      );
      next();
    },
    requestId,
  );
}
