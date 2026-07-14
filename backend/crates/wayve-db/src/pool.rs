use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use tracing::{info, warn};

/// Connect to Postgres, retrying forever with a 2-second backoff. Only the first
/// failure logs verbosely; later ones log at power-of-two attempt counts, which
/// keeps dev.log readable through a long outage.
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
