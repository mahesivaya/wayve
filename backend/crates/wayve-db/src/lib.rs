// wayve-db: Postgres connection plumbing for the rwayve workspace.
//
// Owns the env-driven connection-string assembly and the connect-retry
// loop. Per-feature queries and table-specific logic stay in the
// feature module that owns the table; this crate is intentionally
// narrow.

pub mod config;
pub mod pool;
