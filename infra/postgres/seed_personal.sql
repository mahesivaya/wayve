-- ============================================================
-- Personal test users — plain personal accounts (no RBAC scope).
-- ------------------------------------------------------------
-- Run via scripts/seed_test_users.sh, which supplies :seed_password.
-- Idempotent: re-running resets the seeded accounts' password.
-- Requires the schema (infra/postgres/init.sql) to already be applied.
--
--   Personal scope : <local>@personal.com   (account_type 'personal')
--
-- account_type 'personal' is what makes resolve_role_context() place the
-- user in the Personal scope (no platform/organization membership rows).
-- ============================================================

-- pgcrypto provides crypt()/gen_salt('bf') — produces bcrypt hashes that the
-- backend's bcrypt::verify accepts, so seeded users can log in normally.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO users (email, password, username, account_type, auth_provider)
SELECT local || '@personal.com',
       crypt(:'seed_password', gen_salt('bf')),
       'personal-' || local,
       'personal',
       'local'
FROM (VALUES ('alice'), ('bob'), ('carol'), ('dave'), ('erin')) AS p(local)
ON CONFLICT (email) DO UPDATE
   SET password     = EXCLUDED.password,
       username     = EXCLUDED.username,
       account_type = EXCLUDED.account_type;

-- ---- Summary of seeded accounts ----------------------------
SELECT u.email, u.account_type
FROM users u
WHERE u.email LIKE '%@personal.com'
ORDER BY u.email;
