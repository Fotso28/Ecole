#!/bin/sh
# Crée (ou met à jour) le rôle applicatif ecole_app : connexion seule, ni superutilisateur, ni
# BYPASSRLS, ni propriétaire des tables. La Row-Level Security s'applique donc à l'API et au worker.
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
SELECT format('GRANT CONNECT ON DATABASE %I TO ecole_app', current_database()) \gexec
SQL
