-- Lookup indexes for hot paths. Same block as at the end of init.sql.
-- Applied to prod and local dev 2026-11-15 (prod via CREATE INDEX CONCURRENTLY).
--
-- Idempotent.
CREATE INDEX IF NOT EXISTS users_username_lower_idx   ON users (lower(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email_lower      ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_organization_id  ON users (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_members_user       ON organization_members (user_id);
CREATE INDEX IF NOT EXISTS idx_channel_msgs_top_id    ON channel_messages (channel_id, id) WHERE parent_message_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_created_by    ON channels (created_by);
CREATE INDEX IF NOT EXISTS idx_email_att_account      ON email_attachments (account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_wayve_gmail_id  ON emails (gmail_id) WHERE source = 'wayve';
CREATE INDEX IF NOT EXISTS idx_emails_unthreaded      ON emails (account_id, created_at DESC) WHERE thread_id IS NULL;
CREATE INDEX IF NOT EXISTS api_key_audit_created_idx  ON api_key_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_created    ON ai_usage_events (created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_jira_key         ON tasks (jira_issue_key) WHERE jira_issue_key IS NOT NULL;
