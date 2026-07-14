use crate::cache::Cache;
use crate::config::{self, RuntimeRole};
use crate::email::body_worker::run_body_worker;
use crate::workers::run_sync_worker;
use crate::{billing, email, observability, rbac_cache, webhooks};
use actix_cors::Cors;
use actix_web::http::header;
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;
use tracing::{info, instrument, warn};

#[instrument(target = "startup", skip(db_url), fields(max_conns))]
#[allow(dead_code)]
pub async fn establish_db_connection(db_url: &str, max_conns: u32) -> PgPool {
    let mut attempts: u32 = 0;
    loop {
        match PgPoolOptions::new()
            .max_connections(max_conns)
            .connect(db_url)
            .await
        {
            Ok(pool) => {
                if attempts > 0 {
                    info!("Connected to Postgres after {} retries", attempts);
                } else {
                    info!("Connected to Postgres");
                }
                return pool;
            }
            Err(e) => {
                if attempts == 0 {
                    warn!("Postgres unavailable, retrying... ({e:?})");
                } else if attempts.is_power_of_two() {
                    warn!("Postgres still unavailable after {} retries", attempts);
                }
                attempts += 1;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

#[instrument(target = "startup", skip(pool))]
pub async fn ensure_email_schema(pool: &PgPool) {
    let statements = [
        // Rename legacy `files` to `drive_files`. PK, sequence, and indexes are
        // renamed alongside because ALTER TABLE RENAME doesn't propagate to
        // owned objects.
        "DO $$ BEGIN \
           IF EXISTS (SELECT 1 FROM pg_class WHERE relname='files' AND relkind='r') \
           AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='drive_files' AND relkind='r') \
           THEN \
             EXECUTE 'ALTER TABLE files RENAME TO drive_files'; \
             EXECUTE 'ALTER SEQUENCE IF EXISTS files_id_seq RENAME TO drive_files_id_seq'; \
             EXECUTE 'ALTER INDEX IF EXISTS files_pkey RENAME TO drive_files_pkey'; \
             EXECUTE 'ALTER INDEX IF EXISTS idx_files_folder RENAME TO idx_drive_files_folder'; \
             EXECUTE 'ALTER INDEX IF EXISTS idx_files_user_id RENAME TO idx_drive_files_user_id'; \
           END IF; \
         END $$",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT TRUE",
        // Subject at-rest encryption, same envelope shape as body_*. New writes
        // leave `subject` NULL; legacy rows are migrated by
        // email::repo::backfill_subjects at startup.
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS subject_encrypted TEXT",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS subject_iv TEXT",
        // Sender/receiver at-rest encryption. The `*_hash` siblings hold an
        // HMAC-SHA256 of the lowercased address, keyed by an HKDF subkey of
        // AES_KEY, so exact-address lookups (e.g. the Sent filter) don't have to
        // decrypt every row.
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS sender_iv TEXT",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS sender_encrypted TEXT",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS sender_hash TEXT",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS receiver_iv TEXT",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS receiver_encrypted TEXT",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS receiver_hash TEXT",
        "CREATE INDEX IF NOT EXISTS idx_emails_sender_hash ON emails(sender_hash) \
         WHERE sender_hash IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_emails_receiver_hash ON emails(receiver_hash) \
         WHERE receiver_hash IS NOT NULL",
        // Provider labels (Gmail labelIds, Outlook categories) backing the
        // sidebar category folders. The GIN index keeps `<label> = ANY(labels)`
        // index-scanned.
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}'",
        "CREATE INDEX IF NOT EXISTS idx_emails_labels ON emails USING GIN (labels)",
        // Wayve-to-Wayve native channel. `source` tags row provenance so the
        // list query knows whether to join through email_accounts
        // (imap/gmail/outlook) or scan by recipient_user_id (wayve), which owns
        // a 'wayve'-source row when account_id is NULL.
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'imap'",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS recipient_user_id INTEGER \
         REFERENCES users(id) ON DELETE CASCADE",
        "CREATE INDEX IF NOT EXISTS idx_emails_recipient_user_id \
         ON emails(recipient_user_id, created_at DESC) \
         WHERE recipient_user_id IS NOT NULL",
        // Widen the body-worker partial index to match the worker's predicate:
        // missing body OR pending attachment verification. CREATE INDEX IF NOT
        // EXISTS won't replace the old predicate, so DROP first.
        "DROP INDEX IF EXISTS idx_emails_pending_body",
        "CREATE INDEX IF NOT EXISTS idx_emails_pending_body \
         ON emails (account_id, id) \
         WHERE body_encrypted = '' OR body_encrypted IS NULL OR attachments_checked = false",
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS display_name TEXT",
        // NULL until the first sync writes it; `load_account_summaries_for_user`
        // falls back to a local COUNT during that window.
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider_unread_count INTEGER",
        // Adaptive-backoff signal: the sync worker reads this to pick the poll
        // cadence for the account — 30s (hot), 60s (warm), 5min (cool), or
        // 30min (cold).
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP",
        // Seed last_message_at on DBs that predate adaptive backoff; NULL would
        // otherwise force every account into the cold (30min) bucket. Touches
        // only NULL rows, so it is a no-op on later boots.
        "UPDATE email_accounts a \
         SET last_message_at = sub.last_at \
         FROM (SELECT account_id, MAX(created_at) AS last_at FROM emails GROUP BY account_id) sub \
         WHERE a.id = sub.account_id AND a.last_message_at IS NULL",
        "CREATE TABLE IF NOT EXISTS folders (
            id BIGSERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            parent_folder_id BIGINT REFERENCES folders(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )",
        "CREATE INDEX IF NOT EXISTS idx_folders_user_parent \
         ON folders(user_id, parent_folder_id)",
        "ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS folder_id BIGINT \
         REFERENCES folders(id) ON DELETE CASCADE",
        "CREATE INDEX IF NOT EXISTS idx_drive_files_folder ON drive_files(folder_id)",
        // Prevent duplicate active subscriptions per user/org: Stripe webhooks
        // can race during upgrades, and without this `current_plan_for_user`
        // picks whichever duplicate has the higher id. Creation fails if
        // duplicates already exist; the `warn!` below logs it and an operator
        // cancels the older row by hand — automatic cleanup could clobber real
        // subscription state.
        "CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_user_uniq \
         ON subscriptions(user_id) \
         WHERE status = 'active' AND user_id IS NOT NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_org_uniq \
         ON subscriptions(organization_id) \
         WHERE status = 'active' AND organization_id IS NOT NULL",
        // Accounts connected before `last_sync` was stamped on INSERT have NULL,
        // which forces the sync worker into a full-mailbox crawl every tick and
        // can never finish for large mailboxes. The on-connect backfill already
        // pulled recent history, so seeding the cursor to NOW is safe.
        "UPDATE email_accounts \
         SET last_sync = EXTRACT(EPOCH FROM NOW())::BIGINT \
         WHERE last_sync IS NULL",
        "ALTER TABLE notes ADD COLUMN IF NOT EXISTS title_encrypted TEXT",
        "ALTER TABLE notes ADD COLUMN IF NOT EXISTS title_iv TEXT",
        "ALTER TABLE notes ADD COLUMN IF NOT EXISTS content_encrypted TEXT",
        "ALTER TABLE notes ADD COLUMN IF NOT EXISTS content_iv TEXT",
        "ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS file_iv TEXT",
        "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS title_encrypted TEXT",
        "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS title_iv TEXT",
        "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS zoom_join_url_encrypted TEXT",
        "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS zoom_join_url_iv TEXT",
        "ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS email_encrypted TEXT",
        "ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS email_iv TEXT",
        "CREATE TABLE IF NOT EXISTS organization_members (
            organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL DEFAULT 'member',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (organization_id, user_id),
            CONSTRAINT organization_members_role_chk CHECK (
                role IN ('owner', 'super_admin', 'admin', 'security', 'billing', 'developer', 'support', 'member', 'guest')
            )
        )",
        "ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS organization_members_role_chk",
        "ALTER TABLE organization_members ADD CONSTRAINT organization_members_role_chk CHECK (
            role IN ('owner', 'super_admin', 'admin', 'security', 'billing', 'developer', 'support', 'member', 'guest')
        )",
        "INSERT INTO organization_members (organization_id, user_id, role)
         SELECT organization_id, id,
                CASE
                    WHEN account_type = 'organization_admin' THEN 'owner'
                    ELSE 'member'
                END
         FROM users
         WHERE organization_id IS NOT NULL
         ON CONFLICT (organization_id, user_id) DO NOTHING",
        "CREATE TABLE IF NOT EXISTS platform_members (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL DEFAULT 'admin',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT platform_members_role_chk CHECK (
                role IN ('owner', 'super_admin', 'admin', 'security', 'billing', 'developer', 'support', 'member', 'guest')
            )
        )",
        "ALTER TABLE platform_members DROP CONSTRAINT IF EXISTS platform_members_role_chk",
        "ALTER TABLE platform_members ADD CONSTRAINT platform_members_role_chk CHECK (
            role IN ('owner', 'super_admin', 'admin', 'security', 'billing', 'developer', 'support', 'member', 'guest')
        )",
        "INSERT INTO platform_members (user_id, role)
         SELECT id, 'owner'
         FROM users
         WHERE account_type = 'platform_admin'
         ON CONFLICT (user_id) DO NOTHING",
        "CREATE TABLE IF NOT EXISTS siem_webhook_configs (
            id BIGSERIAL PRIMARY KEY,
            scope TEXT NOT NULL,
            organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            webhook_url TEXT NOT NULL,
            token_iv TEXT,
            token_encrypted TEXT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT siem_webhook_scope_chk CHECK (scope IN ('platform', 'organization', 'personal'))
        )",
        "CREATE UNIQUE INDEX IF NOT EXISTS siem_webhook_platform_uniq
         ON siem_webhook_configs(scope)
         WHERE scope = 'platform'",
        "CREATE UNIQUE INDEX IF NOT EXISTS siem_webhook_org_uniq
         ON siem_webhook_configs(organization_id)
         WHERE scope = 'organization'",
        "CREATE UNIQUE INDEX IF NOT EXISTS siem_webhook_user_uniq
         ON siem_webhook_configs(user_id)
         WHERE scope = 'personal'",
        "CREATE TABLE IF NOT EXISTS drive_shares (
            id BIGSERIAL PRIMARY KEY,
            resource_type TEXT NOT NULL,
            resource_id BIGINT NOT NULL,
            scope TEXT NOT NULL,
            organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            permission TEXT NOT NULL DEFAULT 'view',
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT drive_shares_resource_chk CHECK (resource_type IN ('file', 'folder')),
            CONSTRAINT drive_shares_scope_chk CHECK (scope IN ('organization', 'platform')),
            CONSTRAINT drive_shares_permission_chk CHECK (permission IN ('view', 'edit'))
        )",
        "CREATE UNIQUE INDEX IF NOT EXISTS drive_shares_unique_idx
         ON drive_shares(resource_type, resource_id, scope, COALESCE(organization_id, 0))",
        "CREATE INDEX IF NOT EXISTS drive_shares_org_idx
         ON drive_shares(organization_id, resource_type, resource_id)",
        // Shared inboxes (multi-tenant). /api/emails and /api/accounts JOIN
        // against these on every call, so a DB without them 500s.
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS organization_id INTEGER \
         REFERENCES organizations(id) ON DELETE CASCADE",
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE",
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS shared_label TEXT",
        "CREATE TABLE IF NOT EXISTS shared_inbox_members (
            account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            can_reply BOOLEAN NOT NULL DEFAULT TRUE,
            can_manage BOOLEAN NOT NULL DEFAULT FALSE,
            added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (account_id, user_id)
        )",
        "CREATE INDEX IF NOT EXISTS idx_shared_inbox_members_user \
         ON shared_inbox_members(user_id)",
        "CREATE TABLE IF NOT EXISTS shared_inbox_email_state (
            email_id INTEGER PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
            assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
        )",
        "CREATE INDEX IF NOT EXISTS idx_shared_inbox_state_assignee \
         ON shared_inbox_email_state(assignee_id) WHERE assignee_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_shared_inbox_state_status \
         ON shared_inbox_email_state(status)",
        // Recovery seed: the user's private key wrapped with
        // PBKDF2(mnemonic) → AES-GCM, opaque to the server. Wire format must
        // stay in sync with routes/recovery.rs and frontend/src/crypto/recovery.ts.
        "CREATE TABLE IF NOT EXISTS user_wrapped_keys (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            v INTEGER NOT NULL,
            iv TEXT NOT NULL,
            pub_key TEXT NOT NULL,
            ct TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        // Threaded channel replies: parent_message_id points at the top of a
        // thread and is NULL for top-level messages.
        "ALTER TABLE channel_messages \
         ADD COLUMN IF NOT EXISTS parent_message_id INT \
         REFERENCES channel_messages(id) ON DELETE CASCADE",
        "CREATE INDEX IF NOT EXISTS idx_channel_messages_parent \
         ON channel_messages (parent_message_id) \
         WHERE parent_message_id IS NOT NULL",
        // Recovery mode is collapsed to 'full' only. Legacy 'basic' /
        // 'password_only' rows are pinned to 'full' first so the tighter CHECK
        // installs cleanly; AuthContext then re-wraps those users on next login
        // so the mnemonic is the only way back in. Mirrors init.sql.
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mode TEXT NOT NULL DEFAULT 'full'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_encrypted TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_iv TEXT",
        "UPDATE users SET recovery_mode = 'full' WHERE recovery_mode <> 'full'",
        "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_recovery_mode_check",
        "ALTER TABLE users ADD CONSTRAINT users_recovery_mode_check \
         CHECK (recovery_mode = 'full')",
        // Durable presence fallback, read by the presence snapshot endpoint.
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ",
        // OIDC SSO (multi-tenant). One IdP config row per org; allowed_domain
        // routes alice@acme.com to Acme's IdP. The sso_states row binds PKCE and
        // nonce to the in-flight code so a stolen `code` alone can't be exchanged.
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_sub TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_org_id INTEGER \
         REFERENCES organizations(id) ON DELETE SET NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS users_sso_identity_unique_idx \
         ON users (sso_org_id, sso_sub) WHERE sso_sub IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS org_sso_configs (
            id SERIAL PRIMARY KEY,
            organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
            issuer_url TEXT NOT NULL,
            client_id TEXT NOT NULL,
            client_secret_iv TEXT NOT NULL,
            client_secret_encrypted TEXT NOT NULL,
            allowed_domain TEXT NOT NULL UNIQUE,
            enforce_sso BOOLEAN NOT NULL DEFAULT FALSE,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE INDEX IF NOT EXISTS idx_org_sso_configs_domain \
         ON org_sso_configs(allowed_domain)",
        // Custom-domain ownership, proven by a DNS TXT challenge. Only a
        // verified row lets an org mint `*@domain` member addresses, and
        // `verified` is set by the server after the DNS check, never by the
        // client. UNIQUE(domain) stops two orgs claiming the same domain.
        "CREATE TABLE IF NOT EXISTS organization_domains (
            id SERIAL PRIMARY KEY,
            organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            domain TEXT NOT NULL UNIQUE,
            verify_token TEXT NOT NULL,
            verified BOOLEAN NOT NULL DEFAULT FALSE,
            verified_at TIMESTAMPTZ,
            last_checked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE INDEX IF NOT EXISTS idx_organization_domains_org \
         ON organization_domains(organization_id)",
        "CREATE TABLE IF NOT EXISTS sso_states (
            state TEXT PRIMARY KEY,
            sso_config_id INTEGER NOT NULL REFERENCES org_sso_configs(id) ON DELETE CASCADE,
            pkce_verifier TEXT NOT NULL,
            nonce TEXT NOT NULL,
            return_to TEXT,
            expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE TABLE IF NOT EXISTS tasks (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            priority SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
            status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'to_do'",
        "ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check",
        "ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('to_do', 'in_progress', 'in_review', 'done'))",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_by TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee TEXT NOT NULL DEFAULT ''",
        "CREATE INDEX IF NOT EXISTS idx_tasks_user_priority \
         ON tasks(user_id, priority DESC, created_at DESC)",
        // Per-user friendly task number: add the column, backfill existing rows
        // once, then install the uniqueness guard. Mirrors init.sql.
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_number INTEGER",
        "WITH numbered AS ( \
            SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id) AS rn \
            FROM tasks WHERE task_number IS NULL \
         ) \
         UPDATE tasks t SET task_number = n.rn FROM numbered n WHERE t.id = n.id",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_user_task_number \
         ON tasks(user_id, task_number) WHERE task_number IS NOT NULL",
        // Workspace Documents. `organization_id` is nullable: non-null is that
        // org's shared docs, NULL is the platform-team-wide set (platform staff
        // have no org). The DROP NOT NULL migrates tables created before that.
        "CREATE TABLE IF NOT EXISTS org_document_folders (
            id BIGSERIAL PRIMARY KEY,
            organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            parent_folder_id BIGINT REFERENCES org_document_folders(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "ALTER TABLE org_document_folders ALTER COLUMN organization_id DROP NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_org_doc_folders_org_parent \
         ON org_document_folders(organization_id, parent_folder_id)",
        "CREATE TABLE IF NOT EXISTS org_documents (
            id BIGSERIAL PRIMARY KEY,
            organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            folder_id BIGINT REFERENCES org_document_folders(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            file_type TEXT,
            file_path TEXT NOT NULL,
            file_iv TEXT,
            size BIGINT NOT NULL DEFAULT 0,
            uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "ALTER TABLE org_documents ALTER COLUMN organization_id DROP NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_org_documents_org_folder \
         ON org_documents(organization_id, folder_id)",
        // Payroll, independent of the Stripe billing projection. Employees
        // aren't always Wayve users (contractors, pre-account hires) so user_id
        // is nullable, and `payroll_run_items.employee_name` denormalizes the
        // name at run time so a historical run still reads correctly after the
        // employee is renamed or terminated.
        "CREATE TABLE IF NOT EXISTS employees (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL,
            job_title TEXT,
            department TEXT,
            employment_type TEXT NOT NULL DEFAULT 'full_time'
                CHECK (employment_type IN ('full_time','part_time','contractor')),
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','on_leave','terminated')),
            base_salary_cents BIGINT NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'USD',
            pay_frequency TEXT NOT NULL DEFAULT 'monthly'
                CHECK (pay_frequency IN ('monthly','biweekly','weekly','annual')),
            hire_date DATE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE UNIQUE INDEX IF NOT EXISTS employees_email_uniq \
         ON employees(lower(email))",
        "CREATE INDEX IF NOT EXISTS idx_employees_status_dept \
         ON employees(status, department)",
        "CREATE TABLE IF NOT EXISTS payroll_runs (
            id SERIAL PRIMARY KEY,
            period_start DATE NOT NULL,
            period_end DATE NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','approved','paid','cancelled')),
            total_gross_cents BIGINT NOT NULL DEFAULT 0,
            total_tax_cents BIGINT NOT NULL DEFAULT 0,
            total_net_cents BIGINT NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'USD',
            notes TEXT,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            paid_at TIMESTAMPTZ,
            UNIQUE (period_start, period_end)
        )",
        "CREATE TABLE IF NOT EXISTS payroll_run_items (
            id SERIAL PRIMARY KEY,
            payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
            employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
            employee_name TEXT NOT NULL,
            gross_cents BIGINT NOT NULL DEFAULT 0,
            tax_cents BIGINT NOT NULL DEFAULT 0,
            net_cents BIGINT NOT NULL DEFAULT 0,
            UNIQUE (payroll_run_id, employee_id)
        )",
        "CREATE INDEX IF NOT EXISTS idx_payroll_run_items_run \
         ON payroll_run_items(payroll_run_id)",
        // Outbound webhooks: the dispatcher worker delivers signed JSON
        // envelopes with retry. `secret` is the hex HMAC-SHA256 key, revealed
        // exactly once at creation. `org_wide = true` requires organization_id
        // and delivers events for every member of that org, not just the creator.
        "CREATE TABLE IF NOT EXISTS webhook_endpoints (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
            org_wide BOOLEAN NOT NULL DEFAULT FALSE,
            url TEXT NOT NULL,
            secret TEXT NOT NULL,
            secret_preview TEXT NOT NULL,
            events TEXT[] NOT NULL DEFAULT '{}',
            description TEXT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            last_success_at TIMESTAMPTZ,
            last_failure_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT webhook_endpoints_org_wide_chk
                CHECK (org_wide = false OR organization_id IS NOT NULL)
        )",
        "CREATE INDEX IF NOT EXISTS webhook_endpoints_user_idx ON webhook_endpoints(user_id)",
        "CREATE INDEX IF NOT EXISTS webhook_endpoints_org_idx ON webhook_endpoints(organization_id) WHERE organization_id IS NOT NULL",
        // Delivery queue. `status = pending AND next_attempt_at <= NOW()` is the
        // dispatcher's pickup predicate; the partial index below keeps it cheap.
        "CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id BIGSERIAL PRIMARY KEY,
            endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload JSONB NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','delivered','failed','abandoned')),
            http_status INTEGER,
            response_excerpt TEXT,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            delivered_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx \
         ON webhook_deliveries(next_attempt_at) WHERE status = 'pending'",
        "CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx \
         ON webhook_deliveries(endpoint_id, created_at DESC)",
        // Slack integration (enterprise only). One workspace per org, bot token
        // encrypted at rest. slack_channel_links maps a Slack channel to a Wayve
        // channel for inbound import and outbound posting.
        "CREATE TABLE IF NOT EXISTS slack_connections (
            organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
            bot_token_iv TEXT NOT NULL,
            bot_token_encrypted TEXT NOT NULL,
            team_id TEXT,
            team_name TEXT,
            connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )",
        "CREATE TABLE IF NOT EXISTS slack_channel_links (
            id SERIAL PRIMARY KEY,
            organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            wayve_channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            slack_channel_id TEXT NOT NULL,
            slack_channel_name TEXT,
            last_imported_ts TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_link_org_channel \
         ON slack_channel_links(organization_id, slack_channel_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_link_wayve_channel \
         ON slack_channel_links(wayve_channel_id)",
        // GitLab integration (per-user, mirrors Jira): connect an instance with
        // a PAT and import assigned issues into Tasks via the gitlab_* columns.
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gitlab_issue_iid INTEGER",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gitlab_project_id INTEGER",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gitlab_web_url TEXT",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_user_gitlab_issue \
         ON tasks(user_id, gitlab_project_id, gitlab_issue_iid) \
         WHERE gitlab_issue_iid IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS user_gitlab_connections (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            base_url TEXT NOT NULL,
            access_token_iv TEXT NOT NULL,
            access_token_encrypted TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )",
        // Jira integration (per-user).
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS jira_issue_key TEXT",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS jira_base TEXT",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_user_jira_issue \
         ON tasks(user_id, jira_issue_key) WHERE jira_issue_key IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS user_jira_connections (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            base_url TEXT NOT NULL,
            email TEXT NOT NULL,
            api_token_iv TEXT NOT NULL,
            api_token_encrypted TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )",
        // Plan catalog columns only. The catalog rows are owned by
        // `billing/catalog.rs` and upserted by `seed_plan_catalog` after this
        // DDL runs, so change pricing or plans there, not here.
        "ALTER TABLE plans ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'personal'",
        // Per-plan API rate ceiling and rolling 30-day request budget
        // (-1 = unlimited); values come from the catalog seed.
        "ALTER TABLE plans ADD COLUMN IF NOT EXISTS rate_limit_per_min \
         INTEGER NOT NULL DEFAULT 60",
        "ALTER TABLE plans ADD COLUMN IF NOT EXISTS monthly_quota \
         INTEGER NOT NULL DEFAULT 50000",
        // SCIM 2.0 provisioning. An org mints a bearer token here; only its
        // SHA-256 `token_hash` is stored and the raw value is shown once at
        // creation. `users.external_id` is the SCIM stable identifier the IdP
        // keys on, and is sparse — only IdP-managed users carry one.
        "CREATE TABLE IF NOT EXISTS scim_tokens (
            id SERIAL PRIMARY KEY,
            organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            token_preview TEXT NOT NULL,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            last_used_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE INDEX IF NOT EXISTS scim_tokens_org_idx ON scim_tokens(organization_id) WHERE revoked_at IS NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id TEXT",
        "CREATE UNIQUE INDEX IF NOT EXISTS users_external_id_org_idx \
         ON users(organization_id, external_id) WHERE external_id IS NOT NULL",
        // Per-user 1 GiB ciphertext quota across emails, chat, drive, tasks,
        // calendar, and notes.
        "CREATE TABLE IF NOT EXISTS user_storage_usage (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            bytes_used BIGINT NOT NULL DEFAULT 0,
            bytes_quota BIGINT NOT NULL DEFAULT 1073741824,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT user_storage_usage_nonneg_chk CHECK (bytes_used >= 0 AND bytes_quota >= 0)
        )",
        // Secure-send magic links. The server stores only opaque ciphertext, the
        // wrapped key, and a per-message PBKDF2 salt; it never sees the
        // passphrase the recipient needs.
        "CREATE TABLE IF NOT EXISTS secure_messages (
            id BIGSERIAL PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            recipient_email TEXT NOT NULL,
            subject TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            iv TEXT NOT NULL,
            wrapped_key TEXT NOT NULL,
            salt TEXT NOT NULL,
            pbkdf2_iterations INTEGER NOT NULL DEFAULT 600000,
            expires_at TIMESTAMPTZ NOT NULL,
            opened_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE INDEX IF NOT EXISTS idx_secure_messages_expires_at \
         ON secure_messages(expires_at)",
        "CREATE INDEX IF NOT EXISTS idx_secure_messages_sender \
         ON secure_messages(sender_user_id, created_at DESC)",
        // Organization Master Key. Handlers live in organization/keys.rs.
        "CREATE TABLE IF NOT EXISTS organization_keys (
            organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
            public_key TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE TABLE IF NOT EXISTS organization_wrapped_keys (
            id BIGSERIAL PRIMARY KEY,
            organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            wrap_method TEXT NOT NULL CHECK (wrap_method IN ('mnemonic', 'user_pubkey')),
            holder_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            iv TEXT NOT NULL,
            ct TEXT NOT NULL,
            pbkdf2_iterations INTEGER,
            pbkdf2_salt TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_wrapped_keys_holder \
         ON organization_wrapped_keys(organization_id, holder_user_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_wrapped_keys_mnemonic \
         ON organization_wrapped_keys(organization_id) \
         WHERE wrap_method = 'mnemonic'",
        "CREATE TABLE IF NOT EXISTS member_login_wrapped_keys (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            iv TEXT NOT NULL,
            ct TEXT NOT NULL,
            salt TEXT NOT NULL,
            iterations INTEGER NOT NULL DEFAULT 600000,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE TABLE IF NOT EXISTS member_wrapped_keys (
            organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            iv TEXT NOT NULL,
            ct TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (organization_id, user_id)
        )",
        "CREATE TABLE IF NOT EXISTS org_key_audit_log (
            id BIGSERIAL PRIMARY KEY,
            organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            actor_role TEXT,
            action TEXT NOT NULL,
            target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            ip TEXT,
            user_agent TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE INDEX IF NOT EXISTS idx_org_key_audit_log_org_time \
         ON org_key_audit_log(organization_id, created_at DESC)",
        // Per-user project (GitHub repo) access: one row grants one user
        // visibility of one repo on the Projects page. Admins and platform staff
        // are unrestricted and ignore this table.
        "CREATE TABLE IF NOT EXISTS member_project_access (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            repo_full_name TEXT NOT NULL,
            granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, repo_full_name)
        )",
        "CREATE INDEX IF NOT EXISTS idx_member_project_access_user \
         ON member_project_access(user_id)",
        // Wayve-intended access level for the per-repo Access panel. GitHub's
        // live collaborator permission wins when it is readable.
        "ALTER TABLE member_project_access ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'read'",
        "ALTER TABLE member_project_access DROP CONSTRAINT IF EXISTS member_project_access_level_check",
        "ALTER TABLE member_project_access ADD CONSTRAINT member_project_access_level_check \
         CHECK (access_level IN ('read', 'write'))",
        "CREATE INDEX IF NOT EXISTS idx_member_project_access_repo \
         ON member_project_access(repo_full_name)",
    ];

    for statement in statements {
        if let Err(e) = sqlx::query(statement).execute(pool).await {
            warn!(error = ?e, "email schema compatibility check failed");
        }
    }

    // Must run after the DDL above, which creates the columns it writes.
    if let Err(e) = seed_plan_catalog(pool).await {
        warn!(error = ?e, "plan catalog seed failed");
    }
}

/// Upsert `billing::catalog::PLAN_CATALOG` into the `plans` table on every boot,
/// so fresh and existing DBs converge without a migration. Only catalog codes are
/// overwritten; operator-defined plan codes are left alone. To change
/// pricing or plans, edit `billing/catalog.rs`, not this function.
async fn seed_plan_catalog(pool: &PgPool) -> Result<(), sqlx::Error> {
    for plan in crate::billing::catalog::PLAN_CATALOG {
        let features = serde_json::json!({ "bullets": plan.features });
        sqlx::query(
            "INSERT INTO plans \
               (code, name, description, audience, tier, amount_cents, \
                billing_interval, storage_limit_bytes, seat_limit, features, \
                rate_limit_per_min, monthly_quota) \
             VALUES ($1, $2, $3, $4, $5, $6, 'month', $7, $8, $9, $10, $11) \
             ON CONFLICT (code) DO UPDATE SET \
               name = EXCLUDED.name, description = EXCLUDED.description, \
               audience = EXCLUDED.audience, tier = EXCLUDED.tier, \
               amount_cents = EXCLUDED.amount_cents, \
               billing_interval = EXCLUDED.billing_interval, \
               storage_limit_bytes = EXCLUDED.storage_limit_bytes, \
               seat_limit = EXCLUDED.seat_limit, features = EXCLUDED.features, \
               rate_limit_per_min = EXCLUDED.rate_limit_per_min, \
               monthly_quota = EXCLUDED.monthly_quota, is_active = TRUE",
        )
        .bind(plan.code)
        .bind(plan.name)
        .bind(plan.description)
        .bind(plan.audience)
        .bind(plan.tier)
        .bind(plan.amount_cents)
        .bind(plan.storage_limit_bytes)
        .bind(plan.seat_limit)
        .bind(&features)
        .bind(plan.rate_limit_per_min)
        .bind(plan.monthly_quota)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Initialise tracing, load `.env` files, and validate required config.
/// Called once at process start.
pub fn init_telemetry() {
    observability::tracing::init_tracing();
    config::load_env_files();
    config::validate();
    info!("Server starting...");
    tracing::info!("Server starting...");
}

/// Connect to Postgres with retries and run the idempotent startup migrations
/// (email schema compat, subject backfill, dev-only Stripe test-price seed).
#[instrument(target = "startup", skip())]
pub async fn connect_db_and_migrate(role: RuntimeRole) -> PgPool {
    let db_url = config::database_url();
    let max_db_connections = config::db_max_connections(role);
    info!(max_db_connections, "Database pool size selected");
    let pool = wayve_db::pool::connect_with_retries(&db_url, max_db_connections).await;

    ensure_email_schema(&pool).await;

    // Encrypts legacy plaintext subjects; re-runs only touch rows still missing
    // the envelope.
    match email::repo::backfill_subjects(&pool).await {
        Ok(0) => {}
        Ok(n) => info!(target: "startup", encrypted = n, "backfilled legacy email subjects"),
        Err(e) => warn!(target: "startup", error = ?e, "subject backfill failed"),
    }

    // Same shape for sender/receiver. The plaintext columns are deliberately
    // left populated; a later change drops them.
    match email::repo::backfill_addresses(&pool).await {
        Ok(0) => {}
        Ok(n) => info!(target: "startup", encrypted = n, "backfilled legacy email addresses"),
        Err(e) => warn!(target: "startup", error = ?e, "address backfill failed"),
    }

    // Dev/test only: creates Stripe test prices for unlinked paid plans.
    // Silently skips when STRIPE_SECRET_KEY is missing or live.
    billing::ensure_test_prices(&pool).await;

    pool
}

/// Initialize process-wide feature state for every role, workers and API alike.
/// Today that is the global DB pool that code paths without a `&PgPool` argument
/// (the IMAP/SMTP send path) read. Must be called after the pool is connected and
/// before `spawn_role_workers`.
pub fn init_feature_state(pool: &PgPool) {
    crate::email::account::init_pool(pool.clone());
}

/// Spawn the background tokio tasks for a runtime role. This is the only place
/// worker and subscriber tasks start, so add new background jobs here rather
/// than ad-hoc in `main`.
///
/// * `EmailSyncWorker` / `EmailBodyWorker` are `.await`ed rather than spawned so
///   the binary exits when the worker stops.
/// * `All` co-locates every worker with the API in one container (dev compose
///   and small deployments).
/// * `Api` runs only the lightweight webhook dispatcher; sync and body workers
///   are deployed separately.
///
/// The chat pub/sub subscriber and presence sweeper only matter on socket-serving
/// roles and only with Redis up; without it senders fall back to local delivery.
pub async fn spawn_role_workers(role: RuntimeRole, pool: &PgPool, cache: &Option<Cache>) {
    let has_redis = cache.is_some();
    match role {
        RuntimeRole::EmailSyncWorker => {
            spawn_gmail_watch_renewer(pool.clone());
            run_sync_worker(pool.clone()).await
        }
        RuntimeRole::EmailBodyWorker => run_body_worker(pool.clone()).await,
        RuntimeRole::All => {
            let sync_pool = pool.clone();
            tokio::spawn(async move {
                run_sync_worker(sync_pool).await;
            });
            spawn_gmail_watch_renewer(pool.clone());
            let body_pool = pool.clone();
            tokio::spawn(async move {
                run_body_worker(body_pool).await;
            });
            let billing_pool = pool.clone();
            tokio::spawn(async move {
                billing::spawn_billing_worker(billing_pool).await;
            });
            let webhook_pool = pool.clone();
            tokio::spawn(async move {
                webhooks::spawn_dispatcher(webhook_pool).await;
            });
            spawn_log_retention_pruner(pool.clone());
            spawn_chat_pubsub(has_redis);
            spawn_presence_sweeper(pool, cache);
        }
        RuntimeRole::Api => {
            // The dispatcher is a cheap DB poller, so the API container can
            // deliver events without a separate worker container. Safe to run
            // concurrently with `All` because claims use FOR UPDATE SKIP LOCKED.
            let webhook_pool = pool.clone();
            tokio::spawn(async move {
                webhooks::spawn_dispatcher(webhook_pool).await;
            });
            spawn_log_retention_pruner(pool.clone());
            spawn_chat_pubsub(has_redis);
            spawn_presence_sweeper(pool, cache);
        }
    }
}

/// Reap stale chat sessions from the Redis presence set and announce those
/// users offline. Redis-only: single-instance offline is announced inline on
/// disconnect (see `chat::presence`), so this is a no-op without a cache.
fn spawn_presence_sweeper(pool: &PgPool, cache: &Option<Cache>) {
    if let Some(cache) = cache {
        crate::chat::presence::spawn_sweeper(pool.clone(), cache.clone());
    }
}

/// Re-arm Gmail `users.watch` for mailboxes whose watch is missing or within 24h
/// of expiry, so new mail keeps pushing to Pub/Sub. No-op when `GMAIL_PUSH_TOPIC`
/// is unset — the 30s poll still covers those accounts.
fn spawn_gmail_watch_renewer(pool: PgPool) {
    tokio::spawn(async move {
        // Warm-up delay so the token and DB paths are ready.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            if crate::config::gmail_push_topic().is_some()
                && let Err(e) = renew_gmail_watches(&pool).await
            {
                warn!(target: "worker", error = ?e, "gmail watch renewal cycle failed");
            }
            // Watches live at most 7 days; 6h renews with comfortable margin.
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

async fn renew_gmail_watches(pool: &PgPool) -> crate::prelude::Result<()> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT id, refresh_token FROM email_accounts \
          WHERE provider = 'google' AND access_token IS NOT NULL \
            AND refresh_token IS NOT NULL AND refresh_token <> '' \
            AND (watch_expires_at IS NULL OR watch_expires_at < NOW() + INTERVAL '24 hours')",
    )
    .fetch_all(pool)
    .await?;
    for row in rows {
        let id: i32 = row.get("id");
        let refresh_token: String = row.try_get("refresh_token").unwrap_or_default();
        if refresh_token.trim().is_empty() {
            continue;
        }
        match crate::email::provider::refresh_and_persist_email_token(
            pool,
            id,
            crate::email::provider::MailProvider::Google,
            &refresh_token,
        )
        .await
        {
            Ok(token) => {
                if let Err(e) =
                    crate::email::gmail_push::start_watch(pool, id, &token.access_token).await
                {
                    warn!(target: "worker", account_id = id, error = ?e, "gmail watch arm failed");
                }
            }
            Err(e) => {
                warn!(target: "worker", account_id = id, error = ?e, "gmail watch: token refresh failed")
            }
        }
    }
    Ok(())
}

/// Prune the append-only log streams daily, bounding `activity_events`
/// (`ACTIVITY_RETENTION_DAYS`) and `audit_logs` (`AUDIT_RETENTION_DAYS`, both
/// default 7). The short audit window is a deliberate data-minimization choice:
/// anything needing longer retention is shipped off via the SIEM forward in
/// `routes/audit.rs` before it ages out.
///
/// The window is bound as a `make_interval` parameter rather than formatted into
/// the SQL, so the config value can never inject. Tables are pruned
/// independently so a failure on one doesn't skip the other.
fn spawn_log_retention_pruner(pool: PgPool) {
    // Resolved once at startup; an env change takes effect on the next restart.
    let tables: [(&str, i32); 2] = [
        ("activity_events", crate::config::activity_retention_days()),
        ("audit_logs", crate::config::audit_retention_days()),
    ];
    tokio::spawn(async move {
        loop {
            for (table, retention_days) in tables {
                let query = format!(
                    "DELETE FROM {table} WHERE created_at < NOW() - make_interval(days => $1)"
                );
                if let Err(e) = sqlx::query(&query)
                    .bind(retention_days)
                    .execute(&pool)
                    .await
                {
                    tracing::warn!(target: "activity", table, retention_days, error = ?e, "log retention prune failed");
                }
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

/// Cross-instance realtime fan-out: subscribe to the `ws:user:*` pub/sub
/// channels so chat frames published by any backend instance reach the socket
/// held here. No-op without Redis (local delivery still works).
fn spawn_chat_pubsub(has_redis: bool) {
    if has_redis {
        tokio::spawn(crate::chat::pubsub::run_subscriber());
    }
}

/// Connect to Redis and install the RBAC role-context cache. Best-effort: Redis
/// is a cache, not a dependency, so the app keeps running with `None` if it is
/// down and every read falls back to the DB path.
pub async fn connect_redis_and_install_cache() -> Option<Cache> {
    let redis_cache = match Cache::connect().await {
        Ok(c) => {
            info!("Connected to Redis");
            Some(c)
        }
        Err(e) => {
            warn!("Redis unavailable, caching disabled ({e:?})");
            None
        }
    };

    rbac_cache::install(redis_cache.clone());

    redis_cache
}

/// Load the offline GeoLite2-City database (best-effort). Returns `None` when
/// `GEOIP_DB_PATH` is unset or the file can't be read — the User Logs page then
/// shows blank locations instead of failing.
pub fn load_geoip() -> Option<crate::geoip::GeoIp> {
    match config::geoip_db_path() {
        Some(path) => crate::geoip::GeoIp::open(&path),
        None => {
            info!("GEOIP_DB_PATH unset; IP geolocation disabled");
            None
        }
    }
}

/// Build the CORS layer. The allowlist is a single origin read from
/// `FRONTEND_URL`; multi-origin support needs a rework here. Credentials are
/// enabled so the auth cookie survives.
pub fn build_cors(frontend_url: &str) -> Cors {
    Cors::default()
        .allowed_origin(frontend_url)
        .allowed_methods(vec!["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
        .allowed_headers(vec![
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::HeaderName::from_static("x-request-id"),
        ])
        .expose_headers(vec![header::HeaderName::from_static("x-has-more")])
        .supports_credentials()
}
