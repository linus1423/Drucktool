#!/usr/bin/env bash
# Smoke-Test für das Docker-Image: startet die Anwendung mit docker compose, wartet auf /api/health
# und meldet sich im Browser mit dem Superadmin an.
#
# Lokal:  docker compose build && scripts/smoke/smoke-test.sh
# Variablen: SMOKE_IMAGE (Standard drucktool:local), SMOKE_PORT (Standard 3200),
#            PLAYWRIGHT_VERSION (Version des Images mcr.microsoft.com/playwright)
set -euo pipefail

cd "$(dirname "$0")/../.."

export APP_IMAGE="${SMOKE_IMAGE:-drucktool:local}"
export APP_PORT="${SMOKE_PORT:-3200}"
export APP_URL="http://127.0.0.1:${APP_PORT}"
export POSTGRES_PASSWORD="smoke-test-$(date +%s)"
export SUPERADMIN_EMAIL='smoke@example.com'
export SUPERADMIN_PASSWORD='smoke-test-passwort-123'
playwright_version="${PLAYWRIGHT_VERSION:-1.63.0}"
compose=(docker compose -p drucktool-smoke -f docker-compose.yml -f scripts/smoke/docker-compose.smoke.yml)

aufraeumen() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo '--- Logs der Container ---'
    "${compose[@]}" logs --no-color --tail 200 || true
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap aufraeumen EXIT

echo "Starte ${APP_IMAGE} auf Port ${APP_PORT} …"
"${compose[@]}" up -d --no-build

echo 'Warte auf /api/health …'
for _ in $(seq 1 60); do
  if body=$(curl -fsS "${APP_URL}/api/health" 2>/dev/null); then
    echo "Healthcheck: ${body}"
    break
  fi
  sleep 2
done
curl -fsS "${APP_URL}/api/health" >/dev/null || {
  echo 'Healthcheck schlägt fehl'
  exit 1
}

echo 'Prüfe die Anmeldung mit dem Superadmin im Browser …'
# Hinter einem Firmen-Proxy braucht npm im Container dessen Zertifikat.
extra=()
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  extra+=(-v "${NODE_EXTRA_CA_CERTS}:/smoke/ca.crt:ro" -e NODE_EXTRA_CA_CERTS=/smoke/ca.crt -e HTTPS_PROXY)
fi
docker run --rm --network host --ipc host "${extra[@]}" \
  -e APP_URL -e SUPERADMIN_EMAIL -e SUPERADMIN_PASSWORD \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 -e npm_config_update_notifier=false -e npm_config_fund=false \
  -v "$PWD/scripts/smoke/login.mjs:/smoke/login.mjs:ro" \
  "mcr.microsoft.com/playwright:v${playwright_version}-noble" \
  bash -c "mkdir -p /tmp/smoke && cd /tmp/smoke && npm init -y >/dev/null && npm install --silent playwright@${playwright_version} && cp /smoke/login.mjs . && node login.mjs"

echo 'Smoke-Test bestanden'
