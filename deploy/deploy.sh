#!/usr/bin/env bash
# Déploiement d'une version sur le serveur, avec retour automatique à la version précédente.
#
#   deploy.sh [--tag SHA --prefix ghcr.io/organisation] [--bundle fichiers.tgz] [--no-backup]
#   deploy.sh --rollback        revient à la version d'avant le dernier déploiement réussi
#
# Étapes : sauvegarde de la base, mise à jour des fichiers de déploiement (--bundle),
# épinglage des images sur la version (--tag), docker compose pull && docker compose up -d,
# contrôle de /api/health et du site. En cas d'échec à n'importe quelle étape : fichiers,
# .env et images précédents sont rétablis, puis la santé est contrôlée à nouveau.
# Lancé par le workflow GitHub « Déploiement », ou à la main depuis le dossier deploy/.
set -euo pipefail

DIR=${DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}
cd "$DIR"
STATE=.deploy
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
TAG='' PREFIX='' BUNDLE='' BACKUP=1 MODE=deploy

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=$2; shift 2 ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --bundle) BUNDLE=$2; shift 2 ;;
    --no-backup) BACKUP=0; shift ;;
    --rollback) MODE=rollback; shift ;;
    *) echo "Option inconnue : $1" >&2; exit 64 ;;
  esac
done

log() { echo "[déploiement $(date -u +%H:%M:%S)] $*"; }
die() { log "ERREUR : $*" >&2; exit 1; }

[ -f .env ] || die "fichier $DIR/.env introuvable"
if [ -n "$TAG" ] && [ -z "$PREFIX" ]; then die "--tag exige --prefix (ex. ghcr.io/organisation)"; fi
if [ -n "$TAG" ] && ! [[ "$TAG" =~ ^[A-Za-z0-9._-]+$ ]]; then die "version invalide : $TAG"; fi
mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || die "un déploiement est déjà en cours"

env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
env_set() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >>.env
  fi
}
image_id() {
  local cid
  cid=$(docker compose ps -q "$1" 2>/dev/null | head -n1)
  [ -n "$cid" ] && docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true
}

# Contrôle de santé : /api/health (base joignable) et page de connexion, à travers Nginx.
probe() {
  local domain mode
  domain=$(env_get DOMAIN)
  domain=${domain:-localhost}
  mode=$(env_get NGINX_MODE)
  if [ -n "${HEALTH_URL:-}" ]; then
    curl -fsS --max-time 5 "$HEALTH_URL" | grep -q '"ok"' || return 1
    return 0
  fi
  if [ "$mode" = https ]; then
    local opts=(-fsS --max-time 5 -k --resolve "$domain:443:127.0.0.1")
    curl "${opts[@]}" "https://$domain/api/health" | grep -q '"ok"' &&
      curl "${opts[@]}" -o /dev/null "https://$domain/connexion"
  else
    local opts=(-fsS --max-time 5 -H "Host: $domain")
    curl "${opts[@]}" http://127.0.0.1/api/health | grep -q '"ok"' &&
      curl "${opts[@]}" -o /dev/null http://127.0.0.1/connexion
  fi
}
# Nginx résout les noms des conteneurs au chargement : rechargement après recréation de l'API
# et du site, sinon il garde leurs anciennes adresses (erreurs 502).
reload_nginx() {
  docker compose exec -T nginx nginx -s reload >/dev/null 2>&1 || docker compose restart nginx
}
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    if probe >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

# Rétablit l'état enregistré dans $STATE/previous.env (fichiers, .env, images).
restore() {
  # shellcheck disable=SC1091
  . "$STATE/previous.env"
  log "Retour à la version précédente (${PREV_API_REF:-?})"
  if [ -f "$STATE/files.previous.tgz" ]; then tar -xzf "$STATE/files.previous.tgz"; fi
  cp "$STATE/env.previous" .env
  # Les références (ex. :latest) pointent de nouveau vers les images qui tournaient avant.
  if [ -n "${PREV_API_ID:-}" ]; then docker tag "$PREV_API_ID" "$PREV_API_REF"; fi
  if [ -n "${PREV_WEB_ID:-}" ]; then docker tag "$PREV_WEB_ID" "$PREV_WEB_REF"; fi
  docker compose up -d
  reload_nginx
  if wait_healthy; then
    log "Version précédente rétablie et en bonne santé"
    echo "$(date -u +%FT%TZ) rollback ${PREV_API_REF:-?}" >>"$STATE/history.log"
    return 0
  fi
  log "ÉCHEC : la version précédente ne répond pas non plus, intervention manuelle requise" >&2
  docker compose ps >&2 || true
  return 2
}

if [ "$MODE" = rollback ]; then
  [ -f "$STATE/previous.env" ] || die "aucun déploiement précédent enregistré"
  restore
  exit $?
fi

# 1. État actuel, pour le retour arrière.
api_ref=$(env_get API_IMAGE)
web_ref=$(env_get WEB_IMAGE)
cp .env "$STATE/env.previous"
{
  printf 'PREV_API_REF=%q\n' "${api_ref:-ecole-api:latest}"
  printf 'PREV_WEB_REF=%q\n' "${web_ref:-ecole-web:latest}"
  printf 'PREV_API_ID=%q\n' "$(image_id api)"
  printf 'PREV_WEB_ID=%q\n' "$(image_id web)"
} >"$STATE/previous.env"
rm -f "$STATE/files.previous.tgz"
# Étiquettes locales : les images précédentes survivent au nettoyage, pour --rollback.
# shellcheck disable=SC1091
. "$STATE/previous.env"
if [ -n "$PREV_API_ID" ]; then docker tag "$PREV_API_ID" ecole-api:previous; fi
if [ -n "$PREV_WEB_ID" ]; then docker tag "$PREV_WEB_ID" ecole-web:previous; fi

fail() {
  log "ÉCHEC : $*" >&2
  docker compose ps >&2 || true
  docker compose logs --tail=50 migrate api web >&2 || true
  echo "$(date -u +%FT%TZ) failed $(env_get API_IMAGE) : $*" >>"$STATE/history.log"
  restore || exit 2
  exit 1
}

# 2. Sauvegarde avant migration (si la base tourne déjà).
if [ "$BACKUP" = 1 ] && [ -n "$(docker compose ps -q postgres 2>/dev/null)" ]; then
  log "Sauvegarde de la base"
  ./backup.sh || die "sauvegarde impossible : déploiement interrompu"
fi

# 3. Fichiers de déploiement (compose, Nginx, scripts) de la nouvelle version.
if [ -n "$BUNDLE" ]; then
  log "Mise à jour des fichiers de déploiement"
  mapfile -t files < <(tar -tzf "$BUNDLE" | grep -v '/$')
  existing=()
  for f in "${files[@]}"; do [ -e "$f" ] && existing+=("$f"); done
  if [ ${#existing[@]} -gt 0 ]; then tar -czf "$STATE/files.previous.tgz" "${existing[@]}"; fi
  tar -xzf "$BUNDLE" || fail "archive des fichiers de déploiement illisible"
fi

# 4. Version à déployer.
if [ -n "$TAG" ]; then
  env_set API_IMAGE "$PREFIX/ecole-api:$TAG"
  env_set WEB_IMAGE "$PREFIX/ecole-web:$TAG"
fi
log "Déploiement de $(env_get API_IMAGE) et $(env_get WEB_IMAGE)"

# 5. docker compose pull && docker compose up -d (les migrations passent avant l'API).
docker compose pull --quiet || fail "téléchargement des images impossible"
docker compose up -d || fail "démarrage impossible (migration en échec ?)"
reload_nginx

# 6. Contrôle de santé.
log "Contrôle de santé (jusqu'à ${HEALTH_TIMEOUT} s)"
wait_healthy || fail "contrôle de santé en échec après ${HEALTH_TIMEOUT} s"

echo "$(date -u +%FT%TZ) ok $(env_get API_IMAGE)" >>"$STATE/history.log"
docker image prune -f >/dev/null 2>&1 || true
log "Déploiement réussi"
