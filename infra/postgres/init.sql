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
-- Presence: wall-clock of the last time this user held a live chat WebSocket
-- (stamped on connect, on graceful disconnect, and when the presence sweeper
-- reaps a stale session). Read by the presence snapshot endpoint to render
-- "last seen …" when a user is offline. Live online/offline is driven by the
-- Redis `presence:online` sorted set (or the local session registry when Redis
-- is down); this column is only the durable fallback. See chat/presence.rs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
-- Manually chosen chat presence status, shown as a colored dot in Messages.
-- 'active' (green) is the default; 'dnd' (red) = Do Not Disturb; 'away' (amber).
-- Orthogonal to the live online/offline signal: an offline user renders gray
-- regardless, and this only tints the dot while they hold a chat socket.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_status TEXT NOT NULL DEFAULT 'active';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_chat_status_check
    CHECK (chat_status IN ('active', 'dnd', 'away'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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
-- Sprint (cycle) length in days for the workspace user-stories burnup. Admin-
-- editable on /settings (1–90); read through every member's /api/me.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sprint_total_days SMALLINT NOT NULL DEFAULT 14 CHECK (sprint_total_days BETWEEN 1 AND 90);

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

-- Wayve-local project summary, keyed by the linked GitHub repo (owner/name,
-- stored lowercased so the key is case-stable). One editable blurb per repo,
-- shown on the project detail page and independent of the GitHub repo's own
-- description. Editing is gated by the same repo-admin check as repo access.
CREATE TABLE IF NOT EXISTS project_summaries (
    github_owner TEXT NOT NULL,
    github_repo  TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (github_owner, github_repo)
);

-- Per-user project (GitHub repo) access. One row grants one user visibility of
-- one repo (by full_name "owner/name") on the Projects page. Platform staff and
-- org owner/super_admin/admin are unrestricted and ignore this table; regular
-- members see only the repos granted to them. Mirrored in startup.rs.
CREATE TABLE IF NOT EXISTS member_project_access (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, repo_full_name)
);
CREATE INDEX IF NOT EXISTS idx_member_project_access_user
    ON member_project_access (user_id);

-- Wayve-intended access level for the grant ('read' | 'write'). GitHub's live
-- collaborator permission is authoritative when readable; this records the level
-- chosen in the per-repo Access panel so the grid still shows one when GitHub
-- can't be read, and it drives the best-effort GitHub collaborator sync.
ALTER TABLE member_project_access ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'read';
ALTER TABLE member_project_access DROP CONSTRAINT IF EXISTS member_project_access_level_check;
ALTER TABLE member_project_access ADD CONSTRAINT member_project_access_level_check
    CHECK (access_level IN ('read', 'write'));
-- The per-repo Access view queries by repo (repo_full_name = $1), the inverse of
-- the per-member lookup the idx_..._user index serves.
CREATE INDEX IF NOT EXISTS idx_member_project_access_repo
    ON member_project_access (repo_full_name);

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

-- Platform-scope counterpart of organization_feature_access. The platform is a
-- singleton scope (no per-tenant id), so one row = "this platform role may use
-- this feature". Same semantics: ANY row for feature_key means it is configured
-- (only listed roles allowed); no rows = fall back to the feature default. The
-- platform owner is always allowed (and force-included on save).
CREATE TABLE IF NOT EXISTS platform_feature_access (
    feature_key TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (feature_key, role)
);

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

-- Email verification for personal email+password signups. `email_verified`
-- defaults TRUE so all EXISTING users plus OAuth/SCIM/business signups are
-- grandfathered in (never locked out); only new personal `/api/register`
-- signups explicitly insert FALSE and must confirm via the emailed link.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;

-- Email verification codes. Single-use, short-lived 6-digit codes. `token`
-- holds the code and is NOT unique (6-digit codes collide across users);
-- verification is always scoped to the user. `attempts` bounds brute force.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id
    ON email_verification_tokens(user_id);

-- Pre-creation email confirmation for admin-provisioned accounts. The code is
-- issued BEFORE the users row exists, so it cannot hang off
-- email_verification_tokens.user_id; it is keyed by (requesting admin,
-- account_email) instead. `delivery_email` is where the code was actually
-- mailed, which is not always the account address: org accounts are minted on
-- synthetic domains (<user>@<org-slug>.com) that have no real inbox, so the
-- admin points the code at the person's reachable mailbox.
CREATE TABLE IF NOT EXISTS admin_create_verifications (
    id SERIAL PRIMARY KEY,
    requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_email TEXT NOT NULL,
    delivery_email TEXT NOT NULL,
    code TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_create_verifications_lookup
    ON admin_create_verifications(requested_by, account_email, used_at);

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

-- Per-user GitHub OAuth connection (personal accounts). The granted access token
-- is encrypted at rest (AES-256-GCM) via the `*_iv` / `*_encrypted` pair, exactly
-- like org_sso_configs.client_secret_*. Lets a personal user import their own
-- public + private repos; org/enterprise/platform keep the shared-token model.
CREATE TABLE IF NOT EXISTS github_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    github_login TEXT NOT NULL,
    github_user_id BIGINT,
    access_token_iv TEXT NOT NULL,
    access_token_encrypted TEXT NOT NULL,
    scope TEXT,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user Figma OAuth connection, same shape and the same at-rest encryption as
-- github_accounts. Figma access is per person rather than per org: the token is
-- only ever used to read metadata for files that user can already see, so one
-- member connecting never widens what another can attach.
CREATE TABLE IF NOT EXISTS figma_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    figma_handle TEXT NOT NULL,
    figma_user_id TEXT,
    figma_email TEXT,
    access_token_iv TEXT NOT NULL,
    access_token_encrypted TEXT NOT NULL,
    -- Figma access tokens expire (unlike GitHub's), so the refresh token is kept
    -- to renew them; without it a connection dies silently in a few weeks.
    refresh_token_iv TEXT,
    refresh_token_encrypted TEXT,
    expires_at TIMESTAMPTZ,
    scope TEXT,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
-- How many minutes before a meeting starts the client pops its alert. 0 means
-- meeting alerts are off for this user. Stored server-side so the preference
-- follows the user across devices; whether that alert *also* raises an OS-level
-- desktop notification stays device-local (browser permission is per-device).
ALTER TABLE users ADD COLUMN IF NOT EXISTS meeting_alert_minutes SMALLINT NOT NULL DEFAULT 10
    CHECK (meeting_alert_minutes >= 0 AND meeting_alert_minutes <= 1440);



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

-- Gmail push (users.watch → standard Cloud Pub/Sub) state. `gmail_history_id`
-- is the incremental-sync cursor, advanced after each history.list call;
-- `watch_expires_at` is when the current watch lapses (Gmail watches live
-- ≤7 days) so the renewal worker can re-arm before then.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS gmail_history_id BIGINT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS watch_expires_at TIMESTAMPTZ;

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

-- User-defined "custom label" tabs for the org/platform shared inbox — a named,
-- saved sender filter (a generalized version of the hardcoded `github` virtual
-- folder). A creator types a free-text senders description (an address, a list,
-- or a phrase like "all github notifications"); the backend normalizes it into
-- `senders` (lowercase addresses + bare domains) and the inbox matches each
-- email's `sender` against that list. Shared across a scope, NOT per-user:
-- `organization_id` NULL = platform-level, set = org-level — mirroring the
-- `email_accounts.organization_id` shared-inbox convention. Personal scope never
-- gets rows (creation is gated on org/platform scope). Access is enforced in SQL
-- by the caller's resolved `organization_id`, so this table is deliberately NOT
-- in the per-user RLS `pairs` loop (whose policy is `user_id = app.user_id`).
CREATE TABLE IF NOT EXISTS email_labels (
    id              SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    raw_senders     TEXT NOT NULL DEFAULT '',
    senders         TEXT[] NOT NULL DEFAULT '{}',
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);
-- Unique label name per org, and a separate partial index for platform-level
-- (org-null) labels — Postgres treats NULLs as distinct, so a plain UNIQUE on
-- (organization_id, name) would not dedupe platform rows. Mirrors `teams`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_labels_org_name
    ON email_labels(organization_id, name) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_labels_platform_name
    ON email_labels(name) WHERE organization_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_labels_org
    ON email_labels(organization_id);




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


-- Public "Book a demo" lead form (fluxze.com home → /book-demo). No auth: any
-- visitor may submit. Each row is emailed to sales and turned into an .ics
-- calendar invite. `scheduled_at` is the visitor's chosen slot, stored in UTC.
CREATE TABLE IF NOT EXISTS demo_requests (
    id           SERIAL PRIMARY KEY,
    first_name   TEXT NOT NULL,
    last_name    TEXT NOT NULL,
    email        TEXT NOT NULL,
    work_email   TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    emailed      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


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

-- File attachments on chat messages (direct messages AND channel messages).
-- The blob is always encrypted at rest with the server key (file_iv + on-disk
-- ciphertext). When `e2e` is true the stored bytes are ALSO a client-side
-- ciphertext (decryptable only by the conversation's participants), so the
-- server can't read the file; when false the at-rest layer is the only
-- encryption.
--
-- DMs (`messages`) and channel messages (`channel_messages`) are separate
-- tables with separate id spaces, so — as with `message_reactions` — an
-- attachment points at exactly one of them via `message_id` XOR
-- `channel_message_id` (see the constraint added below `channel_messages`,
-- which must exist before the FK can be declared). BOTH are NULL between
-- upload and send; the send path sets exactly one to link the attachment.
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

-- Channel target for chat_attachments (declared here because chat_attachments
-- is created above channel_messages, so the FK can't be inline). An attachment
-- links to at most one message: a DM (message_id) or a channel message
-- (channel_message_id). Both NULL is the legal pre-send state, so this is "at
-- most one" rather than the strict XOR used by message_reactions.
ALTER TABLE chat_attachments
    ADD COLUMN IF NOT EXISTS channel_message_id INT
    REFERENCES channel_messages(id) ON DELETE CASCADE;

ALTER TABLE chat_attachments DROP CONSTRAINT IF EXISTS chat_attachments_one_target;
ALTER TABLE chat_attachments
    ADD CONSTRAINT chat_attachments_one_target
    CHECK (message_id IS NULL OR channel_message_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_channel_message
    ON chat_attachments (channel_message_id);

-- Emoji reactions on a chat message. DMs (`messages`) and channel messages
-- (`channel_messages`) are separate tables with separate id spaces, so a
-- reaction points at exactly one of them (the CHECK enforces the XOR) rather
-- than carrying a single ambiguous message_id.
--
-- NOTE ON ENCRYPTION: `emoji` is stored in PLAINTEXT, unlike message content
-- (which is a client-side E2E envelope the server cannot read). This is
-- deliberate: reactions have to be aggregated server-side — counts, who-reacted,
-- joined into the message list queries — and a message's AES key is wrapped
-- per-recipient at send time, so a reactor cannot produce an aggregatable
-- ciphertext. The cost is that the server learns "user X reacted 👍 to message
-- Y", on top of the sender/receiver/channel/timestamp metadata it already sees
-- in the clear for every message. Message BODIES remain E2E encrypted.
CREATE TABLE IF NOT EXISTS message_reactions (
    id BIGSERIAL PRIMARY KEY,
    message_id INT REFERENCES messages(id) ON DELETE CASCADE,
    channel_message_id INT REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT message_reactions_one_target
        CHECK ((message_id IS NULL) <> (channel_message_id IS NULL))
);

-- One reaction per (message, user, emoji) — re-reacting with the same emoji is
-- a toggle-off, not a second row. Partial uniques because of the nullable pair:
-- a plain UNIQUE would treat NULLs as distinct and let duplicates through.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reactions_dm_unique
    ON message_reactions (message_id, user_id, emoji) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reactions_channel_unique
    ON message_reactions (channel_message_id, user_id, emoji) WHERE channel_message_id IS NOT NULL;


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
-- `collection` partitions the shared workspace into independent file trees that
-- share this one table: 'library' (the Documents page) and 'skills' (the Skills
-- page). Existing rows default to 'library'.
ALTER TABLE org_document_folders ADD COLUMN IF NOT EXISTS collection VARCHAR(32) NOT NULL DEFAULT 'library';
CREATE INDEX IF NOT EXISTS idx_org_doc_folders_org_parent
    ON org_document_folders(organization_id, collection, parent_folder_id);

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
-- See org_document_folders.collection above; keeps Skills files out of the
-- Documents (library) listing and vice versa.
ALTER TABLE org_documents ADD COLUMN IF NOT EXISTS collection VARCHAR(32) NOT NULL DEFAULT 'library';
CREATE INDEX IF NOT EXISTS idx_org_documents_org_folder
    ON org_documents(organization_id, collection, folder_id);

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

-- Reminders (personal, time-based). Distinct from meetings/tasks: a standalone
-- "remind me at" entry that the client pops a minute before `remind_at`.
CREATE TABLE IF NOT EXISTS reminders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT,
    remind_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reminders_user_time ON reminders(user_id, remind_at);

-- Noise senders: per-user list of sender addresses the user marked as "noise".
-- The email `noise` folder includes mail from these senders (current + future),
-- and the inbox excludes them, so marking one address routes all their mail.
CREATE TABLE IF NOT EXISTS noise_senders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_email TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, sender_email)
);
CREATE INDEX IF NOT EXISTS idx_noise_senders_user ON noise_senders(user_id);

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
-- Statuses became user-configurable (see task_statuses below), so the set of
-- legal values is no longer fixed and cannot be expressed as a CHECK. Validation
-- moved into tasks::handler::resolve_status, which rejects any slug not present
-- in the caller's own status set rather than silently coercing it.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;

-- ------------------------------------------------------------
-- User-configurable task statuses.
--
-- Polymorphic-owned exactly like `projects`: exactly one of organization_id /
-- user_id is set. Org rows are the shared workflow for every member of that org
-- (edited by holders of `task_statuses:manage`); personal and platform accounts
-- own their statuses via user_id.
--
-- `category` is the fixed semantic axis and is NOT user-editable. `tasks.status`
-- stores the free-form `slug`, but every behavioural decision — is this task
-- finished, does it belong on the active list, which Jira category does it map
-- to — keys off `category` instead. That split is what lets a user rename "Done"
-- to "Shipped" without silently breaking the dashboard's open-task count.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_statuses (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    -- #rrggbb, lowercase. Rendered as an inline style, so it is constrained here
    -- rather than trusted from the client.
    color TEXT NOT NULL DEFAULT '#6b7280' CHECK (color ~ '^#[0-9a-f]{6}$'),
    category TEXT NOT NULL CHECK (
        category IN ('backlog', 'planned', 'in_progress', 'completed', 'canceled')
    ),
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT task_statuses_owner_chk CHECK (
        (organization_id IS NOT NULL AND user_id IS NULL) OR
        (organization_id IS NULL AND user_id IS NOT NULL)
    )
);

-- Slugs are unique per owner. Two partial indexes rather than one UNIQUE, since
-- the owner column is polymorphic and NULLs never compare equal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_statuses_org_slug
    ON task_statuses (organization_id, slug) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_statuses_user_slug
    ON task_statuses (user_id, slug) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_statuses_org  ON task_statuses (organization_id);
CREATE INDEX IF NOT EXISTS idx_task_statuses_user ON task_statuses (user_id);

-- Free-text "assigned by" / "assignee" attribution (who handed the task over
-- and who it's assigned to). Plain text, optional; empty string when unspecified.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_by TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee TEXT NOT NULL DEFAULT '';

-- Optional link to an external Jira issue (see user_jira_connections below).
-- `jira_issue_key` is the issue key (e.g. "WAY-12"); `jira_base` is the site
-- root (e.g. "https://acme.atlassian.net") so the UI can deep-link to
-- `${jira_base}/browse/${jira_issue_key}`. NULL for tasks with no Jira link.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS jira_issue_key TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS jira_base TEXT;
-- One Wayve task per (user, Jira issue) so re-imports UPDATE in place instead
-- of duplicating. Partial: unlinked tasks (NULL key) are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_user_jira_issue
    ON tasks(user_id, jira_issue_key) WHERE jira_issue_key IS NOT NULL;

-- Optional link to a GitLab issue (mirrors the Jira columns; see
-- user_gitlab_connections below). A task links a GitLab issue via
-- (gitlab_project_id, gitlab_issue_iid); `gitlab_web_url` is the direct issue
-- link for the UI badge. NULL for tasks with no GitLab link.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gitlab_issue_iid INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gitlab_project_id INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gitlab_web_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_user_gitlab_issue
    ON tasks(user_id, gitlab_project_id, gitlab_issue_iid)
    WHERE gitlab_issue_iid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_user_priority ON tasks(user_id, priority DESC, created_at DESC);

-- First-class assignment + project linkage (see docs/architecture/ai-task-assignment.md).
-- `assignee_id` is the real assigned user (FK users); the legacy free-text `assignee`
-- above is kept for display/back-compat and for reference names that don't map to a
-- Wayve user. `project_id` links a task to a project (→ its GitHub repo via
-- projects.github_owner/github_repo), which drives the assignee-suggestion feature.
-- Both nullable and ON DELETE SET NULL so removing a user/project never deletes tasks.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_project_id  ON tasks(project_id)  WHERE project_id IS NOT NULL;

-- Human-friendly, per-user task number assigned sequentially at creation
-- (each user's own tasks are #1, #2, #3, …). Distinct from the global SERIAL
-- `id`, which is shared across all users and jumps around. Nullable so imported
-- tasks (Jira/GitLab) — which already carry their own external key badge — can
-- be left un-numbered. Assigned in the create-task handler as MAX+1 per user.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_number INTEGER;
-- Backfill any rows still missing a number: number each user's existing tasks
-- by creation order. Idempotent — only touches NULL rows.
WITH numbered AS (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id) AS rn
    FROM tasks WHERE task_number IS NULL
)
UPDATE tasks t SET task_number = n.rn FROM numbered n WHERE t.id = n.id;
-- One number per user; partial so un-numbered (imported) rows are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_user_task_number
    ON tasks(user_id, task_number) WHERE task_number IS NOT NULL;

-- Per-user Jira Cloud connection (Basic auth: email + API token). The token is
-- stored encrypted at rest via wayve_security::encryption (the same symmetric
-- AES-256-GCM scheme as org_sso_configs.client_secret_*); this is unrelated to
-- chat/email end-to-end encryption. One connection per user.
CREATE TABLE IF NOT EXISTS user_jira_connections (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    base_url TEXT NOT NULL,
    email TEXT NOT NULL,
    api_token_iv TEXT NOT NULL,
    api_token_encrypted TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Slack integration (ENTERPRISE tier only — enforced in the handler). One Slack
-- workspace per organization; the bot token is encrypted at rest like every
-- other third-party credential. slack_channel_links maps a Slack channel to a
-- Wayve channel so imported messages land in the right place (and outbound
-- posts target the right Slack channel).
CREATE TABLE IF NOT EXISTS slack_connections (
    organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    bot_token_iv TEXT NOT NULL,
    bot_token_encrypted TEXT NOT NULL,
    team_id TEXT,
    team_name TEXT,
    connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS slack_channel_links (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    wayve_channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    slack_channel_id TEXT NOT NULL,
    slack_channel_name TEXT,
    -- Slack message ts of the newest imported message, so re-import only pulls
    -- what is new (Slack pagination is keyed on the `ts` cursor).
    last_imported_ts TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_link_org_channel
    ON slack_channel_links(organization_id, slack_channel_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_link_wayve_channel
    ON slack_channel_links(wayve_channel_id);

-- Per-user GitLab connection (mirrors user_jira_connections). `base_url`
-- supports self-hosted GitLab; the personal access token is encrypted at rest.
CREATE TABLE IF NOT EXISTS user_gitlab_connections (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    base_url TEXT NOT NULL,
    access_token_iv TEXT NOT NULL,
    access_token_encrypted TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Connected MCP (Model Context Protocol) servers. ENTERPRISE orgs and the
-- PLATFORM scope only: an owner/admin registers a remote MCP server (its single
-- Streamable-HTTP endpoint + optional bearer token) so the AI assistant can call
-- that server's tools — e.g. to read the customer's own database. Fluxze never
-- touches their DB directly; it speaks MCP to a server they run and control.
--
-- Owner is polymorphic: `owner_scope='organization'` rows carry an
-- `organization_id`; `owner_scope='platform'` rows have it NULL (a single global
-- platform tenant). Multiple servers per owner, so an auto-increment id. The
-- auth token is encrypted at rest via wayve_security::encryption (iv+ciphertext),
-- and is NULL when `auth_type='none'`.
CREATE TABLE IF NOT EXISTS mcp_connections (
    id                   SERIAL PRIMARY KEY,
    owner_scope          TEXT NOT NULL DEFAULT 'organization'
                         CHECK (owner_scope IN ('organization', 'platform')),
    organization_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    label                TEXT NOT NULL,
    server_url           TEXT NOT NULL,
    auth_type            TEXT NOT NULL DEFAULT 'bearer'
                         CHECK (auth_type IN ('bearer', 'none')),
    auth_token_iv        TEXT,
    auth_token_encrypted TEXT,
    enabled              BOOLEAN NOT NULL DEFAULT TRUE,
    server_name          TEXT,
    last_tool_count      INTEGER,
    last_validated_at    TIMESTAMP,
    connected_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMP DEFAULT NOW(),
    updated_at           TIMESTAMP DEFAULT NOW(),
    -- An org row must name its org; a platform row must not.
    CONSTRAINT mcp_owner_org_shape CHECK (
        (owner_scope = 'organization' AND organization_id IS NOT NULL)
        OR (owner_scope = 'platform' AND organization_id IS NULL)
    )
);

-- One row per (owner, server_url). Partial indexes because platform rows share a
-- NULL organization_id (NULLs don't collide in a plain UNIQUE).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_connections_org
    ON mcp_connections(organization_id, server_url) WHERE owner_scope = 'organization';
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_connections_platform
    ON mcp_connections(server_url) WHERE owner_scope = 'platform';
CREATE INDEX IF NOT EXISTS idx_mcp_connections_owner
    ON mcp_connections(owner_scope, organization_id) WHERE enabled;

-- Per-organization AI provider. The enterprise OWNER picks which AI the org's
-- assistant runs on (provider + model + their own key/endpoint); every member of
-- the org then uses that one provider (resolution is keyed on the caller's org,
-- with no per-user override). One row per org (PK on organization_id). The API
-- key is encrypted at rest via wayve_security::encryption (iv + ciphertext) and
-- is NULL when the org leans on the platform's default key (gemini only).
-- `base_url` is the custom endpoint for `openai_compatible` (Azure OpenAI / a
-- Bedrock gateway / an internal proxy); NULL means the provider's vendor default.
-- `fail_closed` = once a provider is set, never silently fall back to the
-- platform default. NOT row-level-secured — it is owner-gated at the handler,
-- exactly like slack_connections / org_sso_configs.
CREATE TABLE IF NOT EXISTS org_ai_configs (
    organization_id   INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    provider          TEXT NOT NULL
                      CHECK (provider IN ('gemini', 'anthropic', 'openai_compatible')),
    base_url          TEXT,
    model             TEXT,
    api_key_iv        TEXT,
    api_key_encrypted TEXT,
    fail_closed       BOOLEAN NOT NULL DEFAULT TRUE,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    last_validated_at TIMESTAMP,
    connected_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMP DEFAULT NOW(),
    updated_at        TIMESTAMP DEFAULT NOW()
);

-- Platform-team AI provider. Mirrors org_ai_configs but is a singleton (the
-- `id = 1` CHECK enforces exactly one row): the platform owner picks the AI the
-- *platform team* runs on. Deliberately separate from org_ai_configs so this can
-- never affect any organization/enterprise resolution — only platform members
-- read it (see resolve_ai_for_user). Additive: safe to apply to an existing DB.
CREATE TABLE IF NOT EXISTS platform_ai_config (
    id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    provider          TEXT NOT NULL
                      CHECK (provider IN ('gemini', 'anthropic', 'openai_compatible')),
    base_url          TEXT,
    model             TEXT,
    api_key_iv        TEXT,
    api_key_encrypted TEXT,
    fail_closed       BOOLEAN NOT NULL DEFAULT TRUE,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    -- Per-data-category access for the platform assistant's native tools. The
    -- platform owner toggles these on the AI Settings page; the agent only
    -- declares (and dispatches) tools whose category is allowed. Only categories
    -- that have native tools today are stored (email, calendar); the others
    -- (chat, drive, notes, tasks) have no AI tools yet.
    ai_allow_email    BOOLEAN NOT NULL DEFAULT TRUE,
    ai_allow_calendar BOOLEAN NOT NULL DEFAULT TRUE,
    last_validated_at TIMESTAMP,
    connected_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMP DEFAULT NOW(),
    updated_at        TIMESTAMP DEFAULT NOW()
);
-- Backfill the data-access columns on already-provisioned databases.
ALTER TABLE platform_ai_config
    ADD COLUMN IF NOT EXISTS ai_allow_email    BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS ai_allow_calendar BOOLEAN NOT NULL DEFAULT TRUE;

-- Platform-wide UI settings (singleton). Set by the platform owner and served
-- to every client via the public GET /api/config so the whole app shares one
-- look. `font_key` is a short key (system|inter|ibm-plex|serif|mono) the
-- frontend maps to a CSS font stack; NULL = the app default.
CREATE TABLE IF NOT EXISTS platform_ui_config (
    id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    font_key   TEXT,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Per-scope UI font overrides. A user's own font wins over their organization's,
-- which wins over the platform default (resolved in `platform_ui`). Same short
-- key vocabulary as platform_ui_config.font_key; NULL = inherit the next level.
ALTER TABLE users         ADD COLUMN IF NOT EXISTS ui_font_key TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ui_font_key TEXT;

-- Per-turn AI metering, powering the owner-only /settings/ai/usage dashboard.
-- One row per assistant turn (all tool-call rounds summed). `organization_id`
-- is the owner scope: set when the caller's org runs its own AI config, NULL for
-- platform-scope usage (platform members + the platform-default provider). Costs
-- are estimated from the model + token counts at record time (see
-- `ai::agent::cost_cents`), so historical rows keep the price they were metered
-- at even if the pricing table changes later.
CREATE TABLE IF NOT EXISTS ai_usage_events (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    input_tokens    BIGINT NOT NULL DEFAULT 0,
    output_tokens   BIGINT NOT NULL DEFAULT 0,
    cost_cents      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Precise cost in micro-cents (millionths of a cent). `cost_cents` truncates
-- sub-cent turns to $0.00; the dashboard sums this column and divides by 1e6
-- exactly once so small turns aggregate without loss. Backfill pre-existing
-- rows from the rounded cents so historical spend isn't zeroed.
ALTER TABLE ai_usage_events
    ADD COLUMN IF NOT EXISTS cost_micro_cents BIGINT NOT NULL DEFAULT 0;
UPDATE ai_usage_events
   SET cost_micro_cents = cost_cents * 1000000
 WHERE cost_micro_cents = 0 AND cost_cents <> 0;
CREATE INDEX IF NOT EXISTS ai_usage_events_org_idx
    ON ai_usage_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_user_idx
    ON ai_usage_events(user_id, created_at DESC);

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
-- 📖 WORKSPACE USER STORIES
-- ------------------------------------------------------------
-- A backlog presented in the Workspace sidebar section. Same shape as `tasks`
-- but polymorphic-owned exactly like `task_statuses` (exactly one of
-- organization_id / user_id): an organization member reads and writes their
-- org's ONE shared list, while platform and personal accounts get their own.
-- This mirrors status ownership (see `statuses::owner_for_user`), so a story and
-- its statuses always share the same owner. `story_number` is a per-owner
-- sequence assigned at creation. Statuses are NOT duplicated — the board reuses
-- the owner's `task_statuses` set (one workflow per owner), and `status` stores
-- a status slug validated against it.
-- ============================================================
CREATE TABLE IF NOT EXISTS user_stories (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    story_number INTEGER,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    status TEXT NOT NULL DEFAULT 'to_do',
    assigned_by TEXT NOT NULL DEFAULT '',
    assignee TEXT NOT NULL DEFAULT '',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT user_stories_owner_chk CHECK (
        (organization_id IS NOT NULL AND user_id IS NULL)
     OR (organization_id IS NULL AND user_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_user_stories_org ON user_stories(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_stories_user ON user_stories(user_id);

-- Status-change history for the user-stories burnup trend lines. One row per
-- status a story enters (create writes the first; each later status change adds
-- another). The history endpoint replays these to reconstruct per-day,
-- per-status counts. Owner columns are denormalised from the story so the
-- aggregation scopes without a join. See startup.rs for the day-0 backfill.
CREATE TABLE IF NOT EXISTS user_story_status_events (
    id SERIAL PRIMARY KEY,
    user_story_id INTEGER NOT NULL REFERENCES user_stories(id) ON DELETE CASCADE,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    to_status TEXT NOT NULL,
    to_category TEXT NOT NULL,
    changed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usse_org ON user_story_status_events(organization_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_usse_user ON user_story_status_events(user_id, changed_at);

-- ============================================================
-- 🎫 WORKSPACE TICKETS
-- ------------------------------------------------------------
-- A second Workspace backlog board, independent of user_stories.
-- Same polymorphic ownership and the same reuse of the owner's
-- `task_statuses` set (`ticket_number` is a per-owner sequence).
-- This is NOT the support_tickets feature below — that is in-app
-- support requests; these are a Tasks-style board.
-- ============================================================
CREATE TABLE IF NOT EXISTS workspace_tickets (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ticket_number INTEGER,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority SMALLINT NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    status TEXT NOT NULL DEFAULT 'to_do',
    assigned_by TEXT NOT NULL DEFAULT '',
    assignee TEXT NOT NULL DEFAULT '',
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    -- Set when this ticket was materialised from a reported bug (support_tickets):
    -- the support row stays the report-of-record; this is the board work item.
    -- Such tickets are hidden from normal per-owner boards and shown/managed only
    -- by platform staff holding tickets:manage. See routes/support.rs + startup.rs.
    -- FK + uniqueness added after support_tickets is defined below (that table
    -- is created later in this file, so an inline reference would be a forward ref).
    support_ticket_id INTEGER,
    -- AI relationship labels (see tickets/relate.rs). related_to points at the
    -- group's canonical (min id); relation_kind says how this ticket relates to
    -- it. Labels only — nothing is merged or closed.
    related_to INTEGER,
    relation_kind TEXT CHECK (relation_kind IN ('duplicate', 'similar')),
    -- User-set ticket type, shown in the board's "Type" column (Bug/Feature/…).
    -- For bug-derived tickets the linked support_tickets.category takes
    -- precedence at read time (see list_tickets' COALESCE); this column is the
    -- type a user picks on a normal ticket. Same value set as support categories.
    badge_kind TEXT CHECK (badge_kind IN ('bug', 'feature', 'billing', 'account', 'other')),
    -- Resolution memory (Phase 2): when a ticket is fixed by the AI-fix pipeline,
    -- the pointer to the fix is recorded here (the code itself stays in Git). A
    -- new ticket that is similar to a resolved one reuses resolution_summary +
    -- the diff fetched via resolution_commit. See tickets/recall.rs.
    resolution_pr_url TEXT,
    resolution_commit TEXT,
    resolution_summary TEXT,
    resolved_at TIMESTAMP,
    -- AI-fix review state: the "Fix with AI" pipeline (P1 tickets) dispatches CI,
    -- which makes + verifies a fix and posts the changed files + diff back here
    -- WITHOUT touching Git. The ticket page shows the diff, then three buttons
    -- drive GitHub's Git Data API: Commit (ai_fix_files @ ai_fix_base_sha → a
    -- commit object, ai_fix_commit_sha), Push (→ branch ai_fix_branch), Create PR
    -- (→ ai_fix_pr_url). ai_fix_status ∈
    -- (running|ready|committed|pushed|pr_opened|no_change|error).
    ai_fix_status TEXT,
    ai_fix_diff TEXT,
    -- The changed files as a JSON array [{path, content(base64), deleted}].
    ai_fix_files JSONB,
    ai_fix_base_sha TEXT,
    ai_fix_commit_sha TEXT,
    ai_fix_branch TEXT,
    ai_fix_pr_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT workspace_tickets_owner_chk CHECK (
        (organization_id IS NOT NULL AND user_id IS NULL)
     OR (organization_id IS NULL AND user_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_workspace_tickets_org ON workspace_tickets(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_tickets_user ON workspace_tickets(user_id);
-- One board work item per reported bug; also lets the mirror INSERT use
-- ON CONFLICT (support_ticket_id). NULLs (normal tickets) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_tickets_support_ticket
    ON workspace_tickets(support_ticket_id);

-- Attachments for Workspace tickets. Unlike task_attachments (per-user tasks),
-- a ticket is org-shared, so access is by ticket visibility, not uploader — the
-- `user_id` here only records who uploaded. Blobs are encrypted at rest on disk.
CREATE TABLE IF NOT EXISTS ticket_attachments (
    id BIGSERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES workspace_tickets(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    file_type TEXT,
    file_path TEXT NOT NULL,
    file_iv TEXT,
    size BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket ON ticket_attachments(ticket_id);
-- Backfill the user-set type column onto pre-existing boards. The CREATE above
-- names its inline CHECK `workspace_tickets_badge_kind_check`, so adding it under
-- the same name here leaves a migrated board identical to a fresh one.
ALTER TABLE workspace_tickets ADD COLUMN IF NOT EXISTS badge_kind TEXT;
DO $$
BEGIN
    ALTER TABLE workspace_tickets
        ADD CONSTRAINT workspace_tickets_badge_kind_check
        CHECK (badge_kind IN ('bug', 'feature', 'billing', 'account', 'other'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

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

-- Now that support_tickets exists, wire the workspace_tickets.support_ticket_id FK
-- (declared above without a reference to avoid a forward ref). Deleting a report
-- removes its materialised board ticket. Idempotent via the duplicate_object guard.
DO $$ BEGIN
    ALTER TABLE workspace_tickets
        ADD CONSTRAINT workspace_tickets_support_ticket_fk
        FOREIGN KEY (support_ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 🎨 FIGMA LINKS
-- ------------------------------------------------------------
-- A design file attached to a board item. Only the reference is stored — the
-- file key, the node the link pointed at, and the metadata needed to render a
-- card (name, thumbnail) without a Figma round trip on every board load. The
-- design itself never leaves Figma.
--
-- Ownership is one nullable FK per board, with a CHECK that exactly one is set:
-- a real foreign key each way means deleting a ticket or story takes its links
-- with it, which a polymorphic (type, id) pair could not do.
-- ============================================================
CREATE TABLE IF NOT EXISTS figma_links (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER REFERENCES workspace_tickets(id) ON DELETE CASCADE,
    user_story_id INTEGER REFERENCES user_stories(id) ON DELETE CASCADE,
    file_key TEXT NOT NULL,
    -- The specific frame the link pointed at, when it had one.
    node_id TEXT,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    thumbnail_url TEXT,
    -- Figma's own last-edit time, for showing staleness on the card.
    file_modified_at TIMESTAMPTZ,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT figma_links_owner_chk CHECK (
        (ticket_id IS NOT NULL AND user_story_id IS NULL)
        OR (ticket_id IS NULL AND user_story_id IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_figma_links_ticket ON figma_links(ticket_id);
CREATE INDEX IF NOT EXISTS idx_figma_links_story ON figma_links(user_story_id);
-- The same frame attached twice to one item is a duplicate, not a second link.
-- NULLS NOT DISTINCT so a whole-file link (node_id IS NULL) also collides.
CREATE UNIQUE INDEX IF NOT EXISTS uq_figma_links_ticket
    ON figma_links(ticket_id, file_key, node_id) NULLS NOT DISTINCT
    WHERE ticket_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_figma_links_story
    ON figma_links(user_story_id, file_key, node_id) NULLS NOT DISTINCT
    WHERE user_story_id IS NOT NULL;

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
    -- Sub-discriminator within an audience: 'personal' for personal plans,
    -- and 'startups' | 'business' | 'enterprise' for the organization plans.
    -- Lets Business and Enterprise be told apart (audience alone cannot).
    -- App-validated in admin_create_plan, like `audience`.
    tier TEXT NOT NULL DEFAULT 'personal',
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
-- Two personal tiers (Free Personal / Advanced Personal), two organization
-- tiers (Free Organization / Advanced Organization), and one Enterprise tier.
-- `features.bullets` is an ordered list of display strings the UIs render
-- verbatim. Note: the
-- backend re-applies this exact catalog on every boot via an upsert in
-- startup.rs, so this seed only matters for a brand-new volume.
INSERT INTO plans (code, name, description, audience, tier, amount_cents, billing_interval, storage_limit_bytes, seat_limit, features)
VALUES
    ('basic_user', 'Free Personal', 'Free plan for individual accounts.', 'personal', 'personal', 0, 'month', 1073741824, 1,
     '{"bullets":["1 GB encrypted storage","Up to 1,000 emails per day","End-to-end encrypted chat","1 seat"]}'::jsonb),
    ('advance_user', 'Advanced Personal', 'Paid personal plan with higher limits.', 'personal', 'personal', 700, 'month', 10737418240, 1,
     '{"bullets":["10 GB encrypted storage","Unlimited daily emails","1,000 encrypt/decrypt ops per day","Priority email sync"]}'::jsonb),
    ('business_startups', 'Free Organization', 'Free plan for small teams to evaluate org features.', 'organization', 'startups', 0, 'month', 5368709120, 5,
     '{"bullets":["Up to 5 members","5 GB shared storage","Shared org workspace","Admin & billing controls"]}'::jsonb),
    ('organization', 'Advanced Organization', 'For growing organizations up to 100 members.', 'organization', 'business', 1200, 'month', -1, 100,
     '{"bullets":["Up to 100 members","Unlimited storage & email","SSO + role-based access","Audit logs & priority support"]}'::jsonb),
    ('enterprise', 'Enterprise', '100+ members with unlimited everything.', 'organization', 'enterprise', 4900, 'month', -1, 100000,
     '{"bullets":["Unlimited members","Dedicated success manager","Custom onboarding & SLA","SSO, SCIM & advanced security"]}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    audience = EXCLUDED.audience,
    tier = EXCLUDED.tier,
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


-- ============================================================================
-- TENANT TAGGING (RLS phase 1) — tag tenant-owned rows with organization_id.
--
-- Foundation for Postgres Row-Level Security. RLS is NOT enabled here; this only
-- guarantees every tenant-owned row carries a correct organization_id and stays
-- that way via BEFORE INSERT triggers. The one-time backfill for pre-existing
-- rows lives in infra/postgres/migrations/2026-06-org-tagging.sql (applied by
-- hand to running DBs, since init.sql only runs on a fresh volume).
--
-- NOT org-tagged on purpose:
--   * Chat is PARTICIPANT-SCOPED — messages, chat_attachments, channels,
--     channel_members, channel_messages, channel_invites, channel_join_requests
--     are visible by membership, not by org. Do NOT add org RLS to them; phase 2
--     gives them participant policies.
--   * GLOBAL / cross-tenant tables are never org-scoped — users, organizations,
--     organization_members, platform_members, plans, subscriptions, invoices,
--     billing_customers, entitlements, usage_events, api_keys, api_key_audit_log,
--     password_reset_tokens, demo_requests, support_tickets, etc.
-- Many tables already carry organization_id (email_accounts, projects, teams,
-- slack_*, mcp_connections, org_documents, the org-key tables, …) — unchanged.
-- ============================================================================

-- columns (nullable: personal-account rows stay NULL = "no tenant")
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

-- triggers fill organization_id only when the app left it NULL (app-set wins)
CREATE OR REPLACE FUNCTION set_org_from_user_id() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.user_id IS NOT NULL THEN
        SELECT u.organization_id INTO NEW.organization_id FROM users u WHERE u.id = NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_org_from_sender_user_id() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.sender_user_id IS NOT NULL THEN
        SELECT u.organization_id INTO NEW.organization_id FROM users u WHERE u.id = NEW.sender_user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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

CREATE OR REPLACE FUNCTION set_org_from_email_id() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.email_id IS NOT NULL THEN
        SELECT e.organization_id INTO NEW.organization_id FROM emails e WHERE e.id = NEW.email_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_org_from_meeting_id() RETURNS trigger AS $$
BEGIN
    IF NEW.organization_id IS NULL AND NEW.meeting_id IS NOT NULL THEN
        SELECT m.organization_id INTO NEW.organization_id FROM meetings m WHERE m.id = NEW.meeting_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_set_org_notes                BEFORE INSERT ON notes                   FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_tasks                BEFORE INSERT ON tasks                   FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_task_attachments     BEFORE INSERT ON task_attachments        FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_meetings             BEFORE INSERT ON meetings                FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_drive_files          BEFORE INSERT ON drive_files             FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_folders              BEFORE INSERT ON folders                 FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_user_jira            BEFORE INSERT ON user_jira_connections   FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_user_gitlab          BEFORE INSERT ON user_gitlab_connections FOR EACH ROW EXECUTE FUNCTION set_org_from_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_secure_messages      BEFORE INSERT ON secure_messages         FOR EACH ROW EXECUTE FUNCTION set_org_from_sender_user_id();
CREATE OR REPLACE TRIGGER trg_set_org_emails               BEFORE INSERT ON emails                  FOR EACH ROW EXECUTE FUNCTION set_org_emails();
CREATE OR REPLACE TRIGGER trg_set_org_email_attachments    BEFORE INSERT ON email_attachments       FOR EACH ROW EXECUTE FUNCTION set_org_from_email_id();
CREATE OR REPLACE TRIGGER trg_set_org_meeting_participants BEFORE INSERT ON meeting_participants    FOR EACH ROW EXECUTE FUNCTION set_org_from_meeting_id();


-- ============================================================================
-- RLS ENFORCEMENT (phase 2) — pilot table: notes.
--
-- `notes` are PRIVATE PER USER, so the policy is user-scoped: a row is only
-- visible/writable to its owner (`user_id = app.user_id`), or to privileged
-- already-authorized paths that bypass (platform rollups, org-admin member
-- recovery, account/org teardown). GUCs are set transaction-local by the
-- helpers in wayve-server/src/db.rs. Deny-by-default: no GUC set ⇒ no rows.
--
-- The connecting role is a SUPERUSER, which bypasses RLS. So request handlers
-- `SET LOCAL ROLE wayve_app` (the restricted role below) inside an RLS-scoped
-- transaction so the policy engages; workers/migrations/privileged paths stay
-- the superuser and bypass. Every code path that touches `notes` must run
-- inside a db.rs helper; a missed path is a visible 0-rows bug, never a leak.
-- Other tables are NOT yet enforced — migrated one at a time (see docs/plan).
-- ============================================================================

-- Restricted, non-login app role that RLS-scoped transactions SET LOCAL ROLE
-- into. Has read on everything + write on the RLS-enabled tables, so the
-- migrated handlers (which join many tables) keep working under the role.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wayve_app') THEN
        CREATE ROLE wayve_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
    END IF;
END $$;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO wayve_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wayve_app;
GRANT INSERT, UPDATE, DELETE ON notes TO wayve_app;
-- Tables/sequences created later (ensure_email_schema, future migrations) also
-- grant read to wayve_app so newly-added read paths keep working under the role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO wayve_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO wayve_app;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notes_rls ON notes;
CREATE POLICY notes_rls ON notes
    USING (
        current_setting('app.bypass', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::int
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::int
    );

-- RLS phase 2, batch 2 — the rest of the user-private tables. Same user-scoped
-- model as notes; meeting_participants scopes via its parent meeting. wayve_app
-- already has SELECT on all tables; here we add write grants + per-table policy.
DO $$
DECLARE
    t text; owner_col text; i int;
    pairs text[][] := ARRAY[
        ['tasks','user_id'], ['task_attachments','user_id'],
        ['drive_files','user_id'], ['folders','user_id'],
        ['meetings','user_id'], ['secure_messages','sender_user_id'],
        ['reminders','user_id'], ['noise_senders','user_id'],
        ['user_jira_connections','user_id'], ['user_gitlab_connections','user_id']
    ];
BEGIN
    FOR i IN 1 .. array_length(pairs, 1) LOOP
        t := pairs[i][1]; owner_col := pairs[i][2];
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

GRANT INSERT, UPDATE, DELETE ON meeting_participants TO wayve_app;
ALTER TABLE meeting_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meeting_participants_rls ON meeting_participants;
CREATE POLICY meeting_participants_rls ON meeting_participants
    USING (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_participants.meeting_id
                   AND m.user_id = nullif(current_setting('app.user_id', true), '')::int)
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_participants.meeting_id
                   AND m.user_id = nullif(current_setting('app.user_id', true), '')::int)
    );


-- RLS phase 2 — emails. 3-way visibility: mailbox owner (account_id ->
-- email_accounts.user_id), wayve recipient (source='wayve' + recipient_user_id),
-- or shared-inbox member (shared_inbox_members). email_accounts is intentionally
-- NOT RLS-enabled — the policy reads it to resolve ownership/shared membership.
-- email_attachments inherit the parent email's visibility.
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
                              AND sm.user_id = nullif(current_setting('app.user_id', true), '')::int)))
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
                              AND sm.user_id = nullif(current_setting('app.user_id', true), '')::int)))
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


-- RLS phase 2 — chat (participant-scoped). HTTP read endpoints enforce; the
-- WebSocket actor + channel-management writes run as the superuser and bypass.
-- Channel policies resolve membership through a SECURITY DEFINER helper (runs as
-- owner, bypassing RLS) so a policy on channel_members doesn't recurse.
CREATE OR REPLACE FUNCTION app_is_channel_member(cid int, uid int)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM channel_members WHERE channel_id = cid AND user_id = uid)
$$;
GRANT EXECUTE ON FUNCTION app_is_channel_member(int, int) TO wayve_app;
GRANT INSERT, UPDATE, DELETE ON
    messages, channels, channel_members, channel_messages,
    channel_invites, channel_join_requests, chat_attachments,
    message_reactions
TO wayve_app;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_rls ON messages;
CREATE POLICY messages_rls ON messages
    USING (current_setting('app.bypass', true) = 'on'
           OR sender_id   = nullif(current_setting('app.user_id', true), '')::int
           OR receiver_id = nullif(current_setting('app.user_id', true), '')::int)
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR sender_id   = nullif(current_setting('app.user_id', true), '')::int
           OR receiver_id = nullif(current_setting('app.user_id', true), '')::int);

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channels_rls ON channels;
CREATE POLICY channels_rls ON channels
    USING (current_setting('app.bypass', true) = 'on'
           OR created_by = nullif(current_setting('app.user_id', true), '')::int
           OR app_is_channel_member(id, nullif(current_setting('app.user_id', true), '')::int))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR created_by = nullif(current_setting('app.user_id', true), '')::int);

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['channel_members','channel_messages','channel_invites'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_rls', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING (%s) WITH CHECK (%s)',
            t || '_rls', t,
            $f$current_setting('app.bypass', true) = 'on' OR app_is_channel_member(channel_id, nullif(current_setting('app.user_id', true), '')::int)$f$,
            $f$current_setting('app.bypass', true) = 'on' OR app_is_channel_member(channel_id, nullif(current_setting('app.user_id', true), '')::int)$f$
        );
    END LOOP;
END $$;

ALTER TABLE channel_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_join_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_join_requests_rls ON channel_join_requests;
CREATE POLICY channel_join_requests_rls ON channel_join_requests
    USING (current_setting('app.bypass', true) = 'on'
           OR user_id = nullif(current_setting('app.user_id', true), '')::int
           OR app_is_channel_member(channel_id, nullif(current_setting('app.user_id', true), '')::int))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR user_id = nullif(current_setting('app.user_id', true), '')::int);

-- An attachment is visible to the uploader (which also covers the window
-- between upload and send, when both target columns are still NULL) and to
-- whoever can see the message it hangs off. Like the reactions policy below,
-- the EXISTS subqueries lean on the policies above: under `wayve_app`,
-- `messages` only yields rows where the caller is sender/receiver and
-- `channel_messages` only yields rows in channels the caller belongs to — so an
-- attachment on a DM or channel the caller isn't part of matches no branch, and
-- a user removed from a channel loses access to its attachments on the next
-- request. Writes stay self-only: you may only insert/modify rows you uploaded.
ALTER TABLE chat_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_attachments_rls ON chat_attachments;
CREATE POLICY chat_attachments_rls ON chat_attachments
    USING (current_setting('app.bypass', true) = 'on'
           OR uploader_id = nullif(current_setting('app.user_id', true), '')::int
           OR EXISTS (SELECT 1 FROM messages m WHERE m.id = chat_attachments.message_id)
           OR EXISTS (SELECT 1 FROM channel_messages cm
                       WHERE cm.id = chat_attachments.channel_message_id))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR uploader_id = nullif(current_setting('app.user_id', true), '')::int);

-- Reactions are visible to whoever can see the message they hang off. The
-- EXISTS subqueries lean on the policies above: under `wayve_app`, `messages`
-- only yields rows where the caller is sender/receiver, and `channel_messages`
-- only yields rows in channels the caller belongs to — so a reaction on someone
-- else's DM matches neither branch. Writes are self-only: you may add or remove
-- YOUR reaction, never anyone else's.
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_reactions_rls ON message_reactions;
CREATE POLICY message_reactions_rls ON message_reactions
    USING (current_setting('app.bypass', true) = 'on'
           OR EXISTS (SELECT 1 FROM messages m WHERE m.id = message_reactions.message_id)
           OR EXISTS (SELECT 1 FROM channel_messages cm WHERE cm.id = message_reactions.channel_message_id))
    WITH CHECK (current_setting('app.bypass', true) = 'on'
           OR (user_id = nullif(current_setting('app.user_id', true), '')::int
               AND (EXISTS (SELECT 1 FROM messages m WHERE m.id = message_reactions.message_id)
                    OR EXISTS (SELECT 1 FROM channel_messages cm WHERE cm.id = message_reactions.channel_message_id))));
