-- Gmail instant new-mail via users.watch → standard Cloud Pub/Sub.
-- Adds the per-account watch/incremental-sync state. Idempotent.
--
-- `gmail_history_id`  — incremental-sync cursor (startHistoryId for history.list),
--                       advanced after each delta sync.
-- `watch_expires_at`  — when the current Gmail watch lapses (watches live ≤7 days);
--                       the renewal worker re-arms before this.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS gmail_history_id BIGINT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS watch_expires_at TIMESTAMPTZ;
