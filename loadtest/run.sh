#!/usr/bin/env bash
# Lance un scénario k6 contre la pile Docker locale et relève les ressources des conteneurs.
#   loadtest/run.sh bulletins|notes|rentree|portail [-e VAR=valeur ...]
# Résultats dans loadtest/results/ : résumé k6 (JSON et texte) et relevé docker stats (CSV).
set -euo pipefail
cd "$(dirname "$0")"
scenario=$1
shift
FIXTURES=${FIXTURES:-$PWD/data/loadtest-fixtures.json}
[ -f "$FIXTURES" ] || { echo "Fichier de données introuvable : $FIXTURES (voir docs/charge.md)" >&2; exit 1; }
mkdir -p results
chmod 777 results
out="results/$scenario-$(date +%Y%m%d-%H%M%S)"

# Relevé des ressources toutes les 5 s pendant le test.
(
  while :; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' | sed "s/^/$(date +%s),/"
    sleep 5
  done
) >"$out.stats.csv" 2>/dev/null &
stats=$!
trap 'kill $stats 2>/dev/null || true' EXIT

docker run --rm --network host \
  -v "$PWD/k6:/scripts:ro" \
  -v "$(dirname "$FIXTURES"):/data:ro" \
  -v "$PWD/results:/results" \
  -e FIXTURES="/data/$(basename "$FIXTURES")" \
  grafana/k6:0.57.0 run --quiet --summary-export="/$out.json" "$@" "/scripts/$scenario.js" | tee "$out.txt"
kill $stats 2>/dev/null || true
python3 stats.py "$out.stats.csv" | tee -a "$out.txt"
