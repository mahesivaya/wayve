-- AI usage metering for the owner-only /settings/ai/usage dashboard.
-- Idempotent; safe to re-apply. Mirrors the block added to init.sql.
--
-- One row per assistant turn (all tool-call rounds summed). organization_id is
-- the owner scope: set when the caller's org runs its own AI config, NULL for
-- platform-scope usage (platform members + the platform-default provider).

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

CREATE INDEX IF NOT EXISTS ai_usage_events_org_idx
    ON ai_usage_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_user_idx
    ON ai_usage_events(user_id, created_at DESC);
