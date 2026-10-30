-- Row-Level Security sur les invitations du personnel (arrivées avec 20261031160000). Même
-- politique que les autres tables cloisonnées ; la lecture des invitations d'un compte toutes
-- écoles confondues (GET /auth/me) et leur acceptation passent par le mode système.

ALTER TABLE "StaffInvitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffInvitation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StaffInvitation"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

-- Droits des rôles applicatifs sur cette table, s'ils existent (aussi : prisma/app-role-grants.sql).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ecole_app', 'ecole_system'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON "StaffInvitation" TO %I', r);
    END IF;
  END LOOP;
END $$;
