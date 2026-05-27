#!/usr/bin/env bash
# ============================================================
# Seed personal / platform / organization test users.
# ------------------------------------------------------------
# Applies infra/postgres/seed_users.sql against the local dev
# Postgres container by default. Idempotent — re-running resets
# each account to a known state.
#
# Accounts created (password is $SEED_PASSWORD, default "Mahesh"):
#
#   Personal      → alice@personal.test, bob@personal.test,
#                   carol@personal.test
#                   recovery_mode='full' — first UI login shows the
#                   24-word mnemonic (RecoverySeedModal). Capture
#                   the words then; the server never sees them.
#
#   Platform      → owner@platform.com … guest@platform.com
#                   (also superadmin@platform.com)
#                   recovery_mode='basic' — password-only login,
#                   no mnemonic prompt.
#
#   Organization  → owner@acme.com … guest@acme.com in org "Acme"
#                   recovery_mode='basic' — same as platform.
#
# Usage:
#   scripts/seed_users.sh
#   SEED_PASSWORD=secret scripts/seed_users.sh
#   DATABASE_URL=postgres://user:pass@host:5432/db scripts/seed_users.sh
#
# Without DATABASE_URL it runs against the local dev Postgres
# container (override with PGCONTAINER / PGUSER / PGDATABASE).
# ============================================================
set -euo pipefail

SEED_PASSWORD="${SEED_PASSWORD:-Mahesh}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/../infra/postgres/seed_users.sql"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "error: seed SQL not found at $SQL_FILE" >&2
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "Seeding test users via DATABASE_URL…"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v seed_password="$SEED_PASSWORD" -f "$SQL_FILE"
else
  PGCONTAINER="${PGCONTAINER:-rwayve_postgres_dev}"
  PGUSER="${PGUSER:-wayve_user}"
  PGDATABASE="${PGDATABASE:-wayve_dev}"
  echo "Seeding test users via docker container '$PGCONTAINER' ($PGUSER/$PGDATABASE)…"
  docker exec -i "$PGCONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" \
    -v ON_ERROR_STOP=1 -v seed_password="$SEED_PASSWORD" < "$SQL_FILE"
fi

echo
echo "✅ Done. Password for every account: ${SEED_PASSWORD}"
echo
echo "   Personal      : alice@personal.test, bob@personal.test, carol@personal.test"
echo "                   → first UI login generates a 24-word mnemonic"
echo "                     (save it from the RecoverySeedModal at that moment)"
echo
echo "   Platform      : owner@platform.com … guest@platform.com (+ superadmin@platform.com)"
echo "                   → password-only login, no mnemonic"
echo
echo "   Organization  : owner@acme.com … guest@acme.com  (org \"Acme\")"
echo "                   → password-only login, no mnemonic"
