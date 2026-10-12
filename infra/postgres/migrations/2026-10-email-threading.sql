-- ============================================================================
-- Email conversation threading (email/threading.rs).
--
-- Adds email_threads + emails.thread_id + email_thread_meta, with RLS mirroring
-- emails. Sync fills them for new mail; a background backfill works through
-- existing Gmail and Outlook mail a batch per sync tick. Until this is applied,
-- the new code logs a warning per email and sync carries on unthreaded.
--
-- Idempotent + safe to re-run. Apply by hand (init.sql only runs on a fresh
-- volume). Dev:
--   docker exec -i rwayve_postgres_dev psql -v ON_ERROR_STOP=1 -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-10-email-threading.sql
-- Prod:
--   ssh ... 'docker exec -i rwayve_postgres_prod sh -c \
--     "psql -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d \$POSTGRES_DB"' \
--     < infra/postgres/migrations/2026-10-email-threading.sql
--
-- Rollback:
--   ALTER TABLE emails DROP COLUMN IF EXISTS thread_id;
--   DROP TABLE IF EXISTS email_thread_meta;
--   DROP TABLE IF EXISTS email_threads;
-- ============================================================================

BEGIN;

-- Conversation threading (email/threading.rs). Each synced email belongs to one
-- `email_threads` row via `emails.thread_id`, worked out from the provider's
-- conversation id (Gmail threadId / Outlook conversationId), the
-- In-Reply-To/References headers, then a same-subject-and-correspondent
-- fallback for replies. `email_thread_meta` keeps the matching inputs per email:
-- only keyed HMAC hashes of message ids and subjects (no plaintext), plus the
-- raw Message-ID and References encrypted at rest, which a threaded reply needs.
CREATE TABLE IF NOT EXISTS email_threads (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_threads_account
    ON email_threads(account_id, last_message_at DESC);
-- Set once a conversation has been completed from the provider on open.
ALTER TABLE email_threads ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE emails ADD COLUMN IF NOT EXISTS thread_id INTEGER
    REFERENCES email_threads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id);

CREATE TABLE IF NOT EXISTS email_thread_meta (
    email_id INTEGER PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    message_id_hash TEXT,
    in_reply_to_hash TEXT,
    reference_hashes TEXT[] NOT NULL DEFAULT '{}',
    provider_thread_id TEXT,
    subject_key_hash TEXT,
    sender_hash TEXT,
    is_reply BOOLEAN NOT NULL DEFAULT FALSE,
    message_id_iv TEXT,
    message_id_encrypted TEXT,
    references_iv TEXT,
    references_encrypted TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_thread_meta_msgid
    ON email_thread_meta(account_id, message_id_hash);
CREATE INDEX IF NOT EXISTS idx_email_thread_meta_irt
    ON email_thread_meta(account_id, in_reply_to_hash);
CREATE INDEX IF NOT EXISTS idx_email_thread_meta_provider
    ON email_thread_meta(account_id, provider_thread_id);
CREATE INDEX IF NOT EXISTS idx_email_thread_meta_subject
    ON email_thread_meta(account_id, subject_key_hash);
CREATE INDEX IF NOT EXISTS idx_email_thread_meta_refs
    ON email_thread_meta USING GIN (reference_hashes);
-- Keyed hashes of every bare address on the email (From, To), for the subject
-- fallback's "same correspondent" test. Bare and lower-cased, so the same
-- person matches whatever display name or header form a provider stored.
ALTER TABLE email_thread_meta
    ADD COLUMN IF NOT EXISTS correspondent_hashes TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_email_thread_meta_correspondents
    ON email_thread_meta USING GIN (correspondent_hashes);


-- Threading tables follow their mail: a conversation is visible to whoever can
-- see its mailbox (same rule as emails), and per-email threading metadata
-- inherits its email's visibility, as email_attachments does.
GRANT INSERT, UPDATE, DELETE ON email_threads     TO wayve_app;
GRANT INSERT, UPDATE, DELETE ON email_thread_meta TO wayve_app;
ALTER TABLE email_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_threads_rls ON email_threads;
CREATE POLICY email_threads_rls ON email_threads
    USING (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM email_accounts ea
            WHERE ea.id = email_threads.account_id
              AND ( ea.user_id = nullif(current_setting('app.user_id', true), '')::int
                 OR EXISTS (SELECT 1 FROM shared_inbox_members sm
                            WHERE sm.account_id = ea.id
                              AND sm.user_id = nullif(current_setting('app.user_id', true), '')::int)))
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM email_accounts ea
            WHERE ea.id = email_threads.account_id
              AND ( ea.user_id = nullif(current_setting('app.user_id', true), '')::int
                 OR EXISTS (SELECT 1 FROM shared_inbox_members sm
                            WHERE sm.account_id = ea.id
                              AND sm.user_id = nullif(current_setting('app.user_id', true), '')::int)))
    );
ALTER TABLE email_thread_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_thread_meta FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_thread_meta_rls ON email_thread_meta;
CREATE POLICY email_thread_meta_rls ON email_thread_meta
    USING (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (SELECT 1 FROM emails e WHERE e.id = email_thread_meta.email_id)
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (SELECT 1 FROM emails e WHERE e.id = email_thread_meta.email_id)
    );

COMMIT;
