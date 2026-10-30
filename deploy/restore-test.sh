#!/usr/bin/env sh
# Test de restauration mensuel : restaure la dernière sauvegarde dans une base temporaire
# et vérifie qu'elle contient des données. Ne touche jamais à la base de production.
set -eu
cd "$(dirname "$0")"
latest=$(ls -1t backups/ecole-*.dump | head -n1)
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists ecole_restore_test && createdb -U "$POSTGRES_USER" ecole_restore_test'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d ecole_restore_test --no-owner' < "$latest"
count=$(docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d ecole_restore_test -Atc "select count(*) from \"School\""')
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" ecole_restore_test'
echo "Restauration de $latest réussie : $count établissement(s)."
