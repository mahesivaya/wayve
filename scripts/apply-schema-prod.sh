#!/usr/bin/env bash
# scripts/apply-schema-prod.sh — Reconcile the live prod Postgres schema with
# infra/postgres/init.sql, applying ONLY additive, non-destructive changes.
#
# Why this exists: init.sql is the schema-of-record but only auto-runs on a
# *fresh* Postgres volume (docker-entrypoint-initdb.d). A long-lived prod DB
# therefore drifts behind init.sql as tables/columns are added over time —
# which surfaces as runtime 500s ("relation/column does not exist"). This
# script closes that gap WITHOUT re-running init.sql's seed INSERT/UPDATE
# statements (which would be unsafe on a populated DB).
#
# How it works:
#   1. Spins up a throwaway "shadow" Postgres and applies init.sql to it,
#      letting Postgres itself parse the DDL (robust — no regex guesswork).
#   2. Diffs the shadow's catalog against prod's.
#   3. Emits additive DDL for what prod is missing:
#        - missing TABLES   (via pg_dump --schema-only, incl. their indexes/FKs)
#        - missing COLUMNS  (ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...)
#        - missing INDEXES  (on tables that already exist in prod)
#
# Safe by design:
#   - DRY-RUN by default: prints the diff + the exact SQL and applies nothing.
#   - Pass --apply to execute it against prod, wrapped in ONE transaction
#     (ON_ERROR_STOP — any failure rolls the whole thing back).
#   - Only ever ADDs objects. Never drops, never alters a type, never touches
#     a row. CONSTRAINT and column-default differences are REPORTED for manual
#     review, never auto-applied (a new CHECK could reject existing data).
#
# Run it on the EC2 host (where docker + the prod container live):
#   ./scripts/apply-schema-prod.sh            # dry run — show what's missing
#   ./scripts/apply-schema-prod.sh --apply    # apply the additive DDL
#
# Overridable via env: PROD_CONTAINER, PROD_USER, PROD_DB, PG_IMAGE, INIT_SQL.
set -euo pipefail

PROD_CONTAINER="${PROD_CONTAINER:-rwayve_postgres_prod}"
PROD_USER="${PROD_USER:-rwayve}"
PROD_DB="${PROD_DB:-rwayve_prod}"
PG_IMAGE="${PG_IMAGE:-postgres:15}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
INIT_SQL="${INIT_SQL:-$SCRIPT_DIR/../infra/postgres/init.sql}"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ -f "$INIT_SQL" ] || { echo "ERROR: init.sql not found at $INIT_SQL" >&2; exit 1; }
docker ps --format '{{.Names}}' | grep -qx "$PROD_CONTAINER" \
  || { echo "ERROR: prod container '$PROD_CONTAINER' is not running" >&2; exit 1; }

WORK="$(mktemp -d)"
SHADOW="schema_shadow_$$"
cleanup() {
  docker rm -f "$SHADOW" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# psql helpers — -tAqX = tuples-only, unaligned, quiet, no .psqlrc. No -i: these
# run a -c query and need no stdin (and -i would steal stdin when the script
# itself is fed over a pipe).
sps() { docker exec "$SHADOW" psql -tAqX -U postgres -d "$PROD_DB" -c "$1"; }
spd() { docker exec "$PROD_CONTAINER" psql -tAqX -U "$PROD_USER" -d "$PROD_DB" -c "$1"; }

echo "==> Starting shadow Postgres ($PG_IMAGE)…"
docker run -d --name "$SHADOW" -e POSTGRES_PASSWORD=shadow -e POSTGRES_DB="$PROD_DB" "$PG_IMAGE" >/dev/null
for i in $(seq 1 60); do
  docker exec "$SHADOW" pg_isready -U postgres -d "$PROD_DB" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 60 ] && { echo "ERROR: shadow Postgres never became ready" >&2; exit 1; }
done

echo "==> Applying init.sql to shadow…"
if ! docker exec -i "$SHADOW" psql -v ON_ERROR_STOP=1 -U postgres -d "$PROD_DB" >"$WORK/init.log" 2>&1 < "$INIT_SQL"; then
  echo "ERROR: init.sql failed to apply to the shadow DB — fix init.sql first:" >&2
  tail -20 "$WORK/init.log" >&2
  exit 1
fi

echo "==> Diffing shadow schema against prod ($PROD_CONTAINER:$PROD_DB)…"

# ── 1. Missing TABLES ────────────────────────────────────────────────
TBL_Q="SELECT tablename FROM pg_tables WHERE schemaname='public'"
sps "$TBL_Q" | sort > "$WORK/shadow_tables"
spd "$TBL_Q" | sort > "$WORK/prod_tables"
comm -23 "$WORK/shadow_tables" "$WORK/prod_tables" > "$WORK/missing_tables.list"

: > "$WORK/01_tables.sql"
if [ -s "$WORK/missing_tables.list" ]; then
  DUMP_ARGS=()
  while read -r t; do [ -n "$t" ] && DUMP_ARGS+=( -t "public.$t" ); done < "$WORK/missing_tables.list"
  docker exec "$SHADOW" pg_dump -U postgres -d "$PROD_DB" \
    --schema-only --no-owner --no-privileges --no-comments "${DUMP_ARGS[@]}" \
    | grep -vE '^(SET |SELECT pg_catalog|--|$)' > "$WORK/01_tables.sql" || true
fi

# ── 2. Missing COLUMNS on tables that already exist in prod ───────────
# Generated from the shadow catalog (accurate type/null/default), keyed by
# table<TAB>column so we can filter to columns prod is missing.
COL_KEY_Q="
SELECT c.relname||E'\t'||a.attname
FROM pg_attribute a
JOIN pg_class c ON c.oid=a.attrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped"
spd "$COL_KEY_Q" > "$WORK/prod_cols"

SHADOW_COL_DDL_Q="
SELECT c.relname||E'\t'||a.attname||E'\t'||
  'ALTER TABLE '||quote_ident(c.relname)||' ADD COLUMN IF NOT EXISTS '||
  quote_ident(a.attname)||' '||format_type(a.atttypid,a.atttypmod)||
  CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END||
  COALESCE(' DEFAULT '||pg_get_expr(d.adbin,d.adrelid),'')||';'
FROM pg_attribute a
JOIN pg_class c ON c.oid=a.attrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
ORDER BY 1, a.attnum"
sps "$SHADOW_COL_DDL_Q" > "$WORK/shadow_cols"

# Keep a column's DDL only when: its table exists in prod (common table) AND
# the exact (table,column) is absent in prod. Columns whose default calls
# nextval() reference a shadow-only sequence — route those to manual review.
awk -F'\t' '
  FILENAME==PT { ptab[$1]=1; next }
  FILENAME==PC { pcol[$1 FS $2]=1; next }
  {
    if (($1 in ptab) && !(($1 FS $2) in pcol)) {
      if ($3 ~ /nextval\(/) print $1"."$2" -> "$3 > MANUAL;
      else print $3;
    }
  }
' PT="$WORK/prod_tables" PC="$WORK/prod_cols" MANUAL="$WORK/manual_cols.txt" \
  "$WORK/prod_tables" "$WORK/prod_cols" "$WORK/shadow_cols" > "$WORK/02_columns.sql"

# ── 3. Missing INDEXES on tables that already exist in prod ───────────
IDX_Q="SELECT tablename||E'\t'||indexname||E'\t'||indexdef FROM pg_indexes WHERE schemaname='public'"
sps "$IDX_Q" > "$WORK/shadow_idx"
spd "SELECT indexname FROM pg_indexes WHERE schemaname='public'" | sort > "$WORK/prod_idx_names"

awk -F'\t' '
  FILENAME==PT  { ptab[$1]=1; next }
  FILENAME==PIN { pidx[$1]=1; next }
  { if (($1 in ptab) && !($2 in pidx)) print $3";" }
' PT="$WORK/prod_tables" PIN="$WORK/prod_idx_names" \
  "$WORK/prod_tables" "$WORK/prod_idx_names" "$WORK/shadow_idx" \
  | sed -E 's/^CREATE (UNIQUE )?INDEX /CREATE \1INDEX IF NOT EXISTS /' > "$WORK/03_indexes.sql"

# ── 4. CHECK-constraint drift (REPORT ONLY — never auto-applied) ──────
CON_Q="
SELECT c.conname||E'\t'||rel.relname||E'\t'||pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class rel ON rel.oid=c.conrelid
JOIN pg_namespace n ON n.oid=rel.relnamespace
WHERE n.nspname='public' AND c.contype='c'"
sps "$CON_Q" | sort > "$WORK/shadow_cons"
spd "$CON_Q" | sort > "$WORK/prod_cons"
# constraints (by full definition) present in shadow but not prod, limited to
# tables that already exist in prod (new tables bring their own constraints).
comm -23 "$WORK/shadow_cons" "$WORK/prod_cons" | awk -F'\t' '
  FILENAME==PT { ptab[$1]=1; next }
  { if ($2 in ptab) print "  - "$2": "$3" (constraint "$1")" }
' PT="$WORK/prod_tables" "$WORK/prod_tables" /dev/stdin > "$WORK/constraint_warnings.txt" || true

# ── Report ───────────────────────────────────────────────────────────
# grep -c prints "0" AND exits 1 on no match; `|| true` keeps the single "0"
# without `set -e` aborting (and without a second line from `|| echo 0`).
N_TABLES=$(grep -c '^CREATE TABLE' "$WORK/01_tables.sql" 2>/dev/null || true)
N_COLS=$(grep -c '^ALTER TABLE' "$WORK/02_columns.sql" 2>/dev/null || true)
N_IDX=$(grep -c '^CREATE' "$WORK/03_indexes.sql" 2>/dev/null || true)

echo
echo "──────────────────────────────────────────────────────────"
echo " Schema drift: prod is missing"
echo "   • $N_TABLES table(s)"
echo "   • $N_COLS column(s) on existing tables"
echo "   • $N_IDX index(es) on existing tables"
echo "──────────────────────────────────────────────────────────"

cat "$WORK/01_tables.sql" "$WORK/02_columns.sql" "$WORK/03_indexes.sql" > "$WORK/changes.sql"

if [ -s "$WORK/manual_cols.txt" ]; then
  echo
  echo "⚠  Skipped column(s) with sequence-backed defaults (review by hand):"
  sed 's/^/  - /' "$WORK/manual_cols.txt"
fi
if [ -s "$WORK/constraint_warnings.txt" ]; then
  echo
  echo "⚠  CHECK constraints in init.sql but not in prod (NOT auto-applied —"
  echo "   a new CHECK can reject existing rows; review and apply by hand):"
  cat "$WORK/constraint_warnings.txt"
fi

if [ ! -s "$WORK/changes.sql" ]; then
  echo
  echo "✓ Prod schema is in sync with init.sql (no additive changes needed)."
  exit 0
fi

echo
echo "===== SQL to apply ====="
cat "$WORK/changes.sql"
echo "========================"

if [ "$APPLY" != "1" ]; then
  echo
  echo "Dry run — nothing applied. Re-run with --apply to execute the above."
  exit 0
fi

echo
echo "==> Applying to prod ($PROD_CONTAINER:$PROD_DB) in a single transaction…"
{
  echo "BEGIN;"
  cat "$WORK/changes.sql"
  echo "COMMIT;"
} | docker exec -i "$PROD_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PROD_USER" -d "$PROD_DB"

echo
echo "✓ Applied. Prod schema reconciled with init.sql (additive changes only)."
