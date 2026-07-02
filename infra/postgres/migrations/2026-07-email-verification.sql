-- Email verification on personal signup. Idempotent.
--
-- `users.email_verified` defaults TRUE so every existing user (and all
-- OAuth/SCIM/business signups) is grandfathered in and never locked out;
-- only new personal `/api/register` signups insert FALSE and must confirm
-- via the emailed link before they can log in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;

-- Single-use, short-lived 6-digit verification codes. `token` holds the code
-- and is NOT unique (codes collide across users); verification is scoped to the
-- user + `attempts` bounds brute force.
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

-- If an earlier (link-based) version of this table already exists: add the
-- attempts column and drop the now-wrong UNIQUE(token) constraint (codes
-- are not globally unique).
ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_verification_tokens DROP CONSTRAINT IF EXISTS email_verification_tokens_token_key;
