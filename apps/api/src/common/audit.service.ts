import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentActorId, currentContext, runAsSystem } from './context';
import { Db, InjectDb, rlsCovers, Tx } from './prisma';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  schoolId?: string | null;
  /** Auteur connu hors contexte de requête (connexion réussie : la personne qui se connecte). */
  actorId?: string | null;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Journal d'audit : qui a fait quoi, quand, avec l'état avant et après. */
@Injectable()
export class AuditService {
  constructor(@InjectDb() private readonly db: Db) {}

  async log(entry: AuditEntry, tx?: Tx): Promise<void> {
    const ctx = currentContext();
    const schoolId =
      entry.schoolId !== undefined
        ? entry.schoolId
        : ctx?.kind === 'staff'
          ? ctx.schoolId
          : ctx?.kind === 'system'
            ? (ctx.schoolId ?? null)
            : null;
    const data = {
      schoolId,
      actorId: entry.actorId !== undefined ? entry.actorId : (currentActorId() ?? null),
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: toJson(entry.before),
      after: toJson(entry.after),
      reason: entry.reason ?? null,
      ip: ctx?.ip ?? null,
    };
    const write = () => (tx ?? this.db).auditLog.create({ data });
    // Entrée hors de la portée de la base (connexion, portail parent, événement de plateforme) :
    // écrite en mode système, la Row-Level Security refuserait sinon la ligne.
    if (rlsCovers(schoolId)) await write();
    else await runAsSystem(`audit:${entry.action}`, write);
  }
}
