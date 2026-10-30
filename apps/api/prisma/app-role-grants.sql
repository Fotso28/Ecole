-- Droits du rôle applicatif ecole_app (ni propriétaire, ni BYPASSRLS), à jouer avec le rôle
-- propriétaire après les migrations. Idempotent : le service « migrate » le rejoue à chaque
-- déploiement, les tests aussi. La création du rôle lui-même : deploy/postgres/app-role.sh.
GRANT USAGE ON SCHEMA public TO ecole_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ecole_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ecole_app;
REVOKE ALL ON "_prisma_migrations" FROM ecole_app;
REVOKE UPDATE, DELETE ON "AuditLog" FROM ecole_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecole_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ecole_app;
