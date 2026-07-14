//! Cross-instance realtime fan-out subscriber.
//!
//! Chat publishes every outbound frame to `ws:user:{id}`. This task PSUBSCRIBEs
//! `ws:user:*` and delivers each frame to the matching session on this instance,
//! so a send received on one instance reaches the recipient's socket wherever it
//! is held. Spawn once per process.
//!
//! Best-effort: with Redis down, `fan_out_user` falls back to local delivery, so
//! single-instance deployments work without this subscriber.

use futures::StreamExt;
use std::time::Duration;
use tracing::{info, warn};

use super::websocket::deliver_local;

const PATTERN: &str = "ws:user:*";

/// Run forever, reconnecting with a short backoff if the pub/sub connection
/// drops.
pub async fn run_subscriber() {
    loop {
        if let Err(e) = subscribe_loop().await {
            warn!(target: "ws", error = ?e, "ws pubsub subscriber error — retrying in 3s");
        }
        actix_web::rt::time::sleep(Duration::from_secs(3)).await;
    }
}

async fn subscribe_loop() -> redis::RedisResult<()> {
    let url = crate::config::redis_url();
    let client = redis::Client::open(url)?;
    let mut pubsub = client.get_async_pubsub().await?;
    pubsub.psubscribe(PATTERN).await?;
    info!(target: "ws", pattern = PATTERN, "ws pubsub subscriber connected");

    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(e) => {
                warn!(target: "ws", error = ?e, "ws pubsub payload decode failed");
                continue;
            }
        };
        let user_id = msg
            .get_channel_name()
            .strip_prefix("ws:user:")
            .and_then(|s| s.parse::<i32>().ok());
        if let Some(user_id) = user_id {
            deliver_local(user_id, payload);
        }
    }

    // The stream ended, so return Ok and let run_subscriber reconnect.
    Ok(())
}
