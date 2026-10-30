-- Row-Level Security sur les invitations du personnel (arrivées après 20261031170000).
-- Lues en mode système (rôle ecole_system) par la personne invitée, qui n'a pas encore d'accès à
-- l'école : connexion, /auth/me, réponse à l'invitation.
ALTER TABLE "StaffInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffInvitation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StaffInvitation"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ecole_app', 'ecole_system'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON "StaffInvitation" TO %I', r);
    END IF;
  END LOOP;
END $$;
