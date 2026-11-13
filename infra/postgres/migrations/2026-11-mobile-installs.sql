-- Mobile app installs, self-reported by the app on every launch
-- (POST /api/mobile/installs), shown on the platform Analytics page
-- (GET /api/platform/mobile-installs). Same block as in init.sql.
--
-- Idempotent.
CREATE TABLE IF NOT EXISTS mobile_installs (
    id BIGSERIAL PRIMARY KEY,
    install_id TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    channel TEXT,
    app_version TEXT,
    build TEXT,
    os_version TEXT,
    device_model TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip TEXT,
    country TEXT,
    region TEXT,
    city TEXT,
    launches INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mobile_installs_first_seen
    ON mobile_installs (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_installs_last_seen
    ON mobile_installs (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_installs_ip_first_seen
    ON mobile_installs (ip, first_seen_at DESC);
