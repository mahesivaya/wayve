use crate::email::sync::sync_due_accounts;
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Instant;
use tokio::time::{Duration, sleep};
use tracing::{Instrument, error, info, warn};

// The shortest interval in the adaptive ladder. Every tick, sync_due_accounts
// narrows this to the accounts their per-account schedule says are due, so quiet
// accounts stay deferred across many ticks while hot ones run every tick. Errors
// back off exponentially to MAX_ERROR_BACKOFF so a broken provider can't hammer.
const WORKER_TICK: Duration = Duration::from_secs(30);
const MAX_ERROR_BACKOFF: Duration = Duration::from_secs(300);

pub async fn run_sync_worker(pool: PgPool) -> ! {
    // In-memory, so a restart re-syncs every account once (an empty map means
    // "due now"), which is the behavior we want at startup anyway.
    let mut schedule: HashMap<i32, Instant> = HashMap::new();
    let mut error_backoff = WORKER_TICK;
    info!("Sync worker started (adaptive backoff: 30s/60s/5min/30min)");

    loop {
        let span = tracing::info_span!(target: "worker", "sync_worker_cycle");
        let result = async { sync_due_accounts(&pool, &mut schedule).await }
            .instrument(span)
            .await;

        let sleep_for = match result {
            Ok(()) => {
                error_backoff = WORKER_TICK;
                WORKER_TICK
            }
            Err(e) => {
                error!("Sync cycle failed: {:?}", e);
                error_backoff = std::cmp::min(error_backoff * 2, MAX_ERROR_BACKOFF);
                warn!("Sync error backoff: {:?}", error_backoff);
                error_backoff
            }
        };

        sleep(sleep_for).await;
    }
}
