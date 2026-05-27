CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    public_key TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Profile fields. Idempotent: safe to re-run on an existing DB.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;

-- Google signup support: password is NULL for users who registered via OAuth.
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local';

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;

-- Recovery-phrase mode chosen at signup.
--   'basic'          — easy mode. Server holds an AES-GCM(AES_KEY)
--                      encrypted copy of the user's RSA private key
--                      (users.private_key_encrypted/_iv) and ships it
--                      back to the browser on login over TLS, so the
--                      user can sign in from any device with just
--                      email + password. No mnemonic, no recovery
--                      page. Server-trust tier: the server CAN read
--                      the user's content.
--   'full'           — server stores an AES-GCM envelope of the user's RSA
--                      private key, wrapped by a 24-word mnemonic. New-
--                      device restore via /recover unlocks chat/notes/
--                      files history. Server cannot read the user's
--                      content.
--   'password_only'  — server only stores a credential blob (random
--                      bytes wrapped by the mnemonic) used to verify
--                      mnemonic possession for /recover-with-mnemonic
--                      password reset. The user's private key never
--                      leaves the device; encrypted history does NOT
--                      follow them to new devices.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mode TEXT NOT NULL DEFAULT 'full';
ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_iv TEXT;
-- Drop any older CHECK before re-adding, so re-running init.sql after
-- adding 'basic' to the allowed set doesn't fail with "constraint
-- already exists" or "value violates check constraint".
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_recovery_mode_check'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_recovery_mode_check;
  END IF;
END $$;
ALTER TABLE users
  ADD CONSTRAINT users_recovery_mode_check
  CHECK (recovery_mode IN ('basic', 'full', 'password_only'));

-- Account-type renames: the role strings were renamed
--   project_admin  -> platform_admin
--   business_admin -> organization_admin
--   business       -> organization
-- normalized_account_type() no longer recognizes the old strings, so any
-- legacy row must be migrated or it silently drops to 'personal'. Each UPDATE
-- is a no-op once every row is migrated, so init.sql stays idempotent.
UPDATE users SET account_type = 'platform_admin'     WHERE account_type = 'project_admin';
UPDATE users SET account_type = 'organization_admin' WHERE account_type = 'business_admin';
UPDATE users SET account_type = 'organization'       WHERE account_type = 'business';

CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INT REFERENCES organizations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx
    ON users (username) WHERE username IS NOT NULL;

-- Per-organization URL/email slug, e.g. "Acme Corp" -> "acmecorp". Drives both the
-- organization email domain (<slug>.com) and the /organization/<slug> home-page route.
-- The backfill mirrors the Rust slugify() (lowercase, ASCII-alphanumeric only)
-- and is a no-op once every row has a slug, so init.sql stays idempotent.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS slug TEXT;
UPDATE organizations
   SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g'))
 WHERE slug IS NULL OR slug = '';
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_unique_idx
    ON organizations (slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS organization_members (
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, user_id),
    CONSTRAINT organization_members_role_chk CHECK (
        role IN ('owner', 'super_admin', 'admin', 'security', 'billing', 'developer', 'support', 'member', 'guest')
    )
);

ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS organization_members_role_chk;
ALTER TABLE organization_members ADD CONSTRAINT organization_members_role_chk CHECK (
    role IN ('owner', 'super_admin', 'admin', 'security', 'billing', 'developer', 'support', 'member', 'guest')
);

INSERT INTO organization_members (organization_id, user_id, role)
SELECT organization_id, id,
       CASE
           WHEN account_type = 'organization_admin' THEN 'owner'
           ELSE 'member'
       END
FROM users
WHERE organization_id IS NOT NULL
ON CONFLICT (organization_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_members (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT platform_members_role_chk CHECK (
        role IN ('owner', 'super_admin', 'admin', 'security', 'billing', 'developer', 'support', 'member', 'guest')
    )
);

ALTER TABLE platform_members DROP CONSTRAINT IF EXISTS platform_members_role_chk;
ALTER TABLE platform_members ADD CONSTRAINT platform_members_role_chk CHECK (
    role IN ('owner', 'super_admin', 'admin', 'security', 'billing', 'developer', 'support', 'member', 'guest')
);

INSERT INTO platform_members (user_id, role)
SELECT id, 'owner'
FROM users
WHERE account_type = 'platform_admin'
ON CONFLICT (user_id) DO NOTHING;

-- Password reset tokens. Single-use, 30-minute lifetime.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
    ON password_reset_tokens(user_id);

-- OAuth authorization-code state. State values are opaque, single-use, and
-- short lived; JWTs must never be sent through provider redirects.
CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    flow TEXT NOT NULL DEFAULT 'connect',
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE oauth_states ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS flow TEXT NOT NULL DEFAULT 'connect';
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE oauth_states
SET expires_at = NOW() + INTERVAL '10 minutes'
WHERE expires_at IS NULL;
ALTER TABLE oauth_states ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- =========================================================================
-- OIDC SSO (multi-tenant: each organization brings its own IdP)
-- =========================================================================
-- One IdP config per organization. The client_secret is AES-GCM encrypted at
-- rest using the same security/encryption.rs helpers as everything else.
-- `allowed_domain` is the email domain that routes users to this config
-- (alice@acme.com -> Acme's IdP); it is UNIQUE so a domain can't be claimed
-- by two organizations simultaneously.
CREATE TABLE IF NOT EXISTS org_sso_configs (
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
);
CREATE INDEX IF NOT EXISTS idx_org_sso_configs_domain
    ON org_sso_configs(allowed_domain);

-- In-flight authorization-code state for the OIDC redirect dance. PKCE
-- verifier + nonce are bound to the state so a stolen `code` alone can't be
-- exchanged. Single-use, 10-minute lifetime; the callback DELETEs the row
-- after looking it up.
CREATE TABLE IF NOT EXISTS sso_states (
    state TEXT PRIMARY KEY,
    sso_config_id INTEGER NOT NULL REFERENCES org_sso_configs(id) ON DELETE CASCADE,
    pkce_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    return_to TEXT,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SSO identity link on users. `sso_sub` is the IdP's stable subject claim,
-- which is what we look up by (email can change in the IdP; sub doesn't).
-- `sso_org_id` records which org's SSO this user authenticates via —
-- enforced separately from `organization_id` so the link is auditable
-- even if the user is later removed from the org's member list.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_sso_identity_unique_idx
    ON users (sso_org_id, sso_sub)
    WHERE sso_sub IS NOT NULL;

-- Per-user password expiry. NULL = never expires (every existing user
-- gets this default, so the new column is a no-op for them). When set
-- to a future timestamp, the login handler refuses to issue a JWT after
-- now() > password_valid_until, and the JWT it does issue is clamped
-- so its `exp` claim never outlives `password_valid_until`. Used today
-- for short-lived guest accounts seeded with a 24h window.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_valid_until TIMESTAMPTZ;

-- Customizable theme. Stores the serialized ThemeChoice from the frontend's
-- theme customizer (`{ kind: "preset"|"custom"|"default", ... }`). NULL means
-- the user has never customized — the app falls back to the stylesheet default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_json TEXT;



CREATE TABLE IF NOT EXISTS email_accounts (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT,
    user_id INTEGER NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    token_expiry TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    last_sync BIGINT,
    created_at TIMESTAMP DEFAULT NOW(),

    -- 🔐 Constraints
    CONSTRAINT fk_user_accounts
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

-- Mail provider for a connected mailbox: 'google' (Gmail API) or 'microsoft'
-- (Outlook / Microsoft Graph). The sync worker branches on this column.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'google';
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Authoritative unread count fetched from the provider (Gmail INBOX label or
-- Outlook inbox mailFolder). Reflects ALL unread mail in the user's inbox,
-- not just what's been synced into our `emails` table. NULL until the first
-- successful sync — `load_account_summaries_for_user` falls back to a local
-- COUNT in that window so the badge isn't blank.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS provider_unread_count INTEGER;

-- =========================================================================
-- Shared inboxes (org + platform).
-- =========================================================================
-- An email_account is "shared" when an admin marks it so. The owner-user
-- (user_id) keeps their connection; additionally, other users listed in
-- shared_inbox_members can read/reply on the account. `organization_id`
-- distinguishes scope: NULL = platform-level shared inbox (only platform
-- staff can be members); set = org-level (org members eligible).
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS organization_id INTEGER
    REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE;
-- Human label for the inbox (e.g. "Support", "Sales"). Falls back to the
-- email address when unset.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS shared_label TEXT;

CREATE TABLE IF NOT EXISTS shared_inbox_members (
    account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_reply BOOLEAN NOT NULL DEFAULT TRUE,
    can_manage BOOLEAN NOT NULL DEFAULT FALSE,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_inbox_members_user ON shared_inbox_members(user_id);

CREATE TABLE IF NOT EXISTS emails (
    id SERIAL PRIMARY KEY,
    gmail_id TEXT NOT NULL,
    account_id INTEGER REFERENCES email_accounts(id) ON DELETE CASCADE,
    subject TEXT,
    sender TEXT,
    receiver TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    body_encrypted TEXT,
    body_iv TEXT,
    body_cached TEXT,
    body_cached_at TIMESTAMP,
    is_read BOOLEAN DEFAULT FALSE,
    attachments_checked BOOLEAN DEFAULT FALSE,
    UNIQUE(account_id, gmail_id)
);

ALTER TABLE emails ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;

-- Subject at rest (AES-256-GCM, same envelope as body_*). The legacy
-- plaintext `subject` column stays for compat during the migration window;
-- the email repo writes only to the encrypted pair on new INSERTs, and
-- `email::repo::backfill_subjects` walks the legacy rows on startup.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS subject_encrypted TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS subject_iv TEXT;

-- Provider labels attached to the message (Gmail labelIds, Outlook
-- categories, plus a synthetic IMPORTANT for Outlook importance=high).
-- Filtered by the inbox sidebar's category folders (Important / Updates /
-- Social). Empty array `'{}'` for pre-existing rows; sync populates new
-- ones. The GIN index makes `<label> = ANY(labels)` lookups index-scans.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_emails_labels ON emails USING GIN (labels);

-- Per-email help-desk workflow state. Created lazily on first state
-- mutation (status change or assignment) so we don't have to backfill rows
-- for every existing email when an account becomes shared.
CREATE TABLE IF NOT EXISTS shared_inbox_email_state (
    email_id INTEGER PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_inbox_state_assignee
    ON shared_inbox_email_state(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shared_inbox_state_status
    ON shared_inbox_email_state(status);

CREATE TABLE IF NOT EXISTS email_attachments (
    id SERIAL PRIMARY KEY,
    email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    gmail_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT,
    size BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(email_id, attachment_id)
);




-- 1. Remove old wrong constraint (if exists)
ALTER TABLE email_accounts
ADD CONSTRAINT unique_user_email UNIQUE (user_id, email);



CREATE TABLE IF NOT EXISTS meetings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    zoom_join_url TEXT,
    title_encrypted TEXT,
    title_iv TEXT,
    zoom_join_url_encrypted TEXT,
    zoom_join_url_iv TEXT,

    CONSTRAINT fk_user_meetings
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS zoom_join_url TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS title_encrypted TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS title_iv TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS zoom_join_url_encrypted TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS zoom_join_url_iv TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'wayve';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS google_event_id TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS account_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS meetings_google_event_uniq
  ON meetings(user_id, google_event_id) WHERE google_event_id IS NOT NULL;

CREATE TABLE meeting_participants (
    id SERIAL PRIMARY KEY,
    meeting_id INT REFERENCES meetings(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    email_encrypted TEXT,
    email_iv TEXT,
    user_id INT NULL,   -- if exists in your system
    status TEXT DEFAULT 'pending'
);

ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS email_encrypted TEXT;
ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS email_iv TEXT;


DO $$ BEGIN
    CREATE TYPE message_status AS ENUM ('sent', 'delivered', 'read');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;


CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    sender_id INT REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INT REFERENCES users(id) ON DELETE CASCADE,
    content_encrypted TEXT,
    content_iv TEXT,
    status message_status DEFAULT 'sent',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channels (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    created_by INT REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id INT REFERENCES channels(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'user',
    joined_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

UPDATE channel_members cm
SET role = 'admin'
FROM channels c
WHERE c.id = cm.channel_id AND c.created_by = cm.user_id;

CREATE TABLE IF NOT EXISTS channel_join_requests (
    channel_id INT REFERENCES channels(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS channel_invites (
    id SERIAL PRIMARY KEY,
    channel_id INT REFERENCES channels(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    invited_by INT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(channel_id, email)
);

CREATE TABLE IF NOT EXISTS channel_messages (
    id SERIAL PRIMARY KEY,
    channel_id INT REFERENCES channels(id) ON DELETE CASCADE,
    sender_id INT REFERENCES users(id) ON DELETE CASCADE,
    content_encrypted TEXT,
    content_iv TEXT,
    parent_message_id INT REFERENCES channel_messages(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS drive_files (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    file_type TEXT,
    file_path TEXT NOT NULL,
    file_iv TEXT,
    size BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE,

    -- Foreign key constraint
    CONSTRAINT fk_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);

ALTER TABLE drive_files ADD COLUMN IF NOT EXISTS file_iv TEXT;

-- Drive folders. One row per user-created folder. `parent_folder_id` is
-- NULL for folders at the user's drive root; otherwise it points at the
-- containing folder. Deleting a parent cascades to all children + files
-- (see the `drive_files.folder_id` FK below).
CREATE TABLE IF NOT EXISTS folders (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_folder_id BIGINT REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folders_user_parent
    ON folders(user_id, parent_folder_id);

-- Attach a file to a folder. NULL = at the drive root. ON DELETE CASCADE
-- removes the file row when its containing folder is deleted; the
-- on-disk blob is then garbage-collected on next sweep (or left orphan
-- until a maintenance pass — fine for v1).
ALTER TABLE drive_files
    ADD COLUMN IF NOT EXISTS folder_id BIGINT
    REFERENCES folders(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_drive_files_folder ON drive_files(folder_id);

CREATE TABLE IF NOT EXISTS drive_shares (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS drive_shares_unique_idx
    ON drive_shares(resource_type, resource_id, scope, COALESCE(organization_id, 0));
CREATE INDEX IF NOT EXISTS drive_shares_org_idx
    ON drive_shares(organization_id, resource_type, resource_id);

-- Notes
CREATE TABLE IF NOT EXISTS notes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT,
    content TEXT,
    title_encrypted TEXT,
    title_iv TEXT,
    content_encrypted TEXT,
    content_iv TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE notes ADD COLUMN IF NOT EXISTS title_encrypted TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS title_iv TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS content_encrypted TEXT;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS content_iv TEXT;

-- Tasks (personal to-do items). Priority is 1-5, 5 = Highest.
CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'in_progress';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('in_progress', 'done'));

CREATE INDEX IF NOT EXISTS idx_tasks_user_priority ON tasks(user_id, priority DESC, created_at DESC);


-- 🔥 INDEXES

CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages (sender_id, receiver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_reverse
ON messages (receiver_id, sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_unread
ON messages (receiver_id, status);

CREATE INDEX IF NOT EXISTS idx_channel_members_user
ON channel_members (user_id, channel_id);

CREATE INDEX IF NOT EXISTS idx_channel_join_requests_channel
ON channel_join_requests (channel_id, status);

CREATE INDEX IF NOT EXISTS idx_channel_invites_channel
ON channel_invites (channel_id, email);

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created
ON channel_messages (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_messages_parent
ON channel_messages (parent_message_id) WHERE parent_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_emails_account_created
ON emails (account_id, created_at DESC, id DESC);

-- Partial index that backs `body_worker`'s scan for unprocessed rows.
-- The predicate matches the worker's widened scan: any row with a missing
-- body OR pending attachment verification. Once the worker stamps both
-- flags, the row drops out of the index (partial) so steady-state size
-- stays proportional to backlog, not total mail.
CREATE INDEX IF NOT EXISTS idx_emails_pending_body
ON emails (account_id, id)
WHERE body_encrypted = '' OR body_encrypted IS NULL OR attachments_checked = false;

CREATE INDEX IF NOT EXISTS idx_meetings_user_date
ON meetings (user_id, date, start_time);

CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting_id
ON meeting_participants(meeting_id);

CREATE INDEX IF NOT EXISTS idx_email_accounts_user_id
ON email_accounts(user_id);

-- Speed up the per-user storage SUMs in GET /api/profile.
CREATE INDEX IF NOT EXISTS idx_drive_files_user_id ON drive_files(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);

-- ============================================================
-- 💳 BILLING (Stripe)
-- ------------------------------------------------------------
-- A "billing owner" is polymorphic: exactly one of user_id /
-- organization_id is set. Personal accounts are billed as a user;
-- organizations are billed as a whole (paid by the org admin).
-- Membership is NOT a separate table — it is users.organization_id.
-- Local subscription/invoice rows are a projection of Stripe state
-- kept in sync by webhooks; Stripe remains the source of truth.
-- ============================================================

-- Stripe customer mapping, one per billing owner.
CREATE TABLE IF NOT EXISTS billing_customers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    stripe_customer_id TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT billing_customers_owner_chk CHECK (
        (user_id IS NOT NULL AND organization_id IS NULL) OR
        (user_id IS NULL AND organization_id IS NOT NULL)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_user_idx
    ON billing_customers(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_org_idx
    ON billing_customers(organization_id) WHERE organization_id IS NOT NULL;

-- Plan catalog. Managed by platform admins. Amounts are integer minor units
-- (e.g. cents). audience constrains which owner type may subscribe.
CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    audience TEXT NOT NULL DEFAULT 'personal',
    stripe_price_id TEXT,
    amount_cents BIGINT NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    billing_interval TEXT NOT NULL DEFAULT 'month',
    storage_limit_bytes BIGINT NOT NULL DEFAULT 0,
    seat_limit INTEGER NOT NULL DEFAULT 1,
    features JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Baseline catalog. stripe_price_id is filled in by a platform admin once the
-- matching Stripe Price exists. ON CONFLICT keeps init.sql idempotent.
INSERT INTO plans (code, name, description, audience, amount_cents, billing_interval, storage_limit_bytes, seat_limit, features)
VALUES
    ('basic_user', 'Basic User', 'Free personal plan with daily email send/receive limits.', 'personal', 0, 'month', 1073741824, 1,
     '{"emails_per_day":1000,"send_receive_per_day":1000,"autopay":false}'::jsonb),
    ('advance_user', 'Advance User', 'Personal paid plan with encrypted app usage allowance.', 'personal', 700, 'month', 10737418240, 1,
     '{"encrypt_decrypt_per_day":1000,"autopay":true}'::jsonb),
    ('organization', 'Organization', '1-100 users with unlimited email send/receive and unlimited memory.', 'organization', 1000, 'month', -1, 100,
     '{"per_user":true,"min_users":1,"max_users":100,"unlimited_email":true,"unlimited_memory":true,"autopay":true}'::jsonb),
    ('enterprise', 'Enterprise', '100+ users with unlimited emails and memory. Contact sales.', 'organization', 0, 'month', -1, 100000,
     '{"min_users":101,"unlimited_email":true,"unlimited_memory":true,"contact_sales":true,"autopay":true}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- Subscriptions: local projection of Stripe subscription state.
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    stripe_subscription_id TEXT UNIQUE,
    stripe_customer_id TEXT,
    status TEXT NOT NULL DEFAULT 'incomplete',
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT subscriptions_owner_chk CHECK (
        (user_id IS NOT NULL AND organization_id IS NULL) OR
        (user_id IS NULL AND organization_id IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS subscriptions_org_idx ON subscriptions(organization_id);

-- Partial unique indexes: a given user (or organization) can only have one
-- *active* subscription at a time. Stripe webhooks can race during plan
-- upgrades and try to insert a new active row before the old one is marked
-- canceled — without this guard you'd silently end up with two active rows,
-- and `current_plan_for_user` would non-deterministically pick whichever
-- has the higher id. The constraint scoped to `WHERE status = 'active'`
-- still lets the historical canceled / incomplete / past_due rows pile up
-- normally.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_user_uniq
    ON subscriptions(user_id)
    WHERE status = 'active' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_active_org_uniq
    ON subscriptions(organization_id)
    WHERE status = 'active' AND organization_id IS NOT NULL;

-- Invoices: local projection of Stripe invoices.
CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    stripe_invoice_id TEXT NOT NULL UNIQUE,
    stripe_customer_id TEXT,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    amount_due_cents BIGINT NOT NULL DEFAULT 0,
    amount_paid_cents BIGINT NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'draft',
    hosted_invoice_url TEXT,
    invoice_pdf TEXT,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices(stripe_customer_id);

-- Raw usage events for metered billing and the Usage UI.
CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    metric TEXT NOT NULL,
    quantity BIGINT NOT NULL DEFAULT 0,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_events_user_idx
    ON usage_events(user_id, metric, recorded_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_org_idx
    ON usage_events(organization_id, metric, recorded_at DESC);

-- Materialized effective entitlements per billing owner. Refreshed whenever
-- the owner's subscription changes (checkout completion / webhook).
CREATE TABLE IF NOT EXISTS entitlements (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    plan_code TEXT,
    storage_limit_bytes BIGINT NOT NULL DEFAULT 0,
    seat_limit INTEGER NOT NULL DEFAULT 1,
    features JSONB NOT NULL DEFAULT '{}'::jsonb,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT entitlements_owner_chk CHECK (
        (user_id IS NOT NULL AND organization_id IS NULL) OR
        (user_id IS NULL AND organization_id IS NOT NULL)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_user_idx
    ON entitlements(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_org_idx
    ON entitlements(organization_id) WHERE organization_id IS NOT NULL;

-- Webhook idempotency log. A repeated delivery of the same Stripe event id
-- is a no-op (INSERT ... ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS webhook_events (
    id SERIAL PRIMARY KEY,
    stripe_event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 🔑 API KEYS — programmatic access scoped to an organization.
-- ------------------------------------------------------------
-- The raw key is shown to the caller exactly once at creation;
-- only its SHA-256 hash is stored. key_hash is UNIQUE so
-- validation is a single indexed lookup (never a scan). API
-- keys are high-entropy tokens, so a fast hash is correct here
-- — unlike passwords, which need bcrypt. key_preview is a
-- redacted form safe to display in the UI.
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_preview TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(organization_id);

-- API key auth system: a key acts as a specific user (user_id), constrained by
-- scopes / rate limit / expiry. key_type 'internal' may hold the '*' scope;
-- 'external' must enumerate scopes and carry an expiry.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_type TEXT NOT NULL DEFAULT 'external';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_min INTEGER NOT NULL DEFAULT 120;
-- Personal users have no organization, so a key need not belong to one.
ALTER TABLE api_keys ALTER COLUMN organization_id DROP NOT NULL;
-- Pre-API-key-system rows had no acting principal; adopt their creator.
UPDATE api_keys SET user_id = created_by WHERE user_id IS NULL;
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_key_type_chk;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_key_type_chk
    CHECK (key_type IN ('internal', 'external'));
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id);

-- Append-only audit trail of API-key-authenticated requests. api_key_id is
-- nullable so attempts with an unknown key ('invalid') are still recorded.
CREATE TABLE IF NOT EXISTS api_key_audit_log (
    id BIGSERIAL PRIMARY KEY,
    api_key_id INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_key_audit_key_idx
    ON api_key_audit_log(api_key_id, created_at DESC);

-- Scope-aware SIEM forwarding settings. Tokens are AES-GCM encrypted using
-- the backend AES_KEY; NULL token fields mean the webhook does not use bearer
-- authentication.
CREATE TABLE IF NOT EXISTS siem_webhook_configs (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS siem_webhook_platform_uniq
    ON siem_webhook_configs(scope)
    WHERE scope = 'platform';
CREATE UNIQUE INDEX IF NOT EXISTS siem_webhook_org_uniq
    ON siem_webhook_configs(organization_id)
    WHERE scope = 'organization';
CREATE UNIQUE INDEX IF NOT EXISTS siem_webhook_user_uniq
    ON siem_webhook_configs(user_id)
    WHERE scope = 'personal';
