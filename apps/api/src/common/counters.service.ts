import { Injectable } from '@nestjs/common';
import { currentSchoolId } from './context';
import { Db, InjectDb, Tx } from './prisma';

/** Compteurs séquentiels par établissement (matricules, numéros de reçu), sans trou ni doublon. */
@Injectable()
export class CountersService {
  constructor(@InjectDb() private readonly db: Db) {}

  async next(key: string, tx?: Tx): Promise<number> {
    const schoolId = currentSchoolId();
    const rows = await (tx ?? this.db).$queryRaw<{ value: number }[]>`
      INSERT INTO "Counter" ("schoolId", "key", "value") VALUES (${schoolId}, ${key}, 1)
      ON CONFLICT ("schoolId", "key") DO UPDATE SET "value" = "Counter"."value" + 1
      RETURNING "value"`;
    const value = rows[0]?.value;
    if (value === undefined) throw new Error('Compteur indisponible');
    return Number(value);
  }
}
