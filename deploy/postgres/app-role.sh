#!/bin/sh
# Crée (ou met à jour) les rôles de l'application :
#   ecole_app    : connexion de l'API et du worker ; ni superutilisateur, ni BYPASSRLS, ni
#                  propriétaire des tables. La Row-Level Security s'applique.
#   ecole_system : sans connexion, BYPASSRLS ; accordé à ecole_app, qui le prend dans une
#                  transaction (SET LOCAL ROLE) pour le seul mode système de runAsSystem.
#
# - Premier démarrage : exécuté automatiquement par l'image postgres (docker-entrypoint-initdb.d).
# - Installation existante : docker compose exec postgres sh /docker-entrypoint-initdb.d/10-app-role.sh
#   (puis redémarrer « migrate », qui rejoue les droits : prisma/app-role-grants.sql).
set -eu
: "${POSTGRES_APP_PASSWORD:?définir POSTGRES_APP_PASSWORD}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v pw="$POSTGRES_APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE ecole_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_app') \gexec
SELECT format('ALTER ROLE ecole_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'pw') \gexec
SELECT 'CREATE ROLE ecole_system WITH NOLOGIN BYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_system') \gexec
ALTER ROLE ecole_system WITH NOLOGIN BYPASSRLS;
GRANT ecole_system TO ecole_app WITH INHERIT FALSE, SET TRUE;
SELECT format('GRANT CONNECT ON DATABASE %I TO ecole_app', current_database()) \gexec
SQL
