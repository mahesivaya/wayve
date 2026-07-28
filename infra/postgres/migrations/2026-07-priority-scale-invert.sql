-- ============================================================================
-- Priority scale inversion: P1 is now the HIGHEST priority and P5 the LOWEST.
--
-- The stored column stays SMALLINT 1..5; only its direction changes. Before
-- this migration 5 meant "Highest"; after it, 1 does. Every row therefore has
-- to be remapped `6 - priority` so existing tickets/tasks/stories keep the
-- real-world urgency they were filed with — otherwise a P5 outage ticket would
-- silently redisplay as "Lowest".
--
-- Ships with the code change that flips the labels, the ORDER BY direction, the
-- Jira/GitLab importers and the AI triage prompt. Apply it in the SAME window as
-- the deploy: between the migration and the new image, ordering reads inverted.
--
-- NOT NATURALLY IDEMPOTENT — `6 - priority` applied twice restores the old
-- scale. The `applied_migrations` guard below makes re-running a no-op, so this
-- file is still safe to re-apply.
--
-- `tasks` has FORCE ROW LEVEL SECURITY, so the UPDATE runs with the same
-- `app.bypass` escape hatch the policies honour.
--
-- Apply by hand (init.sql only runs on a fresh volume). Prod:
--   ssh ... 'docker exec -i rwayve_postgres_prod sh -c \
--     "psql -v ON_ERROR_STOP=1 -U \$POSTGRES_USER -d \$POSTGRES_DB"' \
--     < infra/postgres/migrations/2026-07-priority-scale-invert.sql
--
-- TAKE A BACKUP FIRST — this rewrites every priority value in place.
--
-- Rollback (re-inverts and clears the guard so it can be applied again):
--   BEGIN;
--   SET LOCAL app.bypass = 'on';
--   UPDATE tasks             SET priority = 6 - priority;
--   UPDATE workspace_tickets SET priority = 6 - priority;
--   UPDATE user_stories      SET priority = 6 - priority;
--   DELETE FROM applied_migrations WHERE name = '2026-07-priority-scale-invert';
--   COMMIT;
-- ============================================================================

-- Guard table for migrations that can't be expressed idempotently.
CREATE TABLE IF NOT EXISTS applied_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

BEGIN;

-- Policies on `tasks` (and friends) honour this; without it the UPDATE would
-- silently touch zero rows under FORCE RLS.
SET LOCAL app.bypass = 'on';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM applied_migrations
        WHERE name = '2026-07-priority-scale-invert'
    ) THEN
        RAISE NOTICE 'priority scale already inverted — skipping';
        RETURN;
    END IF;

    -- CHECK (priority BETWEEN 1 AND 5) holds throughout: 6 - [1..5] = [5..1].
    UPDATE tasks             SET priority = 6 - priority;
    UPDATE workspace_tickets SET priority = 6 - priority;
    UPDATE user_stories      SET priority = 6 - priority;

    INSERT INTO applied_migrations (name)
    VALUES ('2026-07-priority-scale-invert');

    RAISE NOTICE 'priority scale inverted: P1 is now Highest';
END $$;

COMMIT;

-- The "most important first" indexes were built DESC. `CREATE INDEX IF NOT
-- EXISTS` in init.sql cannot alter an index that already exists, so drop and
-- rebuild them to match the new ASC ordering. Safe to re-run.
DROP INDEX IF EXISTS idx_tasks_user_priority;
CREATE INDEX IF NOT EXISTS idx_tasks_user_priority
ON tasks (user_id, priority ASC, created_at DESC);

DROP INDEX IF EXISTS idx_tasks_user_open_priority;
CREATE INDEX IF NOT EXISTS idx_tasks_user_open_priority
ON tasks (user_id, priority ASC, created_at DESC)
WHERE status != 'done';
