-- ============================================================================
-- Per-organization AI provider selection.
--
-- The enterprise OWNER chooses which AI the org's assistant runs on (provider +
-- model + their own API key / endpoint). Every member of the org then uses that
-- one provider — the AI resolves it by the caller's organization, with no
-- per-user override. Configure is owner-only + enterprise-tier (handler gate);
-- the key is encrypted at rest (iv + ciphertext) via wayve_security::encryption.
--
-- Mirrors slack_connections / org_sso_configs: org-keyed, encrypted secret, NOT
-- row-level-secured (owner-gated at the handler). Idempotent — safe to re-run.
--
-- Apply by hand (init.sql only runs on a fresh volume):
--   dev:  docker exec -i rwayve_postgres_dev psql -U wayve_user -d wayve_dev \
--           < infra/postgres/migrations/2026-06-org-ai-configs.sql
--   prod: back up first, then run the same file against the prod DB.
-- ============================================================================

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
