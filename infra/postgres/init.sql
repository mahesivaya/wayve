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
-- Uploaded profile image: server-relative path on disk under ./uploads/avatars/.
-- Served (decrypted, plain) via GET /api/users/{id}/avatar so other members can
-- see it; NULL means "no upload, fall back to the generated initial avatar".
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path TEXT;

-- Plan A: end-to-end encryption is the ONLY mode. Every user's RSA
-- private key is wrapped by a 24-word BIP-39 mnemonic; the server
-- holds the opaque envelope and nothing more. Forget your password →
-- you must produce the mnemonic to reset. Lose both → encrypted
-- content is unrecoverable. By design: no other option.
--
-- The 'basic' and 'password_only' modes have been removed. Any legacy
-- row gets force-migrated to 'full' below; the corresponding
-- private_key_encrypted / private_key_iv server-held copies stay in
-- the schema (still set NULL on new rows) only so older deployments
-- can be re-run against this file without losing data.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mode TEXT NOT NULL DEFAULT 'full';
ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS private_key_iv TEXT;
-- Migrate every legacy row to 'full' BEFORE re-adding the tighter CHECK,
-- otherwise the constraint would refuse to install. AuthContext detects
-- the migration on the next login: the user is shown a fresh 24-word
-- mnemonic, the existing (still-on-device) RSA private key is wrapped
-- under it, and the server-held PKCS8 fallback (private_key_encrypted)
-- is nulled out so the only path back in is the mnemonic.
UPDATE users SET recovery_mode = 'full' WHERE recovery_mode <> 'full';
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_recovery_mode_check'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_recovery_mode_check;
  END IF;
END $$;
ALTER TABLE users
  ADD CONSTRAINT users_recovery_mode_check
  CHECK (recovery_mode = 'full');

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

-- Free-form location string captured at self-serve org creation. Used in the
-- organization setup page (and surfaced in the org home header) so the owner
-- can pin a real-world locale to the workspace. Idempotent ALTER keeps
-- re-running init.sql safe.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS place TEXT;

-- Administrative contact email for the organization, captured on the
-- payment-gated self-serve create flow. Defaults to the founder's personal
-- email in the UI but is editable. Idempotent ALTER keeps re-runs safe.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS admin_email TEXT;
-- When true, this org may create member email addresses on ANY domain — public
-- providers (gmail.com…) and unverified custom domains — bypassing the domain-
-- ownership gate in admin_create_user. Off by default; toggled by the platform
-- owner on /platform/domains. Security-relaxing, so deliberately opt-in.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS allow_unverified_email_domains BOOLEAN NOT NULL DEFAULT false;

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

-- Organization-scoped projects listed in the app sidebar's Workspace group.
-- Projects are polymorphic-owned: exactly one of organization_id / user_id is
-- set. Org projects (organization_id) are created by the org owner and visible
-- to every member of that org; personal & platform accounts own their projects
-- via user_id. A project optionally links ONE *public* GitHub repo
-- (github_owner/github_repo), browsed in the Code Repo viewer. Public repos
-- only — no token is ever stored here; the proxy authorizes per caller.
CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects (organization_id);

-- Polymorphic ownership + repo linkage, applied idempotently so existing DBs
-- (where the CREATE above already ran with organization_id NOT NULL) pick up
-- the new shape. Existing rows have organization_id set / user_id NULL, so they
-- satisfy projects_owner_chk with no back-fill.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id INTEGER
    REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_owner TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo  TEXT;
ALTER TABLE projects ALTER COLUMN organization_id DROP NOT NULL;   -- idempotent
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_owner_chk;
ALTER TABLE projects ADD CONSTRAINT projects_owner_chk CHECK (
    (organization_id IS NOT NULL AND user_id IS NULL) OR
    (organization_id IS NULL AND user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects (user_id);

-- Per-organization feature-access overrides. One row = "this role may use this
-- feature in this org". The presence of ANY row for (organization_id,
-- feature_key) means the owner has configured that feature: only the listed
-- roles are allowed. No rows at all = unconfigured = fall back to the feature's
-- code-defined default role set (see feature_access::FEATURES). The org owner is
-- always allowed regardless of rows, so an owner can't lock themselves out.
CREATE TABLE IF NOT EXISTS organization_feature_access (
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (organization_id, feature_key, role)
);
CREATE INDEX IF NOT EXISTS idx_org_feature_access_lookup
    ON organization_feature_access (organization_id, feature_key);

-- Organization-scoped teams listed in the sidebar's Teams group, each with a
-- detail page at /teams/<slug>. slug is unique within an org and derived from
-- the name (lowercase, ASCII-alphanumeric), mirroring the org slug rule.
CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    -- NULL = a platform-level team (created by a platform owner). Org owners'
    -- teams carry their organization_id.
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    tagline TEXT,
    description TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams (organization_id);
-- Relax NOT NULL on long-lived DBs whose teams table predates platform teams
-- (idempotent — a no-op if already nullable).
ALTER TABLE teams ALTER COLUMN organization_id DROP NOT NULL;
-- UNIQUE(organization_id, slug) does NOT constrain platform teams because NULL
-- orgs compare distinct; enforce slug uniqueness among platform teams here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_platform_slug
    ON teams (slug) WHERE organization_id IS NULL;

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

-- Custom-domain ownership for organizations. An org claims a domain
-- (e.g. acme.com) and proves it controls the DNS by publishing a TXT
-- challenge at `_wayve-challenge.<domain>` containing `wayve-verify=<token>`.
-- Only a VERIFIED row authorizes minting `*@<domain>` member addresses
-- (see admin_create_user). `verified` is flipped by the server after a
-- successful DNS check and is NEVER set directly by the client. UNIQUE on
-- `domain` means at most one org can ever own a given domain — the gate
-- that stops a user creating x@usa.com on a domain they don't control.
CREATE TABLE IF NOT EXISTS organization_domains (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain TEXT NOT NULL UNIQUE,
    verify_token TEXT NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_organization_domains_org
    ON organization_domains(organization_id);

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
-- When true, chat file attachments this user SENDS are end-to-end encrypted
-- (server can't read the body); when false they're encrypted at rest with the
-- server key only. Toggled in Settings by personal accounts and owners.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_encrypt_files BOOLEAN NOT NULL DEFAULT true;



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

-- Wall-clock timestamp of the most-recent message we've received for this
-- account. Drives the sync worker's per-account adaptive backoff: a mailbox
-- whose latest message is hours old is polled less often than one with mail
-- arriving in the last minute. Stamped in `repo::upsert_batch` / `upsert_one`
-- whenever a row is freshly inserted (xmax = 0). Distinct from `last_sync`,
-- which tracks when WE last looked, not when the mailbox last got mail.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP;

-- Generic IMAP/SMTP connection details, used only when provider = 'imap'
-- (any custom-domain mailbox not on Google/Microsoft). NULL for OAuth
-- providers. The IMAP/SMTP password is stored encrypted (AES-256-GCM,
-- `<iv>.<cipher>`) in the existing `refresh_token` column — there's no OAuth
-- refresh token for these accounts. `mail_security` is 'ssl' (implicit TLS)
-- or 'starttls'. The IMAP MailSync impl loads these by account_id.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS imap_host TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS imap_port INTEGER;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS smtp_host TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS smtp_port INTEGER;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS mail_security TEXT;

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

-- Plan A Phase 2 — Wayve-to-Wayve native email channel.
--
-- `source` discriminates how the row got here so the list query knows
-- whether to join through email_accounts (for 'imap'/'gmail'/'outlook')
-- or fall back to `recipient_user_id` (for 'wayve'). Default value
-- keeps every legacy row pinned to 'imap' which is the historical
-- behaviour. CHECK constraint kept lenient — adding a new provider
-- later just requires another value.
--
-- `recipient_user_id` is the owner of a 'wayve'-source row when
-- account_id is NULL. The Wayve-to-Wayve send path inserts one row per
-- recipient with their user_id stamped here; the inbox list query
-- picks up rows belonging to the caller via this column when
-- account_id is unset.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'imap';
ALTER TABLE emails
    ADD COLUMN IF NOT EXISTS recipient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_emails_recipient_user_id
    ON emails(recipient_user_id, created_at DESC)
    WHERE recipient_user_id IS NOT NULL;

-- Subject at rest (AES-256-GCM, same envelope as body_*). The legacy
-- plaintext `subject` column stays for compat during the migration window;
-- the email repo writes only to the encrypted pair on new INSERTs, and
-- `email::repo::backfill_subjects` walks the legacy rows on startup.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS subject_encrypted TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS subject_iv TEXT;

-- Sender/receiver at rest. Same AES-GCM(AES_KEY) envelope as subject_*/body_*.
-- The `*_hash` siblings store an HKDF-keyed HMAC-SHA256 of the lowercased
-- address — used by the Sent-folder filter and any exact-address lookup so
-- queries can compare addresses without decrypting every row. The legacy
-- plaintext `sender` / `receiver` columns stay during the migration window;
-- `email::repo::backfill_addresses` populates these new columns on startup.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS sender_iv TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS sender_encrypted TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS sender_hash TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS receiver_iv TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS receiver_encrypted TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS receiver_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_emails_sender_hash ON emails(sender_hash)
    WHERE sender_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_receiver_hash ON emails(receiver_hash)
    WHERE receiver_hash IS NOT NULL;

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

-- File attachments on direct messages. The blob is always encrypted at rest
-- with the server key (file_iv + on-disk ciphertext). When `e2e` is true the
-- stored bytes are ALSO a client-side ciphertext (decryptable only by the DM
-- participants), so the server can't read the file; when false the at-rest
-- layer is the only encryption. `message_id` is NULL between upload and send,
-- then set to link the attachment to its message.
CREATE TABLE IF NOT EXISTS chat_attachments (
    id BIGSERIAL PRIMARY KEY,
    message_id INT REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id INT REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT,
    size BIGINT NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL,
    file_iv TEXT,
    e2e BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments (message_id);

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

-- Organization Documents — a shared "Documents" workspace dashboard. Unlike
-- drive_files/folders (which are user-owned), these belong to an ORGANIZATION
-- and EVERY member of that org has full read/write/delete access. Files are
-- stored on disk under ./uploads, encrypted with the server at-rest key
-- (wayve_security::encryption) so the server can serve them to any member —
-- no per-user E2E envelope (which would lock out other members).
-- `organization_id` is NULLABLE: a non-null value scopes the row to that
-- organization's shared workspace; NULL is the platform-team-wide shared set
-- (platform staff have no organization). Listing/access resolves the caller's
-- scope and matches with `organization_id IS NOT DISTINCT FROM <scope>`.
CREATE TABLE IF NOT EXISTS org_document_folders (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    parent_folder_id BIGINT REFERENCES org_document_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE org_document_folders ALTER COLUMN organization_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_doc_folders_org_parent
    ON org_document_folders(organization_id, parent_folder_id);

CREATE TABLE IF NOT EXISTS org_documents (
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
);
ALTER TABLE org_documents ALTER COLUMN organization_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_org_documents_org_folder
    ON org_documents(organization_id, folder_id);

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

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'to_do';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('to_do', 'in_progress', 'in_review', 'done'));

-- Free-text "assigned by" / "assignee" attribution (who handed the task over
-- and who it's assigned to). Plain text, optional; empty string when unspecified.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_by TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_tasks_user_priority ON tasks(user_id, priority DESC, created_at DESC);

-- Files attached to a task. Stored under ./uploads encrypted at rest just
-- like drive_files; the on-disk blob is unreferenced (and garbage-collected
-- on next sweep) when the row is deleted by the task cascade.
CREATE TABLE IF NOT EXISTS task_attachments (
    id BIGSERIAL PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    file_type TEXT,
    file_path TEXT NOT NULL,
    file_iv TEXT,
    size BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);

-- ============================================================
-- 🎫 SUPPORT TICKETS
-- ------------------------------------------------------------
-- Lightweight in-app ticketing. Any authenticated user (personal,
-- organization member, platform staff) can raise a ticket from the
-- "Help & Report issue" item in the header profile menu or from the
-- Support section on /settings. Tickets are read & resolved by
-- platform staff holding the `tickets:manage` permission (the
-- `support` role in rbac.rs); replies are sent off-band by email
-- using the ticket's email-of-record. Status moves through
-- open → in_progress → resolved → closed.
-- ============================================================
CREATE TABLE IF NOT EXISTS support_tickets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other'
        CHECK (category IN ('bug', 'feature', 'billing', 'account', 'other')),
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_org ON support_tickets(organization_id, created_at DESC)
    WHERE organization_id IS NOT NULL;

-- Screenshots / files uploaded with the ticket. Mirrors task_attachments:
-- per-row AES-GCM ciphertext blob on disk under ./uploads, base64 IV in DB.
CREATE TABLE IF NOT EXISTS support_ticket_attachments (
    id BIGSERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    file_type TEXT,
    file_path TEXT NOT NULL,
    file_iv TEXT,
    size BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_attachments_ticket
    ON support_ticket_attachments(ticket_id);

-- ============================================================
-- 🪵 ERROR LOGS — centralized client + server error dashboard
-- ------------------------------------------------------------
-- Anything that breaks for a user — JS errors, unhandled promise
-- rejections, 5xx API responses, backend AppError::Internal — gets
-- POSTed to /api/error-logs and rendered on /platform/logs for staff
-- with `logs:read`. `source` discriminates 'client' vs 'server'.
--
-- The ingest endpoint is intentionally auth-optional so we still
-- capture errors that happen before login or when the token is bad
-- (the most interesting failure modes). `user_id` is best-effort.
-- ============================================================
CREATE TABLE IF NOT EXISTS error_logs (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'client'
        CHECK (source IN ('client', 'server')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    session_id TEXT,
    severity TEXT NOT NULL DEFAULT 'error'
        CHECK (severity IN ('error', 'warn', 'info')),
    message TEXT NOT NULL,
    stack TEXT,
    url TEXT,
    user_agent TEXT,
    request_id TEXT,
    status_code INTEGER,
    method TEXT,
    extra JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at
    ON error_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_user
    ON error_logs (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_logs_source
    ON error_logs (source, created_at DESC);

-- ── Visitor tracking ──
-- One row per public-site open (POST /api/visits), including anonymous
-- visitors (user_id NULL). IP + user_agent are captured server-side. Read
-- back by the platform "Visitors" page (GET /api/platform/visits).
CREATE TABLE IF NOT EXISTS page_visits (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip TEXT,
    user_agent TEXT,
    path TEXT NOT NULL,
    referrer TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Coarse geolocation of `ip`, resolved offline (MaxMind GeoLite2) at write time
-- for the Visitors page. Nullable + additive: existing rows and
-- private/unresolvable IPs stay NULL.
ALTER TABLE page_visits ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE page_visits ADD COLUMN IF NOT EXISTS region  TEXT;
ALTER TABLE page_visits ADD COLUMN IF NOT EXISTS city    TEXT;
CREATE INDEX IF NOT EXISTS idx_page_visits_created_at
    ON page_visits (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_visits_user
    ON page_visits (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

-- ── Activity dashboard (GET /api/home/summary) supporting indexes ──
-- Partial index on unread emails — both the COUNT and the "5 most recent
-- unread" preview use this, so the query is an index-only scan even on a
-- huge inbox. Skips read mail entirely.
CREATE INDEX IF NOT EXISTS idx_emails_unread
ON emails (account_id, created_at DESC)
WHERE is_read = false;

-- Today's meetings for a user — used by the dashboard's Today card.
CREATE INDEX IF NOT EXISTS idx_meetings_user_date
ON meetings (user_id, date, start_time);

-- Open tasks for a user, ordered by priority. The pre-existing
-- idx_tasks_user_priority above scans all tasks; this partial variant
-- skips done rows entirely so the dashboard's top-5 lookup is tighter.
CREATE INDEX IF NOT EXISTS idx_tasks_user_open_priority
ON tasks (user_id, priority DESC, created_at DESC)
WHERE status != 'done';

-- Most-recently-touched notes for a user.
CREATE INDEX IF NOT EXISTS idx_notes_user_updated
ON notes (user_id, updated_at DESC);


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
-- The payment-gated org signup bills the founder's *personal* Stripe customer
-- (so an Advance user's saved card just works), then links that SAME customer
-- to the new organization on success. That means one Stripe customer id is
-- shared by two billing_customers rows (the user's and the org's), so the
-- original column-level UNIQUE on stripe_customer_id is dropped in favor of a
-- plain lookup index. Per-owner uniqueness is still enforced by the two
-- partial indexes above. Idempotent: no-op once the constraint is gone.
ALTER TABLE billing_customers DROP CONSTRAINT IF EXISTS billing_customers_stripe_customer_id_key;
CREATE INDEX IF NOT EXISTS billing_customers_stripe_customer_idx
    ON billing_customers(stripe_customer_id);

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
-- Three personal tiers (Basic / Advance / Most Advance) and three business
-- tiers (Startups / Business / Enterprise). `features.bullets` is an ordered
-- list of display strings the pricing/billing UIs render verbatim. Note: the
-- backend re-applies this exact catalog on every boot via an upsert in
-- startup.rs, so this seed only matters for a brand-new volume.
INSERT INTO plans (code, name, description, audience, amount_cents, billing_interval, storage_limit_bytes, seat_limit, features)
VALUES
    ('basic_user', 'Basic', 'Free personal plan to get started.', 'personal', 0, 'month', 1073741824, 1,
     '{"bullets":["1 GB encrypted storage","Up to 1,000 emails per day","End-to-end encrypted chat","1 seat"]}'::jsonb),
    ('advance_user', 'Advance', 'Personal paid plan with higher limits.', 'personal', 700, 'month', 10737418240, 1,
     '{"bullets":["10 GB encrypted storage","Unlimited daily emails","1,000 encrypt/decrypt ops per day","Priority email sync"]}'::jsonb),
    ('most_advance_user', 'Most Advance', 'Top personal tier with full AI access.', 'personal', 1500, 'month', 53687091200, 1,
     '{"bullets":["500 GB encrypted storage","Unlimited email & calls","Full AI assistant access","Priority support"]}'::jsonb),
    ('business_startups', 'Startups', 'For small teams getting off the ground.', 'organization', 800, 'month', -1, 20,
     '{"bullets":["Up to 20 members","Unlimited shared storage","Shared org workspace","Admin & billing controls"]}'::jsonb),
    ('organization', 'Business', 'For growing organizations up to 100 members.', 'organization', 1200, 'month', -1, 100,
     '{"bullets":["Up to 100 members","Unlimited storage & email","SSO + role-based access","Audit logs & priority support"]}'::jsonb),
    ('enterprise', 'Enterprise', '100+ members with unlimited everything. Contact sales.', 'organization', 0, 'month', -1, 100000,
     '{"bullets":["Unlimited members","Dedicated success manager","Custom onboarding & SLA","SSO, SCIM & advanced security"]}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    audience = EXCLUDED.audience,
    amount_cents = EXCLUDED.amount_cents,
    billing_interval = EXCLUDED.billing_interval,
    storage_limit_bytes = EXCLUDED.storage_limit_bytes,
    seat_limit = EXCLUDED.seat_limit,
    features = EXCLUDED.features,
    is_active = TRUE;

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

-- Payment-gated organization signup intent. A personal user fills the
-- create-org form + pays BEFORE any organization row exists, so the org
-- details live here transiently keyed by the Stripe subscription that must
-- be paid first. On a confirmed charge the row is "finalized": the org +
-- owner membership + entitlement are created and `organization_id` is
-- stamped back here. The finalize step is idempotent (client confirm AND
-- the Stripe webhook both call it) — `status` + the FOR UPDATE lock prevent
-- a double-create. Abandoned/unpaid intents stay 'pending' and are harmless
-- (Stripe auto-cancels the incomplete subscription).
CREATE TABLE IF NOT EXISTS pending_org_signups (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    place TEXT,
    admin_email TEXT,
    plan_code TEXT NOT NULL,
    stripe_customer_id TEXT NOT NULL,
    stripe_subscription_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'finalized', 'failed')),
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pending_org_signups_user_idx
    ON pending_org_signups(user_id);

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

-- Non-consequential activity stream: page views, UI clicks and every
-- authenticated API request. High-volume and noisy, so it lives in its own
-- table (never bloats audit_logs) and is pruned to the last 7 days by a
-- background task. Surfaced per-user on the User Audit page. No organization_id
-- column on purpose — scope is enforced at read time, keeping the write path
-- (one fire-and-forget INSERT) cheap.
CREATE TABLE IF NOT EXISTS activity_events (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                 -- 'page_view' | 'click' | 'api_request'
    label TEXT,                         -- click text/href, or page route
    method TEXT,                        -- api_request only
    path TEXT,                          -- api_request path / page route
    status_code INTEGER,                -- api_request only
    ip TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_events_actor
    ON activity_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_created
    ON activity_events(created_at DESC);

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

-- Plan A end-to-end encryption ships with a hard 1 GiB cap per user
-- spanning every app surface: emails, chat, drive, tasks, calendar,
-- notes. The counter is maintained at the write path of each surface
-- (an INSERT/UPDATE of ciphertext bumps bytes_used; DELETE decrements
-- it). bytes_quota is per-row so paid tiers can raise it without
-- touching the default. Out-of-band reconciliation can rebuild
-- bytes_used from the source tables — it's a cache, the source data
-- is the ciphertext columns themselves.
CREATE TABLE IF NOT EXISTS user_storage_usage (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bytes_used BIGINT NOT NULL DEFAULT 0,
    bytes_quota BIGINT NOT NULL DEFAULT 1073741824,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_storage_usage_nonneg_chk CHECK (bytes_used >= 0 AND bytes_quota >= 0)
);

-- Plan A Phase 3 — Secure-send magic link.
--
-- When a Wayve user sends an email to a non-Wayve recipient with
-- "Secure send" enabled, the body is encrypted in the sender's browser
-- to a passphrase the sender shares with the recipient out-of-band
-- (Signal, SMS, in-person). The server stores only the opaque
-- ciphertext + wrapped key + per-message PBKDF2 salt — it has no path
-- to the passphrase so it cannot decrypt at any point. Recipients
-- redeem the magic link, enter the passphrase, and decrypt entirely
-- client-side.
--
-- Fields the FRONTEND generates and uploads (server stores verbatim):
--   ciphertext, iv, wrapped_key, salt
-- Fields the BACKEND generates:
--   token (URL-safe random), expires_at, opened_at
CREATE TABLE IF NOT EXISTS secure_messages (
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
);
CREATE INDEX IF NOT EXISTS idx_secure_messages_expires_at
    ON secure_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_secure_messages_sender
    ON secure_messages(sender_user_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────────
-- Organization Master Key (mnemonic-only, no admin recovery)
-- ────────────────────────────────────────────────────────────────────────
-- A per-org RSA keypair. The PUBLIC key is readable by any member (used at
-- member provisioning to escrow their freshly-generated private key). The
-- PRIVATE key never lives on the server unwrapped; it exists only as
-- wrapped envelopes in organization_wrapped_keys (one per key-holder).
--
-- See also: backend/crates/wayve-server/src/organization/keys.rs for the
-- handler set, and frontend/src/orgKeys/ for the client-side flow.
CREATE TABLE IF NOT EXISTS organization_keys (
    organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Wrapped copies of the org private key. Two flavours:
--   wrap_method='mnemonic'    — holder_user_id IS NULL. The canonical
--     recovery path. Wrapped with AES-GCM(PBKDF2-SHA256-600k(mnemonic)).
--     Generated and uploaded once at org-creation time by the founder.
--     Cannot be regenerated by anyone except the original owner who held
--     the mnemonic (the server never has the mnemonic in plaintext).
--   wrap_method='user_pubkey' — holder_user_id IS the key-holder. The
--     everyday-use path. Wrapped with the holder's personal RSA pubkey
--     (WAYVE_SECURE_V1 single-recipient envelope). Each owner/admin gets
--     one row; promotion adds, demotion deletes.
CREATE TABLE IF NOT EXISTS organization_wrapped_keys (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    wrap_method TEXT NOT NULL CHECK (wrap_method IN ('mnemonic', 'user_pubkey')),
    holder_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    iv TEXT NOT NULL,
    ct TEXT NOT NULL,
    pbkdf2_iterations INTEGER,
    pbkdf2_salt TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_wrapped_keys_holder
    ON organization_wrapped_keys(organization_id, holder_user_id);
-- Only one mnemonic-wrap per org (holder_user_id is NULL on that row; the
-- composite UNIQUE above treats NULLs as distinct in Postgres, so this
-- partial unique enforces the singleton constraint explicitly).
CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_wrapped_keys_mnemonic
    ON organization_wrapped_keys(organization_id)
    WHERE wrap_method = 'mnemonic';

-- Each org member's private key, wrapped under PBKDF2(password). Served
-- to the member's browser at login so they can unwrap with their password
-- and proceed without ever generating a keypair client-side. Distinct
-- from `user_wrapped_keys` (which is the personal-user mnemonic path);
-- the per-user salt here is essential because passwords have far less
-- entropy than mnemonics.
CREATE TABLE IF NOT EXISTS member_login_wrapped_keys (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    iv TEXT NOT NULL,
    ct TEXT NOT NULL,
    salt TEXT NOT NULL,
    iterations INTEGER NOT NULL DEFAULT 600000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each org member's private key, wrapped under the org pubkey. Inserted
-- at provisioning time by the server (member never sees their own
-- plaintext private key). The owner/admin uses the unwrapped org private
-- key to recover this row when offboarding a member or resetting a
-- member's password.
CREATE TABLE IF NOT EXISTS member_wrapped_keys (
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    iv TEXT NOT NULL,
    ct TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, user_id)
);

-- Audit log for any access to the org master key or member escrow.
-- Owner-readable; appended-to by handlers in organization/keys.rs and by
-- the password-reset path.
CREATE TABLE IF NOT EXISTS org_key_audit_log (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_role TEXT,
    action TEXT NOT NULL,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_key_audit_log_org_time
    ON org_key_audit_log(organization_id, created_at DESC);

-- ── Access requests ──────────────────────────────────────────────────
-- A user asks to see locked data; the request is routed to a support team
-- by scope: personal/platform users → the platform support team, an
-- organization member → that organization's support team. Staff with the
-- `tickets:manage` permission (support / admin / owner) review and decide.
-- Both sides attach free-text explanations (request_note / decision_note).
CREATE TABLE IF NOT EXISTS access_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource TEXT NOT NULL DEFAULT 'test_access',
    target_scope TEXT NOT NULL CHECK (target_scope IN ('platform', 'organization')),
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied')),
    request_note TEXT,
    decision_note TEXT,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ
);
-- At most one active (pending or approved) request per user + resource.
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_requests_active
    ON access_requests(user_id, resource)
    WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS idx_access_requests_platform_queue
    ON access_requests(status, created_at DESC)
    WHERE target_scope = 'platform';
CREATE INDEX IF NOT EXISTS idx_access_requests_org_queue
    ON access_requests(organization_id, status, created_at DESC)
    WHERE organization_id IS NOT NULL;

-- ── User-action audit log ────────────────────────────────────────────
-- Security-relevant actions taken by users — password changes, data /
-- account deletions, file exports/downloads, billing changes, etc. Read by
-- the Security audit page; also mirrored to logs/user_actions.log. Writes
-- are best-effort and must never block the action they describe.
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    metadata JSONB,
    ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Coarse geolocation of `ip`, resolved offline (MaxMind GeoLite2) at write time
-- for the User Logs page. Nullable + additive: existing rows, system events and
-- private/unresolvable IPs stay NULL.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS region  TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS city    TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
    ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org
    ON audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action
    ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created
    ON audit_logs(created_at DESC);
