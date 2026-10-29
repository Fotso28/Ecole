import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/** Traduit les erreurs Prisma et PostgreSQL en réponses HTTP lisibles. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res
        .status(exception.getStatus())
        .json(
          typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body,
        );
      return;
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapKnown(exception);
      if (mapped) {
        res.status(mapped.status).json({ statusCode: mapped.status, message: mapped.message });
        return;
      }
    }
    const message = exception instanceof Error ? exception.message : String(exception);
    const trigger = /ne peu(t|vent) (pas )?(être|ni|changer)|est figé/.exec(message);
    if (trigger) {
      res
        .status(HttpStatus.CONFLICT)
        .json({ statusCode: HttpStatus.CONFLICT, message: extractDbMessage(message) });
      return;
    }
    this.logger.error(exception instanceof Error ? exception.stack : message);
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, message: 'Erreur interne' });
  }
}

function mapKnown(
  e: Prisma.PrismaClientKnownRequestError,
): { status: number; message: string } | null {
  switch (e.code) {
    case 'P2002':
      return { status: HttpStatus.CONFLICT, message: 'Cet enregistrement existe déjà' };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, message: 'Enregistrement introuvable' };
    case 'P2003':
      return { status: HttpStatus.BAD_REQUEST, message: 'Référence invalide' };
    case 'P2010': {
      const m = extractDbMessage(e.message);
      return { status: HttpStatus.CONFLICT, message: m };
    }
    default:
      return null;
  }
}

function extractDbMessage(message: string): string {
  const m =
    /(Les écritures[^"\n]*|Un paiement[^"\n]*|Le montant[^"\n]*|Le statut final[^"\n]*|Un bulletin[^"\n]*)/.exec(
      message,
    );
  return m?.[1]?.trim() ?? 'Opération refusée par la base de données';
}
