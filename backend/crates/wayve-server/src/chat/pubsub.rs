//! Cross-instance realtime fan-out subscriber.
//!
//! Two topic families, both PSUBSCRIBEd here, delivered to the matching
//! sessions on this instance so a frame published by any instance reaches the
//! recipient's socket wherever it is held. Spawn once per process.
//!
//! - `ws:user:{id}`: one user's frames (DMs, receipts, presence, reactions on
//!   DMs). Published by `fan_out_user`.
//! - `ws:channel:{id}`: one channel's frames, published ONCE per message by
//!   `fan_out_channel` as `{"to":[ids],"frame":"..."}`. Delivery is limited to
//!   the `to` list, which the publisher read from `channel_members` at send
//!   time, so a stale view of membership here can never leak a frame.
//!
//! Best-effort: with Redis down, both fan-out functions fall back to local
//! delivery, so single-instance deployments work without this subscriber.

use futures::StreamExt;
use std::time::Duration;
use tracing::{info, warn};

use super::websocket::{deliver_channel_local, deliver_local, parse_channel_frame};

const USER_PATTERN: &str = "ws:user:*";
const CHANNEL_PATTERN: &str = "ws:channel:*";

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
    pubsub.psubscribe(USER_PATTERN).await?;
    pubsub.psubscribe(CHANNEL_PATTERN).await?;
    info!(
        target: "ws",
        patterns = ?[USER_PATTERN, CHANNEL_PATTERN],
        "ws pubsub subscriber connected"
    );

    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        let payload: String = match msg.get_payload() {
            Ok(p) => p,
            Err(e) => {
                warn!(target: "ws", error = ?e, "ws pubsub payload decode failed");
                continue;
            }
        };
        route(msg.get_channel_name(), payload);
    }

    // The stream ended, so return Ok and let run_subscriber reconnect.
    Ok(())
}

/// Deliver one pub/sub message by its topic. Unknown topics are ignored.
fn route(topic: &str, payload: String) {
    if let Some(id) = topic.strip_prefix("ws:user:") {
        if let Ok(user_id) = id.parse::<i32>() {
            deliver_local(user_id, payload);
        }
    } else if topic.starts_with("ws:channel:") {
        match parse_channel_frame(&payload) {
            Some(frame) => deliver_channel_local(&frame),
            None => warn!(target: "ws", topic, "malformed channel frame dropped"),
        }
    }
}
