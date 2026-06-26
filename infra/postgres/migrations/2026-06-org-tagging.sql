-- ============================================================================
-- Tenant isolation, phase 1: tag tenant-owned rows with organization_id.
--
-- Foundation for Postgres Row-Level Security. RLS is NOT enabled here — this
-- only ensures every tenant-owned row carries a correct organization_id and
-- stays that way (via BEFORE INSERT triggers). Purely additive and reversible.
--
-- Idempotent + safe to re-run. Apply BY HAND to existing dev/prod DBs (init.sql
-- only runs on a fresh Postgres volume). The structural DDL (sections 1-4) also
-- lives in infra/postgres/init.sql so fresh installs get it automatically; this
-- file additionally runs the one-time backfill (section 5) + report (section 6).
--
--   Dev:  docker exec -i rwayve_postgres_dev psql -U wayve_user -d wayve_dev \
--           < infra/postgres/migrations/2026-06-org-tagging.sql
--   Prod: psql "$DATABASE_URL" -f infra/postgres/migrations/2026-06-org-tagging.sql
--
-- Chat (messages, channels, channel_*, chat_attachments) is intentionally NOT
-- org-tagged — it is participant-scoped. Global tables (users, organizations,
-- billing, api_keys, …) are never org-scoped. See init.sql for the full note.
-- ============================================================================

BEGIN;

-- ---- 1. Columns -----------------------------------------------------------
ALTER TABLE emails                  ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE email_attachments       ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE notes                   ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE tasks                   ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE task_attachments        ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE meetings                ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE meeting_participants    ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE drive_files             ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE folders                 ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE secure_messages         ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE user_jira_connections   ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE user_gitlab_connections ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;

-- ---- 2. Indexes (keep phase-2 RLS predicates cheap; harmless now) ----------
CREATE INDEX IF NOT EXISTS idx_emails_org                  ON emails(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_attachments_org       ON email_attachments(organization_id);
CREATE INDEX IF NOT EXISTS idx_notes_org                   ON notes(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org                   ON tasks(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_task_attachments_org        ON task_attachments(organization_id);
CREATE INDEX IF NOT EXISTS idx_meetings_org                ON meetings(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_participants_org    ON meeting_participants(organization_id);
CREATE INDEX IF NOT EXISTS idx_drive_files_org             ON drive_files(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_folders_org                 ON folders(organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_secure_messages_org         ON secure_messages(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_jira_connections_org   ON user_jira_connections(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_gitlab_connections_org ON user_gitlab_connections(organization_id);

-- ---- 3. Trigger functions -------------------------------------------------
-- Each only fills organization_id when the app left it NULL, so app-set values
-- always win. They derive the tenant from the row's existing owner/parent.

-- user-derived: notes, tasks, task_attachments, meetings, drive_files, folders,
-- user_jira_connections, user_gitlab_connections (all have NEW.user_id).
CREATE OR REPLACE FUNCTION set_org_from_user_id() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.user_id IS NOT NULL THEN
        SELECT u.organization_id INTO NEW.organization_id FROM users u WHERE u.id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- secure_messages: owner is sender_user_id.
CREATE OR REPLACE FUNCTION set_org_from_sender_user_id() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.sender_user_id IS NOT NULL THEN
        SELECT u.organization_id INTO NEW.organization_id FROM users u WHERE u.id = NEW.sender_user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- emails: prefer the mailbox's org (account_id -> email_accounts), else fall
-- back to the wayve-source recipient (recipient_user_id -> users).
CREATE OR REPLACE FUNCTION set_org_emails() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.account_id IS NOT NULL THEN
        SELECT ea.organization_id INTO NEW.organization_id FROM email_accounts ea WHERE ea.id = NEW.account_id;
    END IF;
    IF NEW.organization_id IS NULL AND NEW.recipient_user_id IS NOT NULL THEN
        SELECT u.organization_id INTO NEW.organization_id FROM users u WHERE u.id = NEW.recipient_user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- email_attachments: inherit from the parent email (already tagged on insert).
CREATE OR REPLACE FUNCTION set_org_from_email_id() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.email_id IS NOT NULL THEN
        SELECT e.organization_id INTO NEW.organization_id FROM emails e WHERE e.id = NEW.email_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- meeting_participants: inherit from the parent meeting (participant user_id may
-- be NULL for external invitees, so meeting_id is the reliable key).
CREATE OR REPLACE FUNCTION set_org_from_meeting_id() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.meeting_id IS NOT NULL THEN
        SELECT m.organization_id INTO NEW.organization_id FROM meetings m WHERE m.id = NEW.meeting_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---- 4. Triggers (BEFORE INSERT; CREATE OR REPLACE needs PG 14+) -----------
CREATE OR REPLACE TRIGGER trg_set_org_notes                  BEFORE INSERT ON notes                   FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_tasks                  BEFORE INSERT ON tasks                   FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_task_attachments       BEFORE INSERT ON task_attachments        FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_meetings               BEFORE INSERT ON meetings                FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_drive_files            BEFORE INSERT ON drive_files             FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_folders                BEFORE INSERT ON folders                 FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_user_jira              BEFORE INSERT ON user_jira_connections   FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_user_gitlab            BEFORE INSERT ON user_gitlab_connections FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_secure_messages        BEFORE INSERT ON secure_messages         FOR EACH ROW EXECUTE FUNCTION set_org_from_sender_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_emails                 BEFORE INSERT ON emails                  FOR EACH ROW EXECUTE FUNCTION set_org_emails();
CREATE OR REPLACE TRIGGER trg_set_org_email_attachments      BEFORE INSERT ON email_attachments       FOR EACH ROW EXECUTE FUNCTION set_org_from_email_id();
CREATE OR REPLACE TRIGGER trg_set_org_meeting_participants   BEFORE INSERT ON meeting_participants    FOR EACH ROW EXECUTE FUNCTION set_org_from_meeting_id();

-- ---- 5. One-time backfill (parents before children) -----------------------
UPDATE emails e SET organization_id = ea.organization_id
    FROM email_accounts ea
    WHERE e.account_id = ea.id AND ea.organization_id IS NOT NULL AND e.organization_id IS NULL;
UPDATE emails e SET organization_id = u.organization_id
    FROM users u
    WHERE e.recipient_user_id = u.id AND u.organization_id IS NOT NULL AND e.organization_id IS NULL;
UPDATE email_attachments a SET organization_id = e.organization_id
    FROM emails e
    WHERE a.email_id = e.id AND e.organization_id IS NOT NULL AND a.organization_id IS NULL;

UPDATE meetings m SET organization_id = u.organization_id
    FROM users u WHERE m.user_id = u.id AND u.organization_id IS NOT NULL AND m.organization_id IS NULL;
UPDATE meeting_participants p SET organization_id = m.organization_id
    FROM meetings m WHERE p.meeting_id = m.id AND m.organization_id IS NOT NULL AND p.organization_id IS NULL;

UPDATE tasks t SET organization_id = u.organization_id
    FROM users u WHERE t.user_id = u.id AND u.organization_id IS NOT NULL AND t.organization_id IS NULL;
UPDATE task_attachments a SET organization_id = u.organization_id
    FROM users u WHERE a.user_id = u.id AND u.organization_id IS NOT NULL AND a.organization_id IS NULL;

UPDATE notes n SET organization_id = u.organization_id
    FROM users u WHERE n.user_id = u.id AND u.organization_id IS NOT NULL AND n.organization_id IS NULL;
UPDATE drive_files d SET organization_id = u.organization_id
    FROM users u WHERE d.user_id = u.id AND u.organization_id IS NOT NULL AND d.organization_id IS NULL;
UPDATE folders f SET organization_id = u.organization_id
    FROM users u WHERE f.user_id = u.id AND u.organization_id IS NOT NULL AND f.organization_id IS NULL;
UPDATE secure_messages s SET organization_id = u.organization_id
    FROM users u WHERE s.sender_user_id = u.id AND u.organization_id IS NOT NULL AND s.organization_id IS NULL;
UPDATE user_jira_connections c SET organization_id = u.organization_id
    FROM users u WHERE c.user_id = u.id AND u.organization_id IS NOT NULL AND c.organization_id IS NULL;
UPDATE user_gitlab_connections c SET organization_id = u.organization_id
    FROM users u WHERE c.user_id = u.id AND u.organization_id IS NOT NULL AND c.organization_id IS NULL;

COMMIT;

-- ---- 6. Report remaining NULLs (expected = personal + unattributable rows) --
SELECT table_name, null_org, total FROM (
    SELECT 'emails'                  AS table_name, count(*) FILTER (WHERE organization_id IS NULL) AS null_org, count(*) AS total, 1  AS ord FROM emails
    UNION ALL SELECT 'email_attachments',       count(*) FILTER (WHERE organization_id IS NULL), count(*), 2  FROM email_attachments
    UNION ALL SELECT 'notes',                   count(*) FILTER (WHERE organization_id IS NULL), count(*), 3  FROM notes
    UNION ALL SELECT 'tasks',                   count(*) FILTER (WHERE organization_id IS NULL), count(*), 4  FROM tasks
    UNION ALL SELECT 'task_attachments',        count(*) FILTER (WHERE organization_id IS NULL), count(*), 5  FROM task_attachments
    UNION ALL SELECT 'meetings',                count(*) FILTER (WHERE organization_id IS NULL), count(*), 6  FROM meetings
    UNION ALL SELECT 'meeting_participants',    count(*) FILTER (WHERE organization_id IS NULL), count(*), 7  FROM meeting_participants
    UNION ALL SELECT 'drive_files',             count(*) FILTER (WHERE organization_id IS NULL), count(*), 8  FROM drive_files
    UNION ALL SELECT 'folders',                 count(*) FILTER (WHERE organization_id IS NULL), count(*), 9  FROM folders
    UNION ALL SELECT 'secure_messages',         count(*) FILTER (WHERE organization_id IS NULL), count(*), 10 FROM secure_messages
    UNION ALL SELECT 'user_jira_connections',   count(*) FILTER (WHERE organization_id IS NULL), count(*), 11 FROM user_jira_connections
    UNION ALL SELECT 'user_gitlab_connections', count(*) FILTER (WHERE organization_id IS NULL), count(*), 12 FROM user_gitlab_connections
) r ORDER BY ord;
