-- Double authentification : verrouillage après des codes erronés, code à usage unique.
ALTER TABLE "User" ADD COLUMN     "mfaFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfaLastStep" INTEGER,
ADD COLUMN     "mfaLockedUntil" TIMESTAMP(3);

-- Paiements : jamais supprimés ; montant, élève et moyen figés ; annulation définitive.
-- Seule exception au statut final : un paiement expiré de notre côté (CANCELLED) que l'opérateur
-- confirme ensuite (SUCCESS), car le payeur a bien été débité.
CREATE OR REPLACE FUNCTION protect_payment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un paiement ne peut pas être supprimé';
  END IF;
  IF NEW."amount" <> OLD."amount" OR NEW."studentId" <> OLD."studentId" OR NEW."method" <> OLD."method" OR NEW."schoolId" <> OLD."schoolId" THEN
    RAISE EXCEPTION 'Le montant, l''élève et le moyen d''un paiement ne peuvent pas être modifiés';
  END IF;
  IF NEW."status" <> OLD."status" AND (
    OLD."status" IN ('SUCCESS', 'FAILED')
    OR (OLD."status" = 'CANCELLED' AND NEW."status" <> 'SUCCESS')
  ) THEN
    RAISE EXCEPTION 'Le statut final d''un paiement ne peut pas changer';
  END IF;
  IF OLD."reversedAt" IS NOT NULL AND (
    NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt"
    OR NEW."reversalReason" IS DISTINCT FROM OLD."reversalReason"
    OR NEW."reversedById" IS DISTINCT FROM OLD."reversedById"
  ) THEN
    RAISE EXCEPTION 'L''annulation d''un paiement est définitive';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Bulletins publiés : toutes les colonnes figées, seul le passage à SUPERSEDED est permis.
CREATE OR REPLACE FUNCTION protect_published_report_card() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Un bulletin publié ne peut pas être supprimé';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'DRAFT' THEN
    IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
      OR NOT (OLD."status" = 'PUBLISHED' AND NEW."status" IN ('PUBLISHED', 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'Un bulletin publié est figé : créer une nouvelle version';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
