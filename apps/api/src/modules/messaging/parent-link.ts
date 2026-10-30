import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parentContext, runAsSystem } from '../../common/context';
import { Db, InjectDb } from '../../common/prisma';

/** Élèves visibles depuis le portail pour la communication (portail et communication activés). */
export const COMMUNICATION_STUDENT = {
  deletedAt: null,
  school: { status: 'ACTIVE', modules: { hasEvery: ['portal', 'communication'] } },
} satisfies Prisma.StudentWhereInput;

export interface ParentChildLink {
  schoolId: string;
  guardianId: string;
  student: { id: string; firstName: string; lastName: string };
}

/**
 * Vérifie que le parent connecté est rattaché à l'élève, dans un établissement qui a activé le
 * portail et la communication. Hors périmètre, l'élève est signalé introuvable.
 */
@Injectable()
export class ParentLinkService {
  constructor(@InjectDb() private readonly db: Db) {}

  async child(studentId: string): Promise<ParentChildLink> {
    const userId = parentContext().userId;
    const link = await runAsSystem('portal-communication-link', () =>
      this.db.studentGuardian.findFirst({
        where: { studentId, guardian: { userId }, student: COMMUNICATION_STUDENT },
        include: { student: { select: { id: true, firstName: true, lastName: true } } },
      }),
    );
    if (!link) throw new NotFoundException('Enfant introuvable');
    return { schoolId: link.schoolId, guardianId: link.guardianId, student: link.student };
  }

  /** Tous les rattachements du parent connecté (plusieurs enfants, plusieurs écoles). */
  async children(): Promise<ParentChildLink[]> {
    const userId = parentContext().userId;
    const links = await runAsSystem('portal-communication-children', () =>
      this.db.studentGuardian.findMany({
        where: { guardian: { userId }, student: COMMUNICATION_STUDENT },
        include: { student: { select: { id: true, firstName: true, lastName: true } } },
      }),
    );
    return links.map((l) => ({
      schoolId: l.schoolId,
      guardianId: l.guardianId,
      student: l.student,
    }));
  }
}
