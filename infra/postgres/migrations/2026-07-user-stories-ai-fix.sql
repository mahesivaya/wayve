-- ============================================================================
-- AI fix for User Stories: give `user_stories` the same `ai_fix_*` review state
-- `workspace_tickets` already carries, so a story can run the identical
-- pipeline — dispatch CI → review the diff → edit → Commit → Push → Create PR.
--
-- Stories are gated to P5 (Lowest) only, tickets to P4 (Low) and below; that
-- floor lives in tickets/handler.rs (AiFixTarget::min_priority), not here.
--
-- Purely additive and idempotent — safe to re-run. Apply by hand (init.sql only
-- runs on a fresh volume). Prod:
--   ssh ... 'docker exec -i rwayve_postgres_prod sh -c \
--     "psql -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d \$POSTGRES_DB"' \
--     < infra/postgres/migrations/2026-07-user-stories-ai-fix.sql
--
-- Rollback:
--   ALTER TABLE user_stories
--     DROP COLUMN IF EXISTS ai_fix_status,     DROP COLUMN IF EXISTS ai_fix_diff,
--     DROP COLUMN IF EXISTS ai_fix_files,      DROP COLUMN IF EXISTS ai_fix_base_sha,
--     DROP COLUMN IF EXISTS ai_fix_commit_sha, DROP COLUMN IF EXISTS ai_fix_branch,
--     DROP COLUMN IF EXISTS ai_fix_pr_url;
-- ============================================================================

-- ai_fix_status ∈ (running|ready|committed|pushed|pr_opened|no_change|error).
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_status TEXT;
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_diff TEXT;
-- The changed files as a JSON array [{path, content(base64), deleted}]. This —
-- not the diff — is what the Commit step turns into blobs, so the in-app editor
-- writes here when a developer adjusts the proposed change.
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_files JSONB;
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_base_sha TEXT;
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_commit_sha TEXT;
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_branch TEXT;
ALTER TABLE user_stories ADD COLUMN IF NOT EXISTS ai_fix_pr_url TEXT;
