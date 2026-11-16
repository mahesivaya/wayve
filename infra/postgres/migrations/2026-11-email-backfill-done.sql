-- Per-account history backfills that found nothing left to do, as
-- {kind: finished-at}. The sync worker skips a finished kind (no provider call,
-- no scan of the account's mail) and re-checks it a day later. Same statement
-- as in init.sql.
--
-- Idempotent.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS backfill_done JSONB NOT NULL DEFAULT '{}';
