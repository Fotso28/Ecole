import { SEARCH_FOLD_FROM, SEARCH_FOLD_TO, searchWords } from '@ecole/shared';
import { Prisma } from '@prisma/client';
import { currentSchoolId } from './context';
import type { Db, Tx } from './prisma';

/**
 * Nom, prénoms et matricule repliés comme `foldForSearch` : minuscules, sans accents. Fonctions
 * natives de PostgreSQL (`lower`, `translate`, `replace`), sans extension.
 */
const HAYSTACK = Prisma.sql`replace(replace(translate(lower("lastName" || ' ' || "firstName" || ' ' || "matricule"), ${SEARCH_FOLD_FROM}, ${SEARCH_FOLD_TO}), 'œ', 'oe'), 'æ', 'ae')`;

/**
 * Élèves (non supprimés) de l'établissement courant dont le nom, les prénoms ou le matricule
 * contiennent chacun des mots cherchés, sans tenir compte des accents, de la casse ni de l'ordre
 * (« ngono paul », « Paul Ngono », « cedric »). Renvoie `null` pour une recherche vide.
 * La requête passe par le client cloisonné : la Row-Level Security s'applique, en plus du filtre
 * explicite sur l'établissement.
 */
export async function matchStudentIds(
  db: Db | Tx,
  search: string,
  limit = 5000,
): Promise<string[] | null> {
  const words = searchWords(search);
  if (words.length === 0) return null;
  const conditions = words.map((w) => Prisma.sql`strpos(${HAYSTACK}, ${w}) > 0`);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Student"
    WHERE "schoolId" = ${currentSchoolId()} AND "deletedAt" IS NULL
      AND ${Prisma.join(conditions, ' AND ')}
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}
