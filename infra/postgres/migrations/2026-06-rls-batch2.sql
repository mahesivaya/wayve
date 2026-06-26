-- ============================================================================
-- RLS phase 2, batch 2: enforce tenant isolation on the user-private tables.
--
-- Same model as notes (see 2026-06-rls-notes.sql): each row is visible/writable
-- only to its owner (`<owner> = app.user_id`) or to privileged paths that set
-- `app.bypass = 'on'`. The connecting role is a superuser and bypasses RLS, so
-- request handlers `SET LOCAL ROLE wayve_app` (a restricted role) to engage the
-- policy; workers/sync/webhooks/admin stay superuser and bypass.
--
-- Un-migrated readers don't break — they run as the superuser and bypass. RLS
-- *enforces* only on the migrated user-facing handlers (defense in depth).
--
-- Idempotent. Apply by hand to dev (NOT prod this cycle):
--   docker exec -i rwayve_postgres_dev psql -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-06-rls-batch2.sql
-- wayve_app already has SELECT on all tables + USAGE on all sequences (from the
-- notes migration); here we add write grants + per-table policies.
-- ============================================================================

-- Generic user_id-scoped tables ---------------------------------------------
DO $$
DECLARE
    t text;
    owner_col text;
    pairs text[][] := ARRAY[
        ['tasks','user_id'],
        ['task_attachments','user_id'],
        ['drive_files','user_id'],
        ['folders','user_id'],
        ['meetings','user_id'],
        ['secure_messages','sender_user_id'],
        ['user_jira_connections','user_id'],
        ['user_gitlab_connections','user_id']
    ];
    i int;
BEGIN
    FOR i IN 1 .. array_length(pairs, 1) LOOP
        t := pairs[i][1];
        owner_col := pairs[i][2];
        EXECUTE format('GRANT INSERT, UPDATE, DELETE ON %I TO wayve_app', t);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_rls', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING (%s) WITH CHECK (%s)',
            t || '_rls', t,
            format($f$current_setting('app.bypass', true) = 'on' OR %I = nullif(current_setting('app.user_id', true), '')::int$f$, owner_col),
            format($f$current_setting('app.bypass', true) = 'on' OR %I = nullif(current_setting('app.user_id', true), '')::int$f$, owner_col)
        );
    END LOOP;
END $$;

-- meeting_participants: owner is the PARENT meeting's owner (a participant row's
-- own user_id is nullable for external invitees), so scope via the meeting.
GRANT INSERT, UPDATE, DELETE ON meeting_participants TO wayve_app;
ALTER TABLE meeting_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meeting_participants_rls ON meeting_participants;
CREATE POLICY meeting_participants_rls ON meeting_participants
    USING (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = meeting_participants.meeting_id
              AND m.user_id = nullif(current_setting('app.user_id', true), '')::int
        )
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = meeting_participants.meeting_id
              AND m.user_id = nullif(current_setting('app.user_id', true), '')::int
        )
    );
