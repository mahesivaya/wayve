// Integration/regression tests. Each file is `#[cfg(test)] mod tests { ... }`
// and imports the items it exercises with explicit `use crate::...` paths.
//
// Tests that touch the database require a Postgres reachable via
// TEST_DATABASE_URL or DATABASE_URL (see test_support::test_pool). CI provides
// one; locally, run `psql "$DATABASE_URL" -f infra/postgres/init.sql` first.
//
// Scope: pared down to a security-critical core for solo development. The
// deleted suites covered CRUD-shaped endpoints — easy to verify manually
// with `curl` and the live UI, and not worth the maintenance cost at this
// scale. The kept files cover surfaces where bugs are silent (encryption,
// authorization, JWT, signing) plus the new long-term API contracts
// (webhooks event catalog, embed tokens, SCIM, rate-limit tiers).
mod email_provider_isp_test;
mod rbac_authorization_test;
mod rbac_permissions_golden_test;
mod rbac_resolution_test;
mod scheduler_create_meeting_validation_test;
mod scheduler_jwt_test;
mod scheduler_mail_delivery_test;
mod scheduler_zoom_test;
mod security_encryption_test;

// Long-term API contracts — adding/changing these has customer-visible
// blast radius, so the tests stay.
mod embed_tokens_test;
mod quotas_test;
mod scim_tokens_test;
mod webhooks_test;
