-- ============================================================================
-- Email snooze (Fluxze only).
--
-- `snoozed_until` hides a message from the inbox views until it passes; it then
-- returns on its own, with nothing scheduled. The list sorts on
-- GREATEST(created_at, snoozed_until), so returned mail sits at the top of the
-- inbox; `idx_emails_account_sort` keeps that sort index-backed. TIMESTAMP in
-- UTC, like created_at: mixing in a TIMESTAMPTZ makes the expression
-- unindexable (the conversion depends on the session time zone).
--
-- Idempotent + safe to re-run. The backend also applies this on boot
-- (startup::ensure_email_schema), but there the indexes are built without
-- CONCURRENTLY, which blocks writes to emails while they build: on prod, apply
-- this file before deploying (as the runbook does), so boot finds them made. Dev:
--   docker exec -i rwayve_postgres_dev psql -v ON_ERROR_STOP=1 -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-10-email-snooze.sql
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_emails_account_sort;
--   DROP INDEX IF EXISTS idx_emails_snoozed;
--   ALTER TABLE emails DROP COLUMN IF EXISTS snoozed_until;
-- ============================================================================

-- The column goes in a transaction; the indexes are built CONCURRENTLY, which
-- cannot run inside one, so mail sync keeps writing while they build on a large
-- emails table. If a concurrent build is interrupted it leaves an INVALID index
-- that IF NOT EXISTS would then skip: drop it and re-run this file.
BEGIN;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP;
COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_emails_snoozed
    ON emails(account_id, snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_emails_account_sort
    ON emails(account_id, (GREATEST(created_at, snoozed_until)) DESC, id DESC);
