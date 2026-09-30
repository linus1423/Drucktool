#!/bin/sh
set -e

# Datenbankschema aktualisieren und bei Bedarf den ersten Superadmin anlegen.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node .output/scripts/migrate.mjs
  node .output/scripts/seed.mjs
fi

exec node .output/server/index.mjs
