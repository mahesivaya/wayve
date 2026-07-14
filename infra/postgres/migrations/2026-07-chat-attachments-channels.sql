-- Channel file attachments. Idempotent.
--
-- Extends `chat_attachments` — until now DM-only — to also hang off channel
-- messages. `init.sql` only runs on a FIRST container init, so an already
-- initialised database (i.e. prod) needs this applied by hand.
--
-- APPLY THIS BEFORE STARTING THE NEW BACKEND. The channel send path now writes
-- `chat_attachments.channel_message_id`; without the column, sending a channel
-- message with an attachment errors.
--
--   psql "$DATABASE_URL" -f infra/postgres/migrations/2026-07-chat-attachments-channels.sql
--
-- Run as the database owner (`wayve_user`), the same role that owns the existing
-- tables — the RLS policy below is what the restricted `wayve_app` role reads
-- through. No new GRANTs are needed: `chat_attachments` already carries them and
-- a new column inherits the table-level grant.

-- ---------------------------------------------------------------------------
-- 1. Channel target column
-- ---------------------------------------------------------------------------
-- DMs (`messages`) and channel messages (`channel_messages`) are separate tables
-- with separate id spaces, so — as with `message_reactions` — an attachment
-- points at exactly one of them rather than carrying a single ambiguous id.
ALTER TABLE chat_attachments
    ADD COLUMN IF NOT EXISTS channel_message_id INT
    REFERENCES channel_messages(id) ON DELETE CASCADE;

-- "At most one target", not the strict XOR used by message_reactions: BOTH
-- columns are NULL between upload and send (the row is created by the upload
-- endpoint, and linked later by the WS send path).
ALTER TABLE chat_attachments DROP CONSTRAINT IF EXISTS chat_attachments_one_target;
ALTER TABLE chat_attachments
    ADD CONSTRAINT chat_attachments_one_target
    CHECK (message_id IS NULL OR channel_message_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_channel_message
    ON chat_attachments (channel_message_id);

-- ---------------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------------
-- An attachment is visible to the uploader (which also covers the window between
-- upload and send, when both target columns are still NULL) and to whoever can
-- see the message it hangs off. Like the reactions policy, the EXISTS subqueries
-- lean on the existing chat policies: under `wayve_app`, `messages` only yields
-- rows where the caller is sender/receiver and `channel_messages` only yields
-- rows in channels the caller belongs to — so an attachment on a DM or channel
-- the caller isn't part of matches no branch, and a user removed from a channel
-- loses access to its attachments on the next request. Writes stay self-only:
-- you may only insert/modify rows you uploaded.
--
-- This REPLACES the existing chat_attachments_rls policy, which had no channel
-- branch. Replacing it is what makes channel attachments readable at all.
ALTER TABLE chat_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_attachments_rls ON chat_attachments;
CREATE POLICY chat_attachments_rls ON chat_attachments
    USING (current_setting('app.bypass', true) = 'on'
           OR uploader_id = nullif(current_setting('app.user_id', true), '')::int
           OR EXISTS (SELECT 1 FROM messages m WHERE m.id = chat_attachments.message_id)
           OR EXISTS (SELECT 1 FROM channel_messages cm
                       WHERE cm.id = chat_attachments.channel_message_id))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR uploader_id = nullif(current_setting('app.user_id', true), '')::int);
