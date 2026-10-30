-- Bulletins publiés : toutes les colonnes restent figées, sauf le statut (passage à SUPERSEDED)
-- et le signalement « à republier » posé par une réouverture des notes.
CREATE OR REPLACE FUNCTION protect_published_report_card() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Un bulletin publié ne peut pas être supprimé';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'DRAFT' THEN
    IF (to_jsonb(NEW) - 'status' - 'needsRepublish' - 'republishReason')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'needsRepublish' - 'republishReason')
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
