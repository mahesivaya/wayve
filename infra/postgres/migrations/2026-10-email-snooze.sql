-- ============================================================================
-- Email snooze (Fluxze only), per person.
--
-- `email_snoozes` holds one row per (email, person) snooze. The list reads the
-- caller's own row: while `snoozed_until` is in the future the email is hidden
-- from their inbox views, and it returns on its own when it passes, with
-- nothing scheduled. The row is kept afterwards, so the inbox sorts returned
-- mail at the top by GREATEST(created_at, snoozed_until), as in Gmail. Per
-- person, because a shared inbox's emails are one row for every member: a
-- snooze on the email itself hid it from the whole team.
--
-- TIMESTAMP in UTC, like emails.created_at.
--
-- Replaces the first version of this file, which put `snoozed_until` on
-- `emails`. Either starting point works: any snoozes found there are moved to
-- the email's owner (the mailbox owner, or the recipient of Fluxze mail), then
-- the column and its indexes go.
--
-- Idempotent + safe to re-run. The backend also creates the table on boot
-- (startup::ensure_email_schema); the move from the old column is here only.
-- Dev:
--   docker exec -i rwayve_postgres_dev psql -v ON_ERROR_STOP=1 -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-10-email-snooze.sql
--
-- Rollback:
--   DROP TABLE IF EXISTS email_snoozes;
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS email_snoozes (
    email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snoozed_until TIMESTAMP NOT NULL,
    PRIMARY KEY (email_id, user_id)
);
-- The Snoozed folder: one person's snoozes, by when they come back.
CREATE INDEX IF NOT EXISTS idx_email_snoozes_user ON email_snoozes(user_id, snoozed_until);

-- List reads run as wayve_app (row-level security on emails).
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wayve_app') THEN
        GRANT SELECT ON email_snoozes TO wayve_app;
    END IF;
END $$;

-- Carry over snoozes from the first version's column, onto the email's owner.
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'emails' AND column_name = 'snoozed_until'
    ) THEN
        INSERT INTO email_snoozes (email_id, user_id, snoozed_until)
        SELECT e.id, COALESCE(a.user_id, e.recipient_user_id), e.snoozed_until
        FROM emails e
        LEFT JOIN email_accounts a ON a.id = e.account_id
        WHERE e.snoozed_until IS NOT NULL
          AND COALESCE(a.user_id, e.recipient_user_id) IS NOT NULL
        ON CONFLICT (email_id, user_id) DO NOTHING;
    END IF;
END $$;

COMMIT;

-- The first version's indexes, dropped without blocking writes to emails, then
-- its column (a metadata-only change, so a brief lock).
DROP INDEX CONCURRENTLY IF EXISTS idx_emails_account_sort;
DROP INDEX CONCURRENTLY IF EXISTS idx_emails_snoozed;
ALTER TABLE emails DROP COLUMN IF EXISTS snoozed_until;
