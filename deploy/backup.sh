#!/usr/bin/env sh
# Sauvegarde quotidienne de la base (à planifier par cron : 0 2 * * * /opt/ecole/deploy/backup.sh).
# Garde 30 jours de sauvegardes ; copier le dossier vers un stockage externe (S3 compatible).
# L'état (réussite ou échec) est écrit dans backup-status/last-status.json, lu par le worker
# qui alerte l'équipe technique en cas d'échec ou de sauvegarde trop ancienne.
set -eu
cd "$(dirname "$0")"
mkdir -p backups backup-status
status_file=backup-status/last-status.json
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
last_success=$(sed -n 's/.*"lastSuccess":"\([^"]*\)".*/\1/p' "$status_file" 2>/dev/null || true)
fail() {
  printf '{"status":"failed","at":"%s","lastSuccess":"%s","message":"%s"}\n' "$(now)" "$last_success" "$1" > "$status_file"
  echo "Sauvegarde en échec : $1" >&2
  exit 1
}
file="backups/ecole-$(date +%Y-%m-%d-%H%M).dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$file" || fail "pg_dump a échoué"
test -s "$file" || fail "fichier de sauvegarde vide"
find backups -name 'ecole-*.dump' -mtime +30 -delete
done_at=$(now)
printf '{"status":"ok","at":"%s","lastSuccess":"%s","file":"%s"}\n' "$done_at" "$done_at" "$file" > "$status_file"
echo "Sauvegarde : $file"
