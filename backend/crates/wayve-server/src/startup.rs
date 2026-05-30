use crate::ai;
use crate::call;
use crate::chat;
use crate::drive;
use crate::email;
use crate::notes;
use crate::routes;
use crate::scheduler;
use crate::tasks;
use actix_web::web;
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
        // Rename the legacy `files` table to `drive_files`. Idempotent:
        // only fires when the old table is present and the new one isn't.
        // PK, sequence, and indexes are renamed alongside since
        // ALTER TABLE RENAME doesn't propagate to owned objects.
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
        // Subject at-rest encryption — same envelope shape as body_*.
        // New writes go through email::repo which populates these and
        // leaves `subject` NULL; legacy plaintext rows are migrated by
        // email::repo::backfill_subjects at startup.
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS subject_encrypted TEXT",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS subject_iv TEXT",
        // Provider labels (Gmail labelIds + Outlook categories + synthetic
        // IMPORTANT for Outlook importance=high). Used by the sidebar
        // category folders. Backfills as `{}` for legacy rows; new syncs
        // populate. GIN index keeps `<label> = ANY(labels)` index-scanned.
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}'",
        "CREATE INDEX IF NOT EXISTS idx_emails_labels ON emails USING GIN (labels)",
        // Plan A Phase 2 — Wayve-to-Wayve native channel. `source` tags
        // the provenance of each row so the list query knows whether to
        // join through email_accounts (imap/gmail/outlook) or scan by
        // recipient_user_id (wayve). recipient_user_id is the owner of a
        // 'wayve'-source row when account_id is NULL — the send-internal
        // path inserts one row per recipient with their user_id stamped
        // here. Same definitions live in init.sql; mirrored here for
        // already-running deployments.
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'imap'",
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS recipient_user_id INTEGER \
         REFERENCES users(id) ON DELETE CASCADE",
        "CREATE INDEX IF NOT EXISTS idx_emails_recipient_user_id \
         ON emails(recipient_user_id, created_at DESC) \
         WHERE recipient_user_id IS NOT NULL",
        // Widen the body-worker partial index to match the worker's full
        // predicate: missing body OR pending attachment verification. The
        // CREATE INDEX IF NOT EXISTS clause is a no-op when the index
        // already exists with the old predicate, so we DROP first. Safe
        // to re-run; takes a few ms on any inbox.
        "DROP INDEX IF EXISTS idx_emails_pending_body",
        "CREATE INDEX IF NOT EXISTS idx_emails_pending_body \
         ON emails (account_id, id) \
         WHERE body_encrypted = '' OR body_encrypted IS NULL OR attachments_checked = false",
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS display_name TEXT",
        // Provider-reported unread count for the inbox label/folder. NULL
        // until the first sync writes it; the SELECT in `load_account_summaries_for_user`
        // falls back to a local COUNT during that window.
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider_unread_count INTEGER",
        // Adaptive-backoff signal for the sync worker. Stamped on every
        // upsert that inserts a fresh row; the worker reads it to decide
        // whether this account should be polled every 30s (hot), 60s
        // (warm), 5min (cool), or 30min (cold).
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP",
        // Backfill once: existing DBs deployed before adaptive-backoff
        // shipped have NULL last_message_at, which would force every
        // account into the cold (30min) bucket. Seed from the actual
        // max(created_at) per account. Idempotent — only touches NULL
        // rows, so it's a no-op on every subsequent boot.
        "UPDATE email_accounts a \
         SET last_message_at = sub.last_at \
         FROM (SELECT account_id, MAX(created_at) AS last_at FROM emails GROUP BY account_id) sub \
         WHERE a.id = sub.account_id AND a.last_message_at IS NULL",
        // Drive folders. The new table + the FK column on drive_files
        // self-heal existing DBs on backend startup so a deployed instance
        // picks up the v1 folder feature without a manual psql step.
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
        // Partial unique indexes that prevent duplicate active subscriptions
        // for the same user or organization. Stripe webhooks can race during
        // plan upgrades; without this guard `current_plan_for_user` would
        // non-deterministically pick whichever row has the higher id.
        // `CREATE UNIQUE INDEX IF NOT EXISTS` is idempotent BUT will fail
        // outright if the table already contains duplicate active rows —
        // the existing `warn!` handler in this loop will log that and
        // continue, so an operator can spot it and clean up the dupes by
        // canceling the older one. Doing the cleanup automatically here
        // would risk overwriting actual subscription state.
        "CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_user_uniq \
         ON subscriptions(user_id) \
         WHERE status = 'active' AND user_id IS NOT NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_org_uniq \
         ON subscriptions(organization_id) \
         WHERE status = 'active' AND organization_id IS NOT NULL",
        // Self-heal accounts that connected before `last_sync` was stamped on
        // INSERT — NULL forces the sync worker into a full-mailbox crawl on
        // every tick, which can never finish for large mailboxes. The
        // on-connect backfill has already pulled the recent history, so it's
        // safe to seed the cursor to NOW.
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
        // ────────────────────────────────────────────────────────────────
        // Shared inboxes (multi-tenant). The email/account queries JOIN
        // against these tables on every /api/emails and /api/accounts
        // call — without the self-heal here those endpoints 500 on any
        // pre-existing DB that hasn't had `db-reset` run since the
        // feature shipped.
        // ────────────────────────────────────────────────────────────────
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
        // ────────────────────────────────────────────────────────────────
        // Recovery seed: server-side wrapped private key. Encrypted with
        // PBKDF2(mnemonic) → AES-GCM; opaque to the server. One row per
        // user; PUT overwrites. See backend/src/routes/recovery.rs and
        // frontend/src/crypto/recovery.ts for the wire format.
        // ────────────────────────────────────────────────────────────────
        "CREATE TABLE IF NOT EXISTS user_wrapped_keys (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            v INTEGER NOT NULL,
            iv TEXT NOT NULL,
            pub_key TEXT NOT NULL,
            ct TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        // ────────────────────────────────────────────────────────────────
        // Threaded channel replies: parent_message_id points at the top
        // of a thread. Top-level messages have parent_message_id IS NULL.
        // Indexed for fast reply-count and replies-of-parent fetches.
        // ────────────────────────────────────────────────────────────────
        "ALTER TABLE channel_messages \
         ADD COLUMN IF NOT EXISTS parent_message_id INT \
         REFERENCES channel_messages(id) ON DELETE CASCADE",
        "CREATE INDEX IF NOT EXISTS idx_channel_messages_parent \
         ON channel_messages (parent_message_id) \
         WHERE parent_message_id IS NOT NULL",
        // ────────────────────────────────────────────────────────────────
        // Recovery mode + envelope. Same ALTERs live in init.sql, but
        // init.sql only runs on a fresh Postgres volume — populated
        // prod DBs need the self-heal here or /api/me + registration
        // 500 on the new column reference.
        // ────────────────────────────────────────────────────────────────
        // Plan A: collapsed to 'full' only. Any 'basic' / 'password_only'
        // legacy rows are pinned to 'full' here so the tighter CHECK
        // installs cleanly; the AuthContext picks them up on next login,
        // generates a fresh mnemonic, wraps the on-device RSA key and
        // nulls out private_key_encrypted/_iv so the mnemonic is the
        // only path back in. See init.sql for the same migration.
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mode TEXT NOT NULL DEFAULT 'full'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_encrypted TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_iv TEXT",
        "UPDATE users SET recovery_mode = 'full' WHERE recovery_mode <> 'full'",
        "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_recovery_mode_check",
        "ALTER TABLE users ADD CONSTRAINT users_recovery_mode_check \
         CHECK (recovery_mode = 'full')",
        // ────────────────────────────────────────────────────────────────
        // OIDC SSO (multi-tenant). One IdP config row per org;
        // allowed_domain routes alice@acme.com → Acme's IdP. The
        // sso_states row binds PKCE + nonce to the in-flight code so a
        // stolen `code` alone can't be exchanged.
        // ────────────────────────────────────────────────────────────────
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
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'in_progress'",
        "ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check",
        "ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('in_progress', 'done'))",
        "CREATE INDEX IF NOT EXISTS idx_tasks_user_priority \
         ON tasks(user_id, priority DESC, created_at DESC)",
        // ────────────────────────────────────────────────────────────────
        // Payroll. Lives next to the Stripe billing projection but is
        // independent of it — employees aren't always Wayve users
        // (contractors, hires before account creation) so user_id is
        // nullable. `payroll_run_items.employee_name` denormalizes the
        // employee name at run time so a historical run still reads
        // correctly even if the employee row is later renamed or
        // terminated.
        // ────────────────────────────────────────────────────────────────
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
        // ────────────────────────────────────────────────────────────────
        // Outbound webhooks. Customers subscribe to platform events; the
        // dispatcher worker delivers signed JSON envelopes with retry.
        //
        // `secret` is opaque high-entropy bytes used as the HMAC-SHA256
        // key. Stored hex; revealed exactly once at creation.
        //
        // `org_wide = true` requires `organization_id` to be set and
        // delivers events for ALL members of that org, not just the
        // creator. Mirrors how api_keys work for shared org integrations.
        // ────────────────────────────────────────────────────────────────
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
        // Delivery queue + audit. `next_attempt_at` drives the dispatcher
        // poll; `status = pending AND next_attempt_at <= NOW()` is the
        // worker's pickup predicate. Partial index keeps it cheap.
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
        // ────────────────────────────────────────────────────────────────
        // Rate-limit tiers. Each plan now carries its own API rate ceiling
        // and a rolling 30-day monthly request budget. -1 = unlimited. The
        // middleware reads these per request through a short Redis cache.
        //
        // Backfill uses INSERT … ON CONFLICT to land the v1 tier numbers
        // (basic / advance / organization / enterprise) without disturbing
        // any operator-edited rows.
        // ────────────────────────────────────────────────────────────────
        "ALTER TABLE plans ADD COLUMN IF NOT EXISTS rate_limit_per_min \
         INTEGER NOT NULL DEFAULT 60",
        "ALTER TABLE plans ADD COLUMN IF NOT EXISTS monthly_quota \
         INTEGER NOT NULL DEFAULT 50000",
        // basic_user keeps the column DEFAULTs (60, 50000) — skipped here.
        "UPDATE plans SET rate_limit_per_min = 300,   monthly_quota = 500000    \
         WHERE code = 'advance_user'",
        "UPDATE plans SET rate_limit_per_min = 600,   monthly_quota = 5000000   \
         WHERE code = 'organization'",
        "UPDATE plans SET rate_limit_per_min = 6000,  monthly_quota = -1        \
         WHERE code = 'enterprise'",
        // ────────────────────────────────────────────────────────────────
        // SCIM 2.0 provisioning.
        //
        // Each organization that wants IdP-driven provisioning mints a
        // bearer token here. The token's `token_hash` is SHA-256; the raw
        // value is shown once at creation. `external_id` lives on `users`
        // (sparse — only IdP-managed users carry one) and is the
        // SCIM-spec stable identifier the IdP keys on.
        // ────────────────────────────────────────────────────────────────
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
        // Plan A: per-user 1 GiB ciphertext quota across emails, chat,
        // drive, tasks, calendar, notes. Same definition lives in
        // init.sql; mirrored here for already-running deployments.
        "CREATE TABLE IF NOT EXISTS user_storage_usage (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            bytes_used BIGINT NOT NULL DEFAULT 0,
            bytes_quota BIGINT NOT NULL DEFAULT 1073741824,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT user_storage_usage_nonneg_chk CHECK (bytes_used >= 0 AND bytes_quota >= 0)
        )",
        // Plan A Phase 3 — secure-send magic-link table. The server
        // stores only opaque ciphertext + wrapped key + per-message
        // PBKDF2 salt; it never sees the passphrase the recipient
        // needs. Same definition lives in init.sql; mirrored here for
        // already-running deployments.
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
    ];

    for statement in statements {
        if let Err(e) = sqlx::query(statement).execute(pool).await {
            warn!(error = ?e, "email schema compatibility check failed");
        }
    }
}

#[instrument(target = "startup", skip(cfg))]
#[allow(dead_code)]
pub fn configure_app(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api")
            .configure(routes::routes)
            .configure(email::routes)
            .configure(chat::routes)
            .configure(scheduler::routes)
            .configure(drive::routes)
            .configure(notes::routes)
            .configure(tasks::routes)
            .configure(ai::routes),
    )
    .configure(email::public_routes)
    .configure(chat::ws_routes)
    .configure(call::routes);
}
