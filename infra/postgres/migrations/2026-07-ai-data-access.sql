-- AI data-access controls (platform team).
--
-- Per-data-category gate for the platform assistant's native tools. The platform
-- owner toggles these on the AI Settings page; the agent only declares (and
-- dispatches) tools whose category is allowed. Only categories that have native
-- tools today are stored (email, calendar); the others (chat, drive, notes,
-- tasks) have no AI tools yet.
--
-- REQUIRED in prod: resolve_ai_for_user now SELECTs these columns for platform
-- members, so the AI assistant errors for platform callers until they exist.
--
-- Idempotent; safe to re-apply. Mirrors the block added to init.sql. Hand-apply
-- in prod (init.sql only runs on a fresh volume) per the deploy runbook.
ALTER TABLE platform_ai_config
    ADD COLUMN IF NOT EXISTS ai_allow_email    BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS ai_allow_calendar BOOLEAN NOT NULL DEFAULT TRUE;
