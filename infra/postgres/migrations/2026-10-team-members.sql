-- ============================================================================
-- Team rosters: persist the members shown on a team page (previously kept only
-- in the browser and lost on reload). Free-form rows, not linked to accounts.
-- Deleting a team deletes its roster.
--
-- Mirrors the block in init.sql. The backend also creates this on boot
-- (startup.rs), so applying it by hand is optional. Idempotent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS team_members (
    id SERIAL PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT,
    email TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members (team_id);
