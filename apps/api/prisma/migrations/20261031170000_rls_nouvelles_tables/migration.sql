-- Row-Level Security sur les tables cloisonnées arrivées après 20261031130000 (rôles
-- personnalisables, paie et contrôles de trésorerie). Même politique que les autres :
-- "schoolId" = app_rls_school() ; le mode système passe par le rôle ecole_system (BYPASSRLS).

ALTER TABLE "RoleOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RoleOverride" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "RoleOverride"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

ALTER TABLE "CustomRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomRole" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "CustomRole"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

ALTER TABLE "StaffPayout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffPayout" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StaffPayout"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

ALTER TABLE "PayoutDetailsChange" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayoutDetailsChange" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "PayoutDetailsChange"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

ALTER TABLE "ManualEntryRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManualEntryRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ManualEntryRequest"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

-- Droits des rôles applicatifs sur ces tables, s'ils existent (aussi : prisma/app-role-grants.sql).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ecole_app', 'ecole_system'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON "RoleOverride", "CustomRole", "StaffPayout", "PayoutDetailsChange", "ManualEntryRequest" TO %I', r);
    END IF;
  END LOOP;
END $$;
