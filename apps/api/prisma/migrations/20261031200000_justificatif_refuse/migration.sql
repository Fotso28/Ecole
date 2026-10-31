-- Justificatif refusé : motif montré au parent, et absences visées conservées après le refus.
ALTER TABLE "Justification" ADD COLUMN "reviewNote" TEXT;
ALTER TABLE "Justification" ADD COLUMN "recordIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Justificatifs existants : absences encore rattachées (celles d'un refus antérieur sont perdues).
UPDATE "Justification" j
SET "recordIds" = sub.ids
FROM (
  SELECT "justificationId" AS id, array_agg("id" ORDER BY "id") AS ids
  FROM "AttendanceRecord"
  WHERE "justificationId" IS NOT NULL
  GROUP BY "justificationId"
) sub
WHERE sub.id = j."id";
