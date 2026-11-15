-- Foreign-key indexes for child tables that grow with usage. Same block as at
-- the end of init.sql.
--
-- On prod, run each line alone as CREATE INDEX CONCURRENTLY (it can't run
-- inside a transaction).
--
-- Idempotent.
CREATE INDEX IF NOT EXISTS idx_channel_messages_sender       ON channel_messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user        ON message_reactions (user_id);
CREATE INDEX IF NOT EXISTS idx_api_key_audit_user            ON api_key_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_org            ON email_accounts (organization_id);
CREATE INDEX IF NOT EXISTS idx_user_stories_project          ON user_stories (project_id);
CREATE INDEX IF NOT EXISTS idx_user_story_events_story       ON user_story_status_events (user_story_id);
CREATE INDEX IF NOT EXISTS idx_workspace_tickets_project     ON workspace_tickets (project_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent                ON folders (parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_org_document_folders_parent   ON org_document_folders (parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_org_documents_folder          ON org_documents (folder_id);
