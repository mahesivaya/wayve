#!/usr/bin/env bash
# ============================================================
# Seed RBAC test users — one account per role, in both scopes.
# ------------------------------------------------------------
#   Platform : owner@platform.com superadmin@platform.com admin@platform.com
#              security@platform.com billing@platform.com developer@platform.com
#              support@platform.com member@platform.com guest@platform.com
#   Org Acme : the same locals @acme.com
#
# Every account uses the same password ($SEED_PASSWORD, default "Mahesh").
# Idempotent — re-running resets the seeded accounts to a known state.
# Requires the schema (infra/postgres/init.sql) to already be applied.
#
# Usage:
#   scripts/seed_rbac_users.sh
#   SEED_PASSWORD=secret123 scripts/seed_rbac_users.sh
#   DATABASE_URL=postgres://user:pass@host:5432/db scripts/seed_rbac_users.sh
#
# Without DATABASE_URL it runs against the local dev Postgres container
# (override with PGCONTAINER / PGUSER / PGDATABASE).
# ============================================================
set -euo pipefail

SEED_PASSWORD="${SEED_PASSWORD:-Mahesh}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/../infra/postgres/seed_rbac.sql"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "error: seed SQL not found at $SQL_FILE" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Seeding RBAC test users via DATABASE_URL…"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v seed_password="$SEED_PASSWORD" -f "$SQL_FILE"
else
  PGCONTAINER="${PGCONTAINER:-rwayve_postgres_dev}"
  PGUSER="${PGUSER:-wayve_user}"
  PGDATABASE="${PGDATABASE:-wayve_dev}"
  echo "Seeding RBAC test users via docker container '$PGCONTAINER' ($PGUSER/$PGDATABASE)…"
  docker exec -i "$PGCONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" \
    -v ON_ERROR_STOP=1 -v seed_password="$SEED_PASSWORD" < "$SQL_FILE"
fi

echo
echo "✅ Done. 18 test users seeded — password for all: ${SEED_PASSWORD}"
echo "   Platform staff : owner@platform.com … guest@platform.com (superadmin@platform.com)"
echo "   Org \"Acme\"      : owner@acme.com … guest@acme.com (superadmin@acme.com)"
