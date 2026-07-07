-- Platform-wide UI settings (singleton).
--
-- Set by the platform owner and served to every client via the public
-- GET /api/config, so the whole app shares one look. `font_key` is a short key
-- (system|inter|ibm-plex|serif|mono) the frontend maps to a CSS font stack;
-- NULL = the app default.
--
-- Idempotent; safe to re-apply. Mirrors the block added to init.sql. Hand-apply
-- in prod (init.sql only runs on a fresh volume) per the deploy runbook.
CREATE TABLE IF NOT EXISTS platform_ui_config (
    id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    font_key   TEXT,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);
