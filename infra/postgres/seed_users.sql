-- ============================================================
-- Seed personal, platform, and organization test users.
-- ------------------------------------------------------------
-- Run via scripts/seed_users.sh, which supplies :seed_password.
-- Idempotent: re-running resets each account's password + role.
-- Requires the schema (infra/postgres/init.sql) to already be applied.
--
-- After running, log in via the UI with any of these credentials:
--   • Personal users    → recovery_mode='full' + no wrapped key on
--                          server → first login generates RSA keys +
--                          a fresh 24-word mnemonic, RecoverySeedModal
--                          appears (must save the words then).
--   • Platform users    → recovery_mode='full' (the only mode the
--                          current schema allows — see the
--                          CHECK (recovery_mode = 'full') constraint).
--   • Organization users → same as platform — recovery_mode='full'.
--
-- The mnemonic is generated client-side; the server never sees it.
-- That's why this script can't print the words to stdout — only the
-- browser running the user's first login knows them.
-- ============================================================

-- pgcrypto provides crypt()/gen_salt('bf') — produces bcrypt hashes
-- that the backend's bcrypt::verify accepts.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================
-- 1. Personal users (account_type='personal', recovery_mode='full')
-- ============================================================
-- First login generates a fresh 24-word mnemonic and shows the
-- RecoverySeedModal. The user must capture the words at that
-- moment — the server never sees them.
WITH personal_seed(email, username) AS (
    VALUES
        ('alice@personal.test',   'alice-personal'),
        ('bob@personal.test',     'bob-personal'),
        ('carol@personal.test',   'carol-personal')
)
INSERT INTO users (
    email,
    password,
    username,
    account_type,
    auth_provider,
    recovery_mode
)
SELECT email,
       crypt(:'seed_password', gen_salt('bf')),
       username,
       'personal',
       'local',
       'full'                                       -- triggers mnemonic flow
FROM personal_seed
ON CONFLICT (email) DO UPDATE
    SET password      = EXCLUDED.password,
        username      = EXCLUDED.username,
        account_type  = EXCLUDED.account_type,
        recovery_mode = EXCLUDED.recovery_mode;


-- ============================================================
-- 2. Platform users (account_type='platform_admin', recovery_mode='full')
-- ============================================================
-- Logged-in scope = Platform. recovery_mode is 'full' because that is
-- the only value the current schema permits. Role lives in
-- platform_members.role; account_type is the discriminator that lands
-- them on the platform-admin home.
WITH role_map(local, role) AS (
    VALUES
        ('owner',      'owner'),
        ('superadmin', 'super_admin'),
        ('admin',      'admin'),
        ('security',   'security'),
        ('billing',    'billing'),
        ('developer',  'developer'),
        ('support',    'support'),
        ('member',     'member'),
        ('guest',      'guest')
),
upserted AS (
    INSERT INTO users (
        email,
        password,
        username,
        account_type,
        auth_provider,
        recovery_mode
    )
    SELECT local || '@platform.com',
           crypt(:'seed_password', gen_salt('bf')),
           'platform-' || local,
           'platform_admin',
           'local',
           'full'                                   -- only schema-allowed mode
    FROM role_map
    ON CONFLICT (email) DO UPDATE
        SET password      = EXCLUDED.password,
            username      = EXCLUDED.username,
            account_type  = EXCLUDED.account_type,
            recovery_mode = EXCLUDED.recovery_mode
    RETURNING id, email
)
INSERT INTO platform_members (user_id, role)
SELECT up.id, rm.role
FROM upserted up
JOIN role_map rm ON up.email = rm.local || '@platform.com'
ON CONFLICT (user_id) DO UPDATE
    SET role = EXCLUDED.role, updated_at = NOW();


-- ============================================================
-- 3. Organization users (account_type='organization_admin',
--    recovery_mode='full', tied to organization "Acme")
-- ============================================================
WITH role_map(local, role) AS (
    VALUES
        ('owner',      'owner'),
        ('superadmin', 'super_admin'),
        ('admin',      'admin'),
        ('security',   'security'),
        ('billing',    'billing'),
        ('developer',  'developer'),
        ('support',    'support'),
        ('member',     'member'),
        ('guest',      'guest')
),
org AS (
    INSERT INTO organizations (name, slug)
    VALUES ('Acme', 'acme')
    ON CONFLICT (name) DO UPDATE
        SET slug = COALESCE(organizations.slug, EXCLUDED.slug)
    RETURNING id
),
upserted AS (
    INSERT INTO users (
        email,
        password,
        username,
        account_type,
        auth_provider,
        recovery_mode,
        organization_id
    )
    SELECT rm.local || '@acme.com',
           crypt(:'seed_password', gen_salt('bf')),
           'acme-' || rm.local,
           'organization_admin',
           'local',
           'full',                                  -- only schema-allowed mode
           (SELECT id FROM org)
    FROM role_map rm
    ON CONFLICT (email) DO UPDATE
        SET password        = EXCLUDED.password,
            username        = EXCLUDED.username,
            account_type    = EXCLUDED.account_type,
            recovery_mode   = EXCLUDED.recovery_mode,
            organization_id = EXCLUDED.organization_id
    RETURNING id, email
)
INSERT INTO organization_members (organization_id, user_id, role)
SELECT (SELECT id FROM org), up.id, rm.role
FROM upserted up
JOIN role_map rm ON up.email = rm.local || '@acme.com'
ON CONFLICT (organization_id, user_id) DO UPDATE
    SET role = EXCLUDED.role, updated_at = NOW();


-- ============================================================
-- 4. Short-lived guest passwords — 24h credential window
-- ============================================================
-- Guest role (in both platform and organization scopes) gets a hard
-- password expiry 24h from now. The login handler refuses to issue
-- a JWT after this timestamp passes, and the JWT it does issue is
-- clamped so its `exp` claim never outlives this value. Re-running
-- the seed bumps the window forward another 24h.
UPDATE users
SET password_valid_until = NOW() + INTERVAL '24 hours'
WHERE id IN (
    SELECT u.id FROM users u
    JOIN platform_members pm ON pm.user_id = u.id
    WHERE pm.role = 'guest'
    UNION
    SELECT u.id FROM users u
    JOIN organization_members om ON om.user_id = u.id
    WHERE om.role = 'guest'
);

-- ============================================================
-- Summary
-- ============================================================
SELECT
    u.email,
    u.account_type,
    u.recovery_mode,
    COALESCE(pm.role, om.role) AS role,
    -- "expires in N hours" is more useful than a raw timestamp when
    -- the operator is reading the seed output. NULL means no expiry.
    CASE
        WHEN u.password_valid_until IS NULL THEN 'never'
        ELSE to_char(u.password_valid_until - NOW(), 'HH24"h "MI"m"')
    END AS password_expires_in
FROM users u
LEFT JOIN platform_members     pm ON pm.user_id = u.id
LEFT JOIN organization_members om ON om.user_id = u.id
WHERE u.email LIKE '%@personal.test'
   OR u.email LIKE '%@platform.com'
   OR u.email LIKE '%@acme.com'
ORDER BY
    CASE u.account_type
        WHEN 'personal'            THEN 1
        WHEN 'platform_admin'      THEN 2
        WHEN 'organization_admin'  THEN 3
        ELSE 4
    END,
    u.email;
