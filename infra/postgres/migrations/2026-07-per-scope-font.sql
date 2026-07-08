-- Per-scope UI font overrides.
--
-- Extends the platform-wide font (platform_ui_config.font_key) so a user can set
-- their OWN font and an organization owner can set a font for all members. The
-- resolved font is: user's own > their organization's > platform default > the
-- app default. Same short key vocabulary (system|inter|ibm-plex|serif|mono);
-- NULL = inherit the next level.
--
-- Idempotent; safe to re-apply. Mirrors the block added to init.sql. Hand-apply
-- in prod (init.sql only runs on a fresh volume) per the deploy runbook.
ALTER TABLE users         ADD COLUMN IF NOT EXISTS ui_font_key TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ui_font_key TEXT;
