// Database-related env readers.
//
// Mirrors the shape of wayve-security/src/config.rs: each accessor reads
// the process env on every call, so env-mutating tests in either crate
// remain correct without a global cache to invalidate.

use std::env;

use tracing::warn;

/// Resolve the Postgres connection string.
///
/// An explicit `DATABASE_URL` always wins — docker-compose, CI, and prod
/// set it directly. Otherwise it is derived from the `POSTGRES_*` parts
/// so the credentials are written exactly once (in `.env.secrets`)
/// rather than being duplicated inside a `DATABASE_URL` string.
/// `POSTGRES_HOST` defaults to `localhost` for a local `cargo run`;
/// docker sets it to `postgres_db`.
pub fn database_url() -> String {
    if let Ok(url) = env::var("DATABASE_URL") {
        let url = url.trim();
        if !url.is_empty() {
            return url.to_string();
        }
    }

    let part = |key: &str, default: &str| -> String {
        env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default.to_string())
    };

    let user = part("POSTGRES_USER", "wayve_user");
    let password = part("POSTGRES_PASSWORD", "");
    let host = part("POSTGRES_HOST", "localhost");
    let port = part("POSTGRES_PORT", "5432");
    let db = part("POSTGRES_DB", "wayve_dev");
    format!("postgres://{user}:{password}@{host}:{port}/{db}")
}

/// Resolve the max-connections pool size.
///
/// Caller passes a `default` so the per-role policy (api gets 10,
/// workers get 5) stays in wayve-server, where the `RuntimeRole` enum
/// lives. `DATABASE_MAX_CONNECTIONS` always wins if it parses as u32.
pub fn database_max_connections(default: u32) -> u32 {
    if let Ok(value) = env::var("DATABASE_MAX_CONNECTIONS") {
        if let Ok(parsed) = value.parse::<u32>() {
            return parsed;
        }
        warn!(
            value,
            "Invalid DATABASE_MAX_CONNECTIONS value; using caller default"
        );
    }
    default
}
