// Pool connect with retries.
//
// Mirrors the dot-counter loop the binary used to embed in `main.rs`:
// log the first failure verbosely, then compact subsequent identical
// failures at power-of-two attempt counts so dev.log stays readable
// during a long Postgres outage.

use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use tracing::{info, warn};

/// Connect to Postgres, retrying forever with a 2-second backoff until
/// the pool comes up. Returns the live `PgPool` once a connection
/// succeeds.
///
/// Logging policy:
///   - first failure: verbose, includes the sqlx error
///   - subsequent failures: compact summary at attempt counts that are
///     powers of two (1, 2, 4, 8, 16, …)
///   - success: a single info line, with the retry count if any
pub async fn connect_with_retries(url: &str, max_connections: u32) -> PgPool {
    let mut attempts: u32 = 0;
    loop {
        match PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(url)
            .await
        {
            Ok(pool) => {
                if attempts > 0 {
                    info!("Connected to Postgres after {} retries", attempts);
                } else {
                    info!("Connected to Postgres");
                }
                return pool;
            }
            Err(e) => {
                if attempts == 0 {
                    warn!("Postgres unavailable, retrying... ({e:?})");
                } else if attempts.is_power_of_two() {
                    warn!("Postgres still unavailable after {} retries", attempts);
                }
                attempts += 1;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}
