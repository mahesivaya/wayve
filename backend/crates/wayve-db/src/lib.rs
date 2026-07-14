// Postgres connection plumbing: env-driven connection-string assembly and the
// connect-retry loop. Queries and table-specific logic belong in the feature
// module that owns the table, not here.

pub mod config;
pub mod pool;
