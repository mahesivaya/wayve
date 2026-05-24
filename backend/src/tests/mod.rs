// Integration/regression tests. Each file is `#[cfg(test)] mod tests { ... }`
// and imports the items it exercises with explicit `use crate::...` paths.
//
// Tests that touch the database require a Postgres reachable via
// TEST_DATABASE_URL or DATABASE_URL (see test_support::test_pool). CI provides
// one; locally, run `psql "$DATABASE_URL" -f infra/postgres/init.sql` first.
mod ai_handler_test;
mod api_key_audit_outcomes_test;
mod api_key_principal_test;
mod billing_entitlements_test;
mod call_handler_test;
mod chat_handler_test;
mod drive_handler_test;
mod email_body_handler_test;
mod email_handler_test;
mod email_sender_test;
mod email_sync_test;
mod notes_handler_test;
mod rbac_authorization_test;
mod rbac_resolution_test;
mod routes_account_test;
mod routes_api_keys_test;
mod routes_auth_test;
mod routes_user_test;
mod scheduler_handler_test;
mod scheduler_jwt_test;
mod scheduler_zoom_test;
mod security_encryption_test;
// Added in the test-cleanup pass: cover the enterprise surfaces that
// previously had no dedicated test files.
mod embed_tokens_test;
mod quotas_test;
mod scim_tokens_test;
mod webhooks_test;
