//! The rate limiter's in-memory fallback, for when Redis can't be asked.
//!
//! Redis is the limiter of record: its counters are shared by every instance.
//! When it is unreachable the choice used to be between refusing every login
//! (which made Redis a hard dependency for signing in) and running unlimited.
//! This keeps the same fixed-window counts in this process instead, so the
//! limited endpoints stay both open and protected.
//!
//! It is per instance: with N instances behind a load balancer a client could
//! get up to N times the limit until Redis is back. That is still a bound, which
//! "unlimited" is not. Counts start over when the process restarts.

use moka::future::Cache as MokaCache;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Upper bound on distinct buckets (one per method, path and client IP), so a
/// flood of addresses can't grow this without limit.
const MAX_BUCKETS: u64 = 100_000;
/// A bucket nobody has touched for this long is dropped. Longer than the longest
/// window any rule uses (15 minutes), so a live window is never forgotten.
const IDLE_EXPIRY: Duration = Duration::from_secs(60 * 60);

struct Window {
    started: Instant,
    count: i64,
}

pub struct LocalRateLimiter {
    buckets: MokaCache<String, Arc<Mutex<Window>>>,
}

impl LocalRateLimiter {
    pub fn new() -> Self {
        Self {
            buckets: MokaCache::builder()
                .max_capacity(MAX_BUCKETS)
                .time_to_idle(IDLE_EXPIRY)
                .build(),
        }
    }

    /// Count one request against `key` and return the count so far in the
    /// current window, as `Cache::increment_with_ttl` does with Redis: the
    /// window opens on the first request and closes `window_secs` later.
    pub async fn hit(&self, key: &str, window_secs: u64) -> i64 {
        self.hit_at(key, window_secs, Instant::now()).await
    }

    async fn hit_at(&self, key: &str, window_secs: u64, now: Instant) -> i64 {
        let bucket = self
            .buckets
            .get_with(key.to_string(), async {
                Arc::new(Mutex::new(Window {
                    started: now,
                    count: 0,
                }))
            })
            .await;
        // Nothing awaits while the lock is held. A poisoned lock still holds a
        // usable count, and a limiter must not start refusing because an
        // unrelated thread panicked.
        let mut window = bucket.lock().unwrap_or_else(|poison| poison.into_inner());
        if now.duration_since(window.started) >= Duration::from_secs(window_secs) {
            window.started = now;
            window.count = 0;
        }
        window.count += 1;
        window.count
    }
}

impl Default for LocalRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

/// The process-wide fallback the middleware uses.
pub static FALLBACK: LazyLock<LocalRateLimiter> = LazyLock::new(LocalRateLimiter::new);

#[cfg(test)]
mod tests {
    use super::*;

    #[actix_web::test]
    async fn counts_each_request_in_the_window() {
        let limiter = LocalRateLimiter::new();
        let start = Instant::now();
        for expected in 1..=4 {
            assert_eq!(limiter.hit_at("rl:a", 60, start).await, expected);
        }
    }

    #[actix_web::test]
    async fn keeps_a_separate_count_per_key() {
        let limiter = LocalRateLimiter::new();
        let now = Instant::now();
        assert_eq!(
            limiter.hit_at("rl:POST:/api/login:1.1.1.1", 60, now).await,
            1
        );
        assert_eq!(
            limiter.hit_at("rl:POST:/api/login:1.1.1.1", 60, now).await,
            2
        );
        // Another client, and the same client on another endpoint, start at one.
        assert_eq!(
            limiter.hit_at("rl:POST:/api/login:2.2.2.2", 60, now).await,
            1
        );
        assert_eq!(
            limiter
                .hit_at("rl:POST:/api/register:1.1.1.1", 300, now)
                .await,
            1
        );
    }

    #[actix_web::test]
    async fn starts_again_once_the_window_has_passed() {
        let limiter = LocalRateLimiter::new();
        let start = Instant::now();
        for _ in 0..12 {
            limiter.hit_at("rl:b", 60, start).await;
        }
        // Still inside the window a second before it ends...
        let almost = start + Duration::from_secs(59);
        assert_eq!(limiter.hit_at("rl:b", 60, almost).await, 13);
        // ...and a fresh one once it has.
        let later = start + Duration::from_secs(60);
        assert_eq!(limiter.hit_at("rl:b", 60, later).await, 1);
        assert_eq!(limiter.hit_at("rl:b", 60, later).await, 2);
    }

    #[actix_web::test]
    async fn the_window_runs_from_the_first_request_not_the_last() {
        let limiter = LocalRateLimiter::new();
        let start = Instant::now();
        limiter.hit_at("rl:c", 60, start).await;
        // A steady trickle must not keep pushing the window's end away.
        let mid = start + Duration::from_secs(40);
        limiter.hit_at("rl:c", 60, mid).await;
        let after = start + Duration::from_secs(61);
        assert_eq!(limiter.hit_at("rl:c", 60, after).await, 1);
    }
}
