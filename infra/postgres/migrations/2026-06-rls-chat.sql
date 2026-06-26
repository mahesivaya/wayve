-- ============================================================================
-- RLS phase 2: enforce tenant isolation on the chat tables.
--
-- Participant-scoped. Channel policies must test channel_members, and a policy
-- on channel_members that queries channel_members would RECURSE — so membership
-- is resolved through a SECURITY DEFINER helper (runs as the owner, bypassing
-- RLS, no recursion).
--
-- Per the approved scope: HTTP read endpoints enforce (SET LOCAL ROLE wayve_app
-- + app.user_id); the WebSocket actor and channel-management writes run as the
-- superuser and bypass (they keep their existing app-level participant checks).
-- Deny-by-default. Idempotent. Apply by hand (dev first, then prod w/ backup).
-- Rollback: ALTER TABLE <t> NO FORCE / DISABLE ROW LEVEL SECURITY (per table).
-- ============================================================================

CREATE OR REPLACE FUNCTION app_is_channel_member(cid int, uid int)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = cid AND user_id = uid)
$$;
GRANT EXECUTE ON FUNCTION app_is_channel_member(int, int) TO wayve_app;

GRANT INSERT, UPDATE, DELETE ON
    messages, channels, channel_members, channel_messages,
    channel_invites, channel_join_requests, chat_attachments
TO wayve_app;

-- messages (DMs): visible to either participant
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_rls ON messages;
CREATE POLICY messages_rls ON messages
    USING (current_setting('app.bypass', true) = 'on'
           OR sender_id   = nullif(current_setting('app.user_id', true), '')::int
           OR receiver_id = nullif(current_setting('app.user_id', true), '')::int)
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR sender_id   = nullif(current_setting('app.user_id', true), '')::int
           OR receiver_id = nullif(current_setting('app.user_id', true), '')::int);

-- channels: visible to a member (or the creator)
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channels_rls ON channels;
CREATE POLICY channels_rls ON channels
    USING (current_setting('app.bypass', true) = 'on'
           OR created_by = nullif(current_setting('app.user_id', true), '')::int
           OR app_is_channel_member(id, nullif(current_setting('app.user_id', true), '')::int))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR created_by = nullif(current_setting('app.user_id', true), '')::int);

-- channel_members / channel_messages / channel_invites: visible to channel members
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['channel_members','channel_messages','channel_invites'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_rls', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING (%s) WITH CHECK (%s)',
            t || '_rls', t,
            $f$current_setting('app.bypass', true) = 'on' OR app_is_channel_member(channel_id, nullif(current_setting('app.user_id', true), '')::int)$f$,
            $f$current_setting('app.bypass', true) = 'on' OR app_is_channel_member(channel_id, nullif(current_setting('app.user_id', true), '')::int)$f$
        );
    END LOOP;
END $$;

-- channel_join_requests: a user sees/creates their own; channel members see the queue
ALTER TABLE channel_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_join_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_join_requests_rls ON channel_join_requests;
CREATE POLICY channel_join_requests_rls ON channel_join_requests
    USING (current_setting('app.bypass', true) = 'on'
           OR user_id = nullif(current_setting('app.user_id', true), '')::int
           OR app_is_channel_member(channel_id, nullif(current_setting('app.user_id', true), '')::int))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR user_id = nullif(current_setting('app.user_id', true), '')::int);

-- chat_attachments: uploader, or DM participants once linked (via messages RLS)
ALTER TABLE chat_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_attachments_rls ON chat_attachments;
CREATE POLICY chat_attachments_rls ON chat_attachments
    USING (current_setting('app.bypass', true) = 'on'
           OR uploader_id = nullif(current_setting('app.user_id', true), '')::int
           OR EXISTS (SELECT 1 FROM messages m WHERE m.id = chat_attachments.message_id))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR uploader_id = nullif(current_setting('app.user_id', true), '')::int);
