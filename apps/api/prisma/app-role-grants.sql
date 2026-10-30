-- Droits des rôles applicatifs, à jouer avec le rôle propriétaire après les migrations.
-- Idempotent : le service « migrate » le rejoue à chaque déploiement, les tests aussi.
-- Création des rôles : deploy/postgres/app-role.sh.
--   ecole_app    : connexion de l'API et du worker ; ni propriétaire, ni BYPASSRLS.
--   ecole_system : sans connexion, BYPASSRLS, accordé à ecole_app ; pris dans une transaction
--                  (SET LOCAL ROLE) par runAsSystem sans établissement.
GRANT USAGE ON SCHEMA public TO ecole_app, ecole_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ecole_app, ecole_system;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ecole_app, ecole_system;
REVOKE ALL ON "_prisma_migrations" FROM ecole_app, ecole_system;
-- Journal d'audit en ajout seul, y compris en mode système.
REVOKE UPDATE, DELETE ON "AuditLog" FROM ecole_app, ecole_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecole_app, ecole_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ecole_app, ecole_system;
GRANT ecole_system TO ecole_app WITH INHERIT FALSE, SET TRUE;
