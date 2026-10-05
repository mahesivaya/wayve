-- ============================================================================
-- Login credential scheme: stop the server from receiving users' passwords.
--
-- auth_scheme 1 = legacy, `users.password` is bcrypt(raw password).
-- auth_scheme 2 = `users.password` is bcrypt(auth_key); the browser derives
--   auth_key = PBKDF2-SHA256("wayve-auth-v1:" + password, auth_salt, 600k)
--   and never sends the password. Existing users stay on 1 and upgrade on
--   their next login.
--
-- Mirrors the block in init.sql. The backend also applies these on boot
-- (startup.rs), so applying this by hand is optional. Idempotent.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_scheme SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_scheme_check;
ALTER TABLE users ADD CONSTRAINT users_auth_scheme_check CHECK (auth_scheme IN (1, 2));
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_salt TEXT;
