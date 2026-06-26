-- ============================================================================
-- RLS phase 2, pilot: enforce tenant isolation on `notes`.
--
-- `notes` are PRIVATE PER USER (not org-shared), so the policy is user-scoped:
-- a row is visible/writable only to its owner (`user_id = app.user_id`), or to
-- privileged, already-authorized paths that set `app.bypass = 'on'` (platform
-- storage rollups, org-admin member recovery, account/org teardown).
--
-- FORCE is required because the app connects as the table OWNER (`wayve_user` /
-- `rwayve`), which otherwise bypasses RLS. The GUCs are set transaction-local by
-- the helpers in wayve-server/src/db.rs, so they never leak across pooled
-- connections. Deny-by-default: a connection with neither GUC set sees no rows.
--
-- Idempotent + safe to re-run. Apply by hand to the dev DB:
--   docker exec -i rwayve_postgres_dev psql -U wayve_user -d wayve_dev \
--     < infra/postgres/migrations/2026-06-rls-notes.sql
-- (NOT applied to prod this cycle — pilot is dev-only.)
--
-- Rollback:  ALTER TABLE notes NO FORCE ROW LEVEL SECURITY;
--            ALTER TABLE notes DISABLE ROW LEVEL SECURITY;
-- ============================================================================

-- Restricted, non-login app role. RLS-scoped request transactions SET LOCAL
-- ROLE into it so the policy engages (the connecting role is a superuser, which
-- bypasses RLS). Read on everything + write on RLS tables.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wayve_app') THEN
        CREATE ROLE wayve_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
    END IF;
END $$;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO wayve_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO wayve_app;
GRANT INSERT, UPDATE, DELETE ON notes TO wayve_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO wayve_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO wayve_app;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notes_rls ON notes;
CREATE POLICY notes_rls ON notes
    USING (
        current_setting('app.bypass', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::int
    )
    WITH CHECK (
        current_setting('app.bypass', true) = 'on'
        OR user_id = nullif(current_setting('app.user_id', true), '')::int
    );
