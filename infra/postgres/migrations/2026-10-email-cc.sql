-- ============================================================================
-- The Cc header of synced mail, for Reply all.
--
-- Stored encrypted like sender/receiver (`cc_iv` + `cc_encrypted`). NULL means
-- not yet known: mail synced before this column existed. email/cc_backfill.rs
-- fills those in from Gmail a batch per sync tick. An empty pair means the
-- message had no Cc.
--
-- Idempotent + safe to re-run. The backend also applies this on boot
-- (startup::ensure_email_schema), so applying by hand is optional. Dev:
--   docker exec -i rwayve_postgres_dev psql -v ON_ERROR_STOP=1 -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-10-email-cc.sql
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_emails_cc_unknown;
--   ALTER TABLE emails DROP COLUMN IF EXISTS cc_encrypted;
--   ALTER TABLE emails DROP COLUMN IF EXISTS cc_iv;
-- ============================================================================

BEGIN;

ALTER TABLE emails ADD COLUMN IF NOT EXISTS cc_iv TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS cc_encrypted TEXT;
CREATE INDEX IF NOT EXISTS idx_emails_cc_unknown ON emails(account_id, created_at DESC)
    WHERE cc_encrypted IS NULL;

COMMIT;
