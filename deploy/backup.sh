#!/usr/bin/env sh
# Sauvegarde quotidienne de la base (à planifier par cron : 0 2 * * * /opt/ecole/deploy/backup.sh).
# Garde 30 jours de sauvegardes ; copier le dossier vers un stockage externe (S3 compatible).
set -eu
cd "$(dirname "$0")"
mkdir -p backups
file="backups/ecole-$(date +%Y-%m-%d-%H%M).dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$file"
test -s "$file"
find backups -name 'ecole-*.dump' -mtime +30 -delete
echo "Sauvegarde : $file"
