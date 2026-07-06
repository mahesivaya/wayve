-- Per-user GitHub OAuth connection (personal accounts).
--
-- Stores the access token a personal user grants when they "Connect GitHub" so
-- the proxy can act as THEM (import their own public + private repos) instead of
-- the shared GITHUB_TOKEN PAT. The token is encrypted at rest with AES-256-GCM
-- (wayve_security::encryption) — the `*_iv` / `*_encrypted` pair mirrors
-- org_sso_configs.client_secret_*. Never stored or transmitted in plaintext.
--
-- Idempotent; safe to re-run. Hand-apply in prod (init.sql only runs on a fresh
-- volume) per the deploy runbook.
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
