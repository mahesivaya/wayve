-- Chat emoji reactions + admin-create email verification. Idempotent.
--
-- Covers everything `init.sql` gained between the deployed commit (41e6c05, PR
-- #69) and PR #70. `init.sql` only runs on a FIRST container init, so an already
-- initialised database (i.e. prod) needs these applied by hand.
--
-- APPLY THIS BEFORE STARTING THE NEW BACKEND. The chat history queries now join
-- `message_reactions`; without the table, every chat history fetch errors.
--
--   psql "$DATABASE_URL" -f infra/postgres/migrations/2026-07-chat-reactions-and-admin-create-verification.sql
--
-- Run as the database owner (`wayve_user`), the same role that owns the existing
-- tables — the grants below hand the restricted `wayve_app` role the access its
-- RLS policies assume.

-- ---------------------------------------------------------------------------
-- 1. Admin-create email verification
-- ---------------------------------------------------------------------------

-- Pre-creation email confirmation for admin-provisioned accounts. The code is
-- issued BEFORE the users row exists, so it cannot hang off
-- email_verification_tokens.user_id; it is keyed by (requesting admin,
-- account_email) instead. `delivery_email` is where the code was actually
-- mailed, which is not always the account address: org accounts are minted on
-- synthetic domains (<user>@<org-slug>.com) that have no real inbox, so the
-- admin points the code at the person's reachable mailbox.
CREATE TABLE IF NOT EXISTS admin_create_verifications (
    id SERIAL PRIMARY KEY,
    requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_email TEXT NOT NULL,
    delivery_email TEXT NOT NULL,
    code TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_create_verifications_lookup
    ON admin_create_verifications(requested_by, account_email, used_at);

-- ---------------------------------------------------------------------------
-- 2. Chat emoji reactions
-- ---------------------------------------------------------------------------

-- Emoji reactions on a chat message. DMs (`messages`) and channel messages
-- (`channel_messages`) are separate tables with separate id spaces, so a
-- reaction points at exactly one of them (the CHECK enforces the XOR) rather
-- than carrying a single ambiguous message_id.
--
-- NOTE ON ENCRYPTION: `emoji` is stored in PLAINTEXT, unlike message content
-- (which is a client-side E2E envelope the server cannot read). This is
-- deliberate: reactions have to be aggregated server-side — counts, who-reacted,
-- joined into the message list queries — and a message's AES key is wrapped
-- per-recipient at send time, so a reactor cannot produce an aggregatable
-- ciphertext. The cost is that the server learns "user X reacted 👍 to message
-- Y", on top of the sender/receiver/channel/timestamp metadata it already sees
-- in the clear for every message. Message BODIES remain E2E encrypted.
CREATE TABLE IF NOT EXISTS message_reactions (
    id BIGSERIAL PRIMARY KEY,
    message_id INT REFERENCES messages(id) ON DELETE CASCADE,
    channel_message_id INT REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT message_reactions_one_target
        CHECK ((message_id IS NULL) <> (channel_message_id IS NULL))
);

-- One reaction per (message, user, emoji) — re-reacting with the same emoji is
-- a toggle-off, not a second row. Partial uniques because of the nullable pair:
-- a plain UNIQUE would treat NULLs as distinct and let duplicates through.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reactions_dm_unique
    ON message_reactions (message_id, user_id, emoji) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reactions_channel_unique
    ON message_reactions (channel_message_id, user_id, emoji) WHERE channel_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Grants for the restricted role
-- ---------------------------------------------------------------------------
-- On a fresh database these come from the blanket GRANT/ALTER DEFAULT PRIVILEGES
-- at the end of init.sql. An existing database ran those before these tables
-- existed, so grant explicitly. Safe to re-run.
GRANT SELECT ON admin_create_verifications, message_reactions TO wayve_app;
GRANT INSERT, UPDATE, DELETE ON message_reactions TO wayve_app;
-- USAGE only (not SELECT) — matches what a fresh init.sql grants on sequences.
GRANT USAGE ON SEQUENCE
    admin_create_verifications_id_seq, message_reactions_id_seq TO wayve_app;

-- ---------------------------------------------------------------------------
-- 4. RLS on reactions
-- ---------------------------------------------------------------------------
-- Reactions are visible to whoever can see the message they hang off. The
-- EXISTS subqueries lean on the existing chat policies: under `wayve_app`,
-- `messages` only yields rows where the caller is sender/receiver, and
-- `channel_messages` only yields rows in channels the caller belongs to — so a
-- reaction on someone else's DM matches neither branch. Writes are self-only:
-- you may add or remove YOUR reaction, never anyone else's.
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_reactions_rls ON message_reactions;
CREATE POLICY message_reactions_rls ON message_reactions
    USING (current_setting('app.bypass', true) = 'on'
           OR EXISTS (SELECT 1 FROM messages m WHERE m.id = message_reactions.message_id)
           OR EXISTS (SELECT 1 FROM channel_messages cm WHERE cm.id = message_reactions.channel_message_id))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR (user_id = nullif(current_setting('app.user_id', true), '')::int
               AND (EXISTS (SELECT 1 FROM messages m WHERE m.id = message_reactions.message_id)
                    OR EXISTS (SELECT 1 FROM channel_messages cm WHERE cm.id = message_reactions.channel_message_id))));
