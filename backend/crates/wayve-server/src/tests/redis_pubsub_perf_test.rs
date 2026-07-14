// Performance and correctness of the Redis pub/sub fan-out behind realtime chat.
// These exercise `Cache::publish` against the `ws:user:{id}` channel contract
// that the `chat::pubsub` subscriber depends on. Each test skips itself when
// Redis is unreachable, so a local run without REDIS_URL passes rather than
// fails; CI supplies a Redis service, so they run for real there.

#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use futures::StreamExt;
    use std::time::{Duration, Instant};

    // Mirrors the private `chat::websocket::user_channel`, restating the channel
    // name contract that the subscriber depends on.
    fn user_channel(user_id: i32) -> String {
        format!("ws:user:{user_id}")
    }

    /// Returns None when Redis is unreachable, which callers treat as "skip".
    async fn cache_or_skip() -> Option<Cache> {
        match Cache::connect().await {
            Ok(c) => Some(c),
            Err(_) => {
                eprintln!("Redis unavailable — skipping redis pub/sub perf test");
                None
            }
        }
    }

    async fn raw_subscriber(pattern: &str) -> redis::aio::PubSub {
        let client = redis::Client::open(crate::config::redis_url())
            .unwrap_or_else(|e| panic!("redis client open: {e}"));
        let mut pubsub = client
            .get_async_pubsub()
            .await
            .unwrap_or_else(|e| panic!("redis pubsub connect: {e}"));
        pubsub
            .psubscribe(pattern)
            .await
            .unwrap_or_else(|e| panic!("psubscribe: {e}"));
        pubsub
    }

    // A published frame must reach a subscriber on the ws:user:* pattern with its
    // payload intact. The latency ceiling is deliberately generous so the test
    // stays non-flaky in CI.
    #[tokio::test]
    #[serial_test::serial]
    async fn publish_reaches_subscriber_with_low_latency() {
        let Some(cache) = cache_or_skip().await else {
            return;
        };

        let mut pubsub = raw_subscriber("ws:user:*").await;
        let mut stream = pubsub.on_message();

        let channel = user_channel(4242);
        let payload = "WAYVE_CHAT_E2E_V1\n{\"hello\":\"world\"}";

        let start = Instant::now();
        let published = cache.publish(&channel, payload).await;
        assert!(published, "publish should report success when Redis is up");

        let received = tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for published message"))
            .unwrap_or_else(|| panic!("pubsub stream closed unexpectedly"));
        let latency = start.elapsed();

        let got_channel = received.get_channel_name().to_string();
        let got_payload: String = received
            .get_payload()
            .unwrap_or_else(|e| panic!("decode payload: {e}"));

        assert_eq!(got_channel, channel, "delivered on the wrong channel");
        assert_eq!(got_payload, payload, "payload corrupted in transit");
        assert!(
            latency < Duration::from_millis(500),
            "pub/sub round-trip too slow: {latency:?}"
        );
        eprintln!("pub/sub round-trip latency: {latency:?}");
    }

    // A burst of publishes must stay within budget, which is what would catch a
    // regression that made fan-out blocking.
    #[tokio::test]
    #[serial_test::serial]
    async fn publish_throughput_is_within_budget() {
        let Some(cache) = cache_or_skip().await else {
            return;
        };

        const N: usize = 500;
        let channel = user_channel(4243);
        let payload = "WAYVE_CHAT_E2E_V1\n{\"n\":1}";

        let start = Instant::now();
        for _ in 0..N {
            cache.publish(&channel, payload).await;
        }
        let elapsed = start.elapsed();
        let per_msg = elapsed / N as u32;
        let rate = N as f64 / elapsed.as_secs_f64();
        eprintln!("published {N} msgs in {elapsed:?} ({per_msg:?}/msg, {rate:.0} msg/s)");

        assert!(
            elapsed < Duration::from_secs(10),
            "publishing {N} messages took too long: {elapsed:?}"
        );
    }

    // The cache health check behind the readiness probe must round-trip quickly.
    #[tokio::test]
    #[serial_test::serial]
    async fn ping_round_trips() {
        let Some(cache) = cache_or_skip().await else {
            return;
        };
        let start = Instant::now();
        assert!(cache.ping().await, "PING should succeed when Redis is up");
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "PING too slow"
        );
    }
}
