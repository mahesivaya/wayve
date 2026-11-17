-- Fix with AI progress (local runner): how far a run has got (0-100) and what
-- it is doing, shown as a bar on the ticket or story. The backend also adds
-- these at boot (startup.rs), so applying this by hand is optional.
ALTER TABLE workspace_tickets ADD COLUMN IF NOT EXISTS ai_fix_progress SMALLINT;
ALTER TABLE workspace_tickets ADD COLUMN IF NOT EXISTS ai_fix_step TEXT;
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_progress SMALLINT;
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_step TEXT;
