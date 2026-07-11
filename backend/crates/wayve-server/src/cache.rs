use moka::future::Cache as MokaCache;
use redis::AsyncCommands;
use redis::aio::MultiplexedConnection;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::time::Duration;
use tracing::{instrument, warn};

#[derive(Clone)]
pub struct Cache {
    conn: MultiplexedConnection,
    local_json: MokaCache<String, String>,
}

impl Cache {
    #[instrument(target = "cache")]
    pub async fn connect() -> Result<Self, redis::RedisError> {
        let url = crate::config::redis_url();
        let client = redis::Client::open(url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self {
            conn,
            local_json: local_json_cache(),
        })
    }

    #[instrument(target = "cache", skip(self), fields(key))]
    #[allow(dead_code)]
    pub async fn get_json<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        if let Some(raw) = self.local_json.get(key).await {
            return serde_json::from_str(&raw).ok();
        }

        let mut conn = self.conn.clone();
        let raw: Option<String> = conn.get(key).await.ok()?;
        let raw = raw?;
        self.local_json.insert(key.to_string(), raw.clone()).await;
        serde_json::from_str(&raw).ok()
    }

    #[instrument(target = "cache", skip(self, value), fields(key, ttl_secs))]
    #[allow(dead_code)]
    pub async fn set_json_with_ttl<T: Serialize>(&self, key: &str, value: &T, ttl_secs: u64) {
        let raw = match serde_json::to_string(value) {
            Ok(s) => s,
            Err(e) => {
                warn!(target: "cache", key, error = ?e, "cache serialize failed");
                return;
            }
        };

        self.local_json.insert(key.to_string(), raw.clone()).await;

        let mut conn = self.conn.clone();
        let res: redis::RedisResult<()> = conn.set_ex(key, raw, ttl_secs).await;
        if let Err(e) = res {
            warn!(target: "cache", key, error = ?e, "redis SETEX failed");
        }
    }

    #[instrument(target = "cache", skip(self), fields(key))]
    pub async fn del(&self, key: &str) {
        self.local_json.invalidate(key).await;
        let mut conn = self.conn.clone();
        let _: redis::RedisResult<()> = conn.del(key).await;
    }

    /// Publish a payload to a Redis pub/sub channel. Used to fan WebSocket
    /// messages out across backend instances (the subscriber on whichever
    /// instance holds the recipient's socket delivers it locally). Returns
    /// `true` on success so callers can fall back to local delivery if Redis
    /// is momentarily unavailable.
    #[instrument(target = "cache", skip(self, payload), fields(channel))]
    pub async fn publish(&self, channel: &str, payload: &str) -> bool {
        let mut conn = self.conn.clone();
        let res: redis::RedisResult<i64> = conn.publish(channel, payload).await;
        match res {
            Ok(_) => true,
            Err(e) => {
                warn!(target: "cache", channel, error = ?e, "redis PUBLISH failed");
                false
            }
        }
    }

    /// Round-trips a `PING` to confirm Redis is reachable. Used by the
    /// readiness probe; never panics — a transport error just means "down".
    #[instrument(target = "cache", skip(self))]
    pub async fn ping(&self) -> bool {
        let mut conn = self.conn.clone();
        let res: redis::RedisResult<String> = redis::cmd("PING").query_async(&mut conn).await;
        res.is_ok()
    }

    /// Read a counter key (set by `increment_with_ttl`) without incrementing
    /// it. Returns `None` if the key doesn't exist or the value isn't a
    /// parseable integer. Used by the quota-view endpoint so the dashboard
    /// can show "used / limit" without spending a quota slot itself.
    #[instrument(target = "cache", skip(self), fields(key))]
    pub async fn get_counter(&self, key: &str) -> Option<i64> {
        let mut conn = self.conn.clone();
        let raw: Option<String> = conn.get(key).await.ok()?;
        raw?.parse::<i64>().ok()
    }

    /// Add/update a member's score in a sorted set (`ZADD`). Presence stores
    /// `user_id → last-heartbeat unix seconds` in the `presence:online` set so
    /// online-ness is a cross-instance freshness check rather than per-process
    /// state. Best-effort: a Redis blip just means the score isn't refreshed
    /// this tick, and the sweeper reaps it as stale.
    #[instrument(target = "cache", skip(self), fields(key, member, score))]
    pub async fn zadd(&self, key: &str, member: &str, score: i64) {
        let mut conn = self.conn.clone();
        let res: redis::RedisResult<()> = conn.zadd(key, member, score).await;
        if let Err(e) = res {
            warn!(target: "cache", key, member, error = ?e, "redis ZADD failed");
        }
    }

    /// A member's score in a sorted set (`ZSCORE`), or `None` if absent. Read
    /// as `f64` (Redis stores sorted-set scores as doubles) and truncated back
    /// to the integer unix-seconds we wrote.
    #[instrument(target = "cache", skip(self), fields(key, member))]
    pub async fn zscore(&self, key: &str, member: &str) -> Option<i64> {
        let mut conn = self.conn.clone();
        let res: redis::RedisResult<Option<f64>> = conn.zscore(key, member).await;
        res.ok().flatten().map(|s| s as i64)
    }

    /// Members of a sorted set whose score is within `[min, max]`
    /// (`ZRANGEBYSCORE`). `min`/`max` accept Redis range syntax (`"-inf"`,
    /// `"+inf"`, or a stringified bound). The presence sweeper calls this with
    /// `("-inf", cutoff)` to find stale sessions.
    #[instrument(target = "cache", skip(self), fields(key, min, max))]
    pub async fn zrangebyscore(&self, key: &str, min: &str, max: &str) -> Vec<String> {
        let mut conn = self.conn.clone();
        let res: redis::RedisResult<Vec<String>> = conn.zrangebyscore(key, min, max).await;
        res.unwrap_or_default()
    }

    /// Remove a member from a sorted set (`ZREM`); returns the number removed
    /// (0 or 1). The presence sweeper uses the return value as a race guard so
    /// exactly one instance announces a given user offline.
    #[instrument(target = "cache", skip(self), fields(key, member))]
    pub async fn zrem(&self, key: &str, member: &str) -> i64 {
        let mut conn = self.conn.clone();
        let res: redis::RedisResult<i64> = conn.zrem(key, member).await;
        res.unwrap_or(0)
    }

    #[instrument(target = "cache", skip(self), fields(key, ttl_secs))]
    pub async fn increment_with_ttl(&self, key: &str, ttl_secs: u64) -> redis::RedisResult<i64> {
        let mut conn = self.conn.clone();
        let count: i64 = conn.incr(key, 1).await?;

        if count == 1 {
            let _: bool = conn.expire(key, ttl_secs as i64).await?;
        }

        Ok(count)
    }
}

/// A bounded, time-to-live in-memory cache — a thin wrapper over
/// `moka::future::Cache` that bundles the builder boilerplate. Used for the
/// per-feature lookup caches (user profiles, `/me`, email bodies, ...) so each
/// is one `TtlCache::new(capacity, ttl)` instead of a repeated builder chain.
pub struct TtlCache<K, V> {
    inner: MokaCache<K, V>,
}

impl<K, V> TtlCache<K, V>
where
    K: std::hash::Hash + Eq + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    /// A cache holding at most `max_capacity` entries, each expiring
    /// `ttl_secs` after insertion.
    pub fn new(max_capacity: u64, ttl_secs: u64) -> Self {
        Self {
            inner: MokaCache::builder()
                .max_capacity(max_capacity)
                .time_to_live(Duration::from_secs(ttl_secs))
                .build(),
        }
    }

    pub async fn get(&self, key: &K) -> Option<V> {
        self.inner.get(key).await
    }

    pub async fn insert(&self, key: K, value: V) {
        self.inner.insert(key, value).await;
    }

    pub async fn invalidate(&self, key: &K) {
        self.inner.invalidate(key).await;
    }
}

fn local_json_cache() -> MokaCache<String, String> {
    let ttl_secs = crate::config::local_json_cache_ttl_secs();
    let max_capacity = crate::config::local_json_cache_max_capacity();

    MokaCache::builder()
        .max_capacity(max_capacity)
        .time_to_live(Duration::from_secs(ttl_secs))
        .build()
}

pub fn chat_history_key(a: i32, b: i32) -> String {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    format!("chat:msgs:{}:{}", lo, hi)
}
