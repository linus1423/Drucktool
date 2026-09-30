#!/bin/sh
set -e

# "worker" startet den E-Mail-Versand statt des Webservers.
if [ "$1" = "worker" ]; then
  exec node .output/scripts/mail-worker.mjs
fi

# Datenbankschema aktualisieren und bei Bedarf den ersten Superadmin anlegen.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node .output/scripts/migrate.mjs
  node .output/scripts/seed.mjs
fi

exec node .output/server/index.mjs
