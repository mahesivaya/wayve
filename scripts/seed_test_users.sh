#!/usr/bin/env bash
# ============================================================
# Seed ALL manual-testing users documented in test-users.txt.
# ------------------------------------------------------------
# Applies both seed SQL files in one run so every account comes up
# together with the same password:
#   infra/postgres/seed_rbac.sql     — 18 RBAC users (platform + org "Acme")
#   infra/postgres/seed_personal.sql —  5 personal users (@personal.com)
#
# Every account uses the same password ($SEED_PASSWORD, default "Test@1234"
# to match test-users.txt). Idempotent — re-running resets all 23 accounts.
# Requires the schema (infra/postgres/init.sql) to already be applied.
#
# Usage:
#   scripts/seed_test_users.sh
#   SEED_PASSWORD=secret123 scripts/seed_test_users.sh
#   DATABASE_URL=postgres://user:pass@host:5432/db scripts/seed_test_users.sh
#
# Without DATABASE_URL it runs against the local dev Postgres container
# (override with PGCONTAINER / PGUSER / PGDATABASE).
# ============================================================
set -euo pipefail

SEED_PASSWORD="${SEED_PASSWORD:-Test@1234}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILES=(
  "$SCRIPT_DIR/../infra/postgres/seed_rbac.sql"
  "$SCRIPT_DIR/../infra/postgres/seed_personal.sql"
)

for f in "${SQL_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "error: seed SQL not found at $f" >&2
    exit 1
  fi
done

run_sql() {
  local sql_file="$1"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v seed_password="$SEED_PASSWORD" -f "$sql_file"
  else
    local PGCONTAINER="${PGCONTAINER:-rwayve_postgres_dev}"
    local PGUSER="${PGUSER:-wayve_user}"
    local PGDATABASE="${PGDATABASE:-wayve_dev}"
    docker exec -i "$PGCONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" \
      -v ON_ERROR_STOP=1 -v seed_password="$SEED_PASSWORD" < "$sql_file"
  fi
}

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Seeding all test users via DATABASE_URL…"
else
  echo "Seeding all test users via docker container '${PGCONTAINER:-rwayve_postgres_dev}'…"
fi

for f in "${SQL_FILES[@]}"; do
  run_sql "$f"
done

echo
echo "✅ Done. 23 test users seeded — password for all: ${SEED_PASSWORD}"
echo "   Platform staff : owner@platform.com … guest@platform.com (superadmin@platform.com)"
echo "   Org \"Acme\"      : owner@acme.com … guest@acme.com (superadmin@acme.com)"
echo "   Personal       : alice@personal.com bob@ carol@ dave@ erin@personal.com"
