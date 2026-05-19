-- ============================================================
-- RBAC test users — one account per role, in both scopes.
-- ------------------------------------------------------------
-- Run via scripts/seed_rbac_users.sh, which supplies :seed_password.
-- Idempotent: re-running resets the seeded accounts' password and role.
-- Requires the schema (infra/postgres/init.sql) to already be applied.
--
--   Platform scope : <local>@platform.com   (account_type platform_admin)
--   Org "Acme"     : <local>@acme.com       (account_type organization_admin)
--
-- The email local part mostly matches the role, except `super_admin`, whose
-- account is `superadmin@...` (the role string itself keeps the underscore).
-- ============================================================

-- pgcrypto provides crypt()/gen_salt('bf') — produces bcrypt hashes that the
-- backend's bcrypt::verify accepts, so seeded users can log in normally.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- Platform scope: <local>@platform.com ------------------
-- account_type 'platform_admin' is required: it is what makes
-- resolve_role_context() place the user in the Platform scope.
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
    INSERT INTO users (email, password, username, account_type, auth_provider)
    SELECT local || '@platform.com',
           crypt(:'seed_password', gen_salt('bf')),
           'platform-' || local,
           'platform_admin',
           'local'
    FROM role_map
    ON CONFLICT (email) DO UPDATE
       SET password     = EXCLUDED.password,
           username     = EXCLUDED.username,
           account_type = EXCLUDED.account_type
    RETURNING id, email
)
INSERT INTO platform_members (user_id, role)
SELECT up.id, rm.role
FROM upserted up
JOIN role_map rm ON up.email = rm.local || '@platform.com'
ON CONFLICT (user_id) DO UPDATE
   SET role = EXCLUDED.role, updated_at = NOW();

-- ---- Organization scope: <local>@acme.com in org "Acme" ----
-- Every org test user is account_type 'organization_admin' purely so each one
-- lands on the Organization Admin home and you can see the RBAC panel gating.
-- The permission layer keys on organization_members.role, not account_type, so
-- this only affects which landing page they get — not their permissions.
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
    INSERT INTO users (email, password, username, account_type, auth_provider, organization_id)
    SELECT local || '@acme.com',
           crypt(:'seed_password', gen_salt('bf')),
           'acme-' || local,
           'organization_admin',
           'local',
           (SELECT id FROM org)
    FROM role_map
    ON CONFLICT (email) DO UPDATE
       SET password        = EXCLUDED.password,
           username        = EXCLUDED.username,
           account_type    = EXCLUDED.account_type,
           organization_id = EXCLUDED.organization_id
    RETURNING id, email
)
INSERT INTO organization_members (organization_id, user_id, role)
SELECT (SELECT id FROM org), up.id, rm.role
FROM upserted up
JOIN role_map rm ON up.email = rm.local || '@acme.com'
ON CONFLICT (organization_id, user_id) DO UPDATE
   SET role = EXCLUDED.role, updated_at = NOW();

-- ---- Summary of seeded accounts ----------------------------
SELECT u.email,
       u.account_type,
       COALESCE(pm.role, om.role) AS rbac_role
FROM users u
LEFT JOIN platform_members pm ON pm.user_id = u.id
LEFT JOIN organization_members om ON om.user_id = u.id
WHERE u.email LIKE '%@platform.com'
   OR u.email LIKE '%@acme.com'
ORDER BY u.email;
