-- Drop three redundant indexes. Same DROPs as in init.sql.
--   idx_org_sso_configs_domain    duplicates the UNIQUE (allowed_domain) index
--   idx_notes_user_id             is covered by idx_notes_user_updated (user_id, updated_at DESC)
--   idx_email_contacts_user_addr  duplicates UNIQUE (user_id, address); its
--                                 text_pattern_ops can't serve the ILIKE '%q%' typeahead
--
-- On prod, run each one alone (CONCURRENTLY can't run inside a transaction):
--   DROP INDEX CONCURRENTLY IF EXISTS <name>;
--
-- Idempotent.
DROP INDEX IF EXISTS idx_org_sso_configs_domain;
DROP INDEX IF EXISTS idx_notes_user_id;
DROP INDEX IF EXISTS idx_email_contacts_user_addr;
