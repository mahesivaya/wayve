#!/usr/bin/env bash
# ============================================================
# Weekly future-incompatibility check.
# ------------------------------------------------------------
# Runs `cargo check --workspace` in `backend/`, then asks cargo for
# its consolidated future-incompatibility report. If there are any
# warnings, writes the full report to a timestamped log file under
# `backend/logs/future-incompat/` so a history is preserved.
#
# Designed for `cron`: emits nothing on stdout when the workspace is
# clean (so cron doesn't email a non-issue every week), and emits a
# loud summary + non-zero exit when there is something to look at.
#
# Idempotent. Safe to run by hand any time:
#   ./scripts/check_future_incompat.sh
# ============================================================
set -euo pipefail

# Absolute paths — cron runs with a minimal PATH and no working
# directory of its own. Resolving here makes the script portable
# between manual runs and cron triggers.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
REPORT_DIR="$BACKEND_DIR/logs/future-incompat"
TODAY="$(date +%Y-%m-%d)"
REPORT_FILE="$REPORT_DIR/$TODAY.txt"

mkdir -p "$REPORT_DIR"

cd "$BACKEND_DIR"

# Step 1: build silently. We only care whether the build emits a
# future-incompat warning summary, not the actual binary output.
# `--message-format=short` keeps the stderr noise manageable.
BUILD_OUT="$(cargo check --workspace --message-format=short 2>&1 || true)"

# Step 2: did cargo emit a future-incompat summary? It always ends
# with `cargo report future-incompatibilities --id N` instructions
# when there are warnings; absence of that line means the workspace
# is clean.
if ! grep -q "future-incompatibilities" <<<"$BUILD_OUT"; then
  # Clean. Cron stays silent (no stdout) so weekly mail traffic is
  # zero on the happy path.
  exit 0
fi

# Step 3: extract the report id cargo just printed and pull the
# detailed report. The id is always `--id N` somewhere in the build
# output; grab the first one.
REPORT_ID="$(grep -oE -- '--id [0-9]+' <<<"$BUILD_OUT" | head -1 | awk '{print $2}')"

if [[ -z "$REPORT_ID" ]]; then
  echo "future-incompat check: warning summary detected but no --id found" >&2
  echo "$BUILD_OUT" | tail -60
  exit 2
fi

cargo report future-incompatibilities --id "$REPORT_ID" >"$REPORT_FILE" 2>&1

# Step 4: loud summary to stdout/stderr so cron mails the owner.
{
  echo "================================================================"
  echo "Future-incompatibility warnings detected in the backend workspace"
  echo "Run date : $TODAY"
  echo "Report   : $REPORT_FILE"
  echo "================================================================"
  # Pull the list of affected packages — these are the lines that
  # start with `> ` and name a crate version.
  echo "Affected packages:"
  grep -E "^The package .* currently triggers" "$REPORT_FILE" \
    | sed 's/^/  - /' \
    || echo "  (see report file for details)"
  echo "----------------------------------------------------------------"
  echo "Resolve by upgrading the affected crate(s) — usually:"
  echo "  cd backend && cargo update"
  echo "Or pin a newer version explicitly in Cargo.toml."
  echo "================================================================"
} >&2

# Non-zero exit so cron / CI mark this as failure.
exit 1
