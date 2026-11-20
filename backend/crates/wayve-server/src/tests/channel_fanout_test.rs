// Channel messages fan out with ONE Redis PUBLISH on `ws:channel:{id}`, not one
// `ws:user:{id}` publish per member. The Redis tests skip themselves when Redis
// is unreachable; CI supplies a Redis service, so they run for real there.

#[cfg(test)]
mod tests {
    use crate::cache::Cache;
    use crate::chat::{ChannelFrame, channel_topic, fan_out_channel, parse_channel_frame};
    use futures::StreamExt;
    use std::time::Duration;

    async fn cache_or_skip() -> Option<Cache> {
        match Cache::connect().await {
            Ok(c) => Some(c),
            Err(_) => {
                eprintln!("Redis unavailable — skipping channel fan-out test");
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
            .unwrap_or_else(|e| panic!("psubscribe {pattern}: {e}"));
        pubsub
    }

    #[test]
    fn channel_topic_contract() {
        assert_eq!(channel_topic(42), "ws:channel:42");
    }

    #[test]
    fn channel_frame_parses_and_rejects_garbage() {
        let raw = r#"{"to":[1,2,3],"frame":"{\"message_id\":7}"}"#;
        assert_eq!(
            parse_channel_frame(raw),
            Some(ChannelFrame {
                to: vec![1, 2, 3],
                frame: "{\"message_id\":7}".to_string(),
            })
        );
        assert_eq!(parse_channel_frame("not json"), None);
        assert_eq!(parse_channel_frame(r#"{"frame":"x"}"#), None);
        assert_eq!(parse_channel_frame(r#"{"to":"1","frame":"x"}"#), None);
    }

    // Without Redis the fallback delivers locally; with no sessions it is a no-op
    // and must not panic.
    #[tokio::test]
    async fn no_cache_falls_back_without_panicking() {
        fan_out_channel(&None, 1, &[1, 2, 3], "{}").await;
        fan_out_channel(&None, 1, &[], "{}").await;
    }

    // The core claim: N members cost exactly one PUBLISH, on the channel topic,
    // carrying the full recipient list and the frame intact; nothing goes to the
    // members' per-user topics.
    #[tokio::test]
    #[serial_test::serial]
    async fn channel_message_is_one_publish_not_one_per_member() {
        let Some(cache) = cache_or_skip().await else {
            return;
        };
        // Ids far outside real data so a dev stack's own traffic can't interfere.
        let channel_id = 2_000_000_000 - (std::process::id() as i32 % 1000);
        let members: Vec<i32> = (0..500).map(|i| 1_900_000_000 + i).collect();
        let payload = r#"{"message_id":1,"content":"WAYVE_CHAT_E2E_V1\n{}"}"#;

        let mut chan_sub = raw_subscriber(&channel_topic(channel_id)).await;
        let mut user_sub = raw_subscriber("ws:user:19*").await;
        let mut chan_stream = chan_sub.on_message();
        let mut user_stream = user_sub.on_message();

        fan_out_channel(&Some(cache), channel_id, &members, payload).await;

        let first = tokio::time::timeout(Duration::from_secs(2), chan_stream.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for the channel publish"))
            .unwrap_or_else(|| panic!("channel subscriber stream ended"));
        assert_eq!(first.get_channel_name(), channel_topic(channel_id));
        let body: String = first
            .get_payload()
            .unwrap_or_else(|e| panic!("payload decode: {e}"));
        let frame = parse_channel_frame(&body)
            .unwrap_or_else(|| panic!("published body is not a channel frame: {body}"));
        assert_eq!(frame.to, members);
        assert_eq!(frame.frame, payload);

        // No second channel publish, and no per-member publish at all.
        assert!(
            tokio::time::timeout(Duration::from_millis(300), chan_stream.next())
                .await
                .is_err(),
            "expected exactly one PUBLISH on the channel topic"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(300), user_stream.next())
                .await
                .is_err(),
            "no ws:user:* publish expected for a channel message"
        );
    }
}
