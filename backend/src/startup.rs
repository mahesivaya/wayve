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
        "ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT TRUE",
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS display_name TEXT",
        // Provider-reported unread count for the inbox label/folder. NULL
        // until the first sync writes it; the SELECT in `load_account_summaries_for_user`
        // falls back to a local COUNT during that window.
        "ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider_unread_count INTEGER",
        // Drive folders. The new table + the FK column on files self-heal
        // existing DBs on backend startup so a deployed instance picks up
        // the v1 folder feature without a manual psql step.
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
        "ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_id BIGINT \
         REFERENCES folders(id) ON DELETE CASCADE",
        "CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id)",
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
        "ALTER TABLE files ADD COLUMN IF NOT EXISTS file_iv TEXT",
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
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mode TEXT NOT NULL DEFAULT 'full'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_encrypted TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_iv TEXT",
        "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_recovery_mode_check",
        "ALTER TABLE users ADD CONSTRAINT users_recovery_mode_check \
         CHECK (recovery_mode IN ('basic', 'full', 'password_only'))",
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
