use crate::email::sync::sync_all;
use sqlx::PgPool;
use tokio::time::{Duration, sleep};
use tracing::{Instrument, error, info, warn};

pub async fn run_sync_worker(pool: PgPool) -> ! {
    let mut interval = Duration::from_secs(30);
    info!("Sync worker started");

    loop {
        let span = tracing::info_span!(target: "worker", "sync_worker_cycle");
        interval = async {
            match sync_all(&pool).await {
                Ok(_) => {
                    info!("Sync cycle success");
                    Duration::from_secs(30)
                }
                Err(e) => {
                    error!("Sync cycle failed: {:?}", e);
                    let backoff = std::cmp::min(interval * 2, Duration::from_secs(300));
                    warn!("Sync backoff: {:?}", backoff);
                    backoff
                }
            }
        }
        .instrument(span)
        .await;

        sleep(interval).await;
    }
}
