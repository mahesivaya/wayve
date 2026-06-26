-- ============================================================================
-- RLS phase 2: enforce tenant isolation on emails + email_attachments.
--
-- `emails` has no user_id; a row is legitimately visible to 3 principals:
--   1. the mailbox owner       (account_id -> email_accounts.user_id)
--   2. the wayve recipient     (source='wayve' AND recipient_user_id = me)
--   3. shared-inbox members    (shared_inbox_members(account_id, user_id))
-- so the policy is a subquery. `email_attachments` inherits its parent email's
-- visibility (emails RLS applies inside the EXISTS).
--
-- email_accounts is deliberately NOT RLS-enabled — the policy reads it to
-- resolve ownership/shared membership, so it must stay fully visible.
--
-- Same model as the rest of phase 2: request handlers SET LOCAL ROLE wayve_app
-- + set app.user_id so the policy engages; workers/admin stay superuser and
-- bypass. Idempotent. Apply by hand (dev first, then prod with a backup).
--   docker exec -i rwayve_postgres_dev psql -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-06-rls-emails.sql
-- Rollback: ALTER TABLE emails NO FORCE / DISABLE ROW LEVEL SECURITY (+ attachments).
-- ============================================================================

GRANT INSERT, UPDATE, DELETE ON emails            TO wayve_app;
GRANT INSERT, UPDATE, DELETE ON email_attachments TO wayve_app;

ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS emails_rls ON emails;
CREATE POLICY emails_rls ON emails
    USING (
        current_setting('app.bypass', true) = 'on'
        OR (source = 'wayve'
            AND recipient_user_id = nullif(current_setting('app.user_id', true), '')::int)
        OR EXISTS (
            SELECT 1 FROM email_accounts ea
            WHERE ea.id = emails.account_id
              AND ( ea.user_id = nullif(current_setting('app.user_id', true), '')::int
                 OR EXISTS (SELECT 1 FROM shared_inbox_members sm
                            WHERE sm.account_id = ea.id
                              AND sm.user_id = nullif(current_setting('app.user_id', true), '')::int))
        )
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR (source = 'wayve'
            AND recipient_user_id = nullif(current_setting('app.user_id', true), '')::int)
        OR EXISTS (
            SELECT 1 FROM email_accounts ea
            WHERE ea.id = emails.account_id
              AND ( ea.user_id = nullif(current_setting('app.user_id', true), '')::int
                 OR EXISTS (SELECT 1 FROM shared_inbox_members sm
                            WHERE sm.account_id = ea.id
                              AND sm.user_id = nullif(current_setting('app.user_id', true), '')::int))
        )
    );

ALTER TABLE email_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_attachments_rls ON email_attachments;
CREATE POLICY email_attachments_rls ON email_attachments
    USING (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (SELECT 1 FROM emails e WHERE e.id = email_attachments.email_id)
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (SELECT 1 FROM emails e WHERE e.id = email_attachments.email_id)
    );
