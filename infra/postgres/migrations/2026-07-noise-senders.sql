-- ============================================================================
-- Noise senders: per-user list of sender addresses the user marked as "noise".
-- The email `noise` folder (email/repo.rs) includes mail from these senders and
-- the inbox excludes them, so marking one address moves all of that sender's
-- mail — current and future — into Noise.
--
-- PRIVATE PER USER, so RLS is user-scoped like `notes`/`reminders`. Idempotent
-- + safe to re-run. Apply by hand (init.sql only runs on a fresh volume). Prod:
--   ssh ... 'docker exec -i rwayve_postgres_prod sh -c \
--     "psql -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d \$POSTGRES_DB"' \
--     < infra/postgres/migrations/2026-07-noise-senders.sql
--
-- Rollback:  DROP TABLE IF EXISTS noise_senders;
-- ============================================================================

CREATE TABLE IF NOT EXISTS noise_senders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_email TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, sender_email)
);
CREATE INDEX IF NOT EXISTS idx_noise_senders_user ON noise_senders(user_id);

GRANT INSERT, UPDATE, DELETE ON noise_senders TO wayve_app;

ALTER TABLE noise_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE noise_senders FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS noise_senders_rls ON noise_senders;
CREATE POLICY noise_senders_rls ON noise_senders
    USING (
        current_setting('app.bypass', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::int
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::int
    );
