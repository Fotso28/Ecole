import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from './context';

/** Ouvre un contexte de requête (anonyme) que le garde d'authentification complète. */
export function contextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  runWithContext({ kind: 'anonymous', ip: req.ip }, () => next());
}
