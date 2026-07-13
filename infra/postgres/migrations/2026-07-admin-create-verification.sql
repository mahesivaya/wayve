-- Pre-creation email confirmation for admin-provisioned accounts.
--
-- `POST /admin/users` now refuses to create an account unless the admin hands
-- back a 6-digit code that `POST /admin/users/send-code` mailed to the address.
-- The code is issued BEFORE the users row exists, so it cannot hang off
-- email_verification_tokens.user_id; it is keyed by (requesting admin,
-- account_email) instead. `delivery_email` is where the code was actually
-- mailed, which is not always the account address: org accounts are minted on
-- synthetic <user>@<org-slug>.com domains with no real inbox, so the admin
-- points the code at the person's reachable mailbox.
--
-- MUST be applied BEFORE the code deploy: the create endpoint requires a code,
-- and without this table `send-code` cannot issue one — no admin could create
-- any account until it exists.
--
-- Idempotent; safe to re-apply. Mirrors the block added to init.sql. Hand-apply
-- in prod (init.sql only runs on a fresh volume) per the deploy runbook.
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
