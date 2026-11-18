-- Pausing AI. An organization's owner can pause it for the whole organization
-- or for individual members; the platform owner can pause it for any
-- organization. The platform's pause is its own column so an organization's
-- owner cannot lift it.
--
-- Idempotent.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS ai_paused             BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS ai_paused_by_platform BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN NOT NULL DEFAULT FALSE;
