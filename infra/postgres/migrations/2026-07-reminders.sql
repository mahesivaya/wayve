-- ============================================================================
-- Reminders: personal, time-based "remind me at" entries, distinct from
-- meetings and tasks. The client pops a reminder ~1 minute before `remind_at`.
--
-- PRIVATE PER USER, so RLS is user-scoped exactly like `notes`/`tasks`: a row
-- is visible/writable only to its owner (`user_id = app.user_id`) or a
-- privileged path that sets `app.bypass = 'on'`. FORCE is required because the
-- app connects as the table owner (a superuser), which otherwise bypasses RLS.
-- GUCs are set transaction-local by wayve-server/src/db.rs.
--
-- Idempotent + safe to re-run. Apply by hand (init.sql only runs on a fresh
-- volume). Dev:
--   docker exec -i rwayve_postgres_dev psql -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-07-reminders.sql
-- Prod:
--   ssh ... 'docker exec -i rwayve_postgres_prod sh -c \
--     "psql -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d \$POSTGRES_DB"' \
--     < infra/postgres/migrations/2026-07-reminders.sql
--
-- Rollback:  DROP TABLE IF EXISTS reminders;
-- ============================================================================

CREATE TABLE IF NOT EXISTS reminders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT,
    remind_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reminders_user_time ON reminders(user_id, remind_at);

-- Write access for the restricted role that RLS-scoped transactions run as.
-- (SELECT is already covered by the schema-wide grant to wayve_app.)
GRANT INSERT, UPDATE, DELETE ON reminders TO wayve_app;

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reminders_rls ON reminders;
CREATE POLICY reminders_rls ON reminders
    USING (
        current_setting('app.bypass', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::int
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::int
    );
