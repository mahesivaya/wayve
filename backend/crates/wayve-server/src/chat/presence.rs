//! User online/offline presence.
//!
//! Two-layer design so it works on a single EC2 box today and across many ECS
//! tasks tomorrow:
//!
//! * **Live (option A)** — a Redis sorted set `presence:online` maps
//!   `user_id → last-heartbeat unix seconds`. A user is *online* when that
//!   score is fresh (within [`STALE_AFTER_SECS`]). Any instance holding one of
//!   the user's sockets refreshes the score on every heartbeat, so multiple
//!   tabs / multiple instances collapse to one presence with no counters to
//!   leak. When Redis is absent we fall back to the per-process session
//!   registry ([`crate::chat::websocket::is_online_local`]) — correct for a
//!   single instance, which is exactly when Redis is optional.
//! * **Durable (option B)** — `users.last_seen` is stamped on connect,
//!   disconnect, and stale-reap, so an *offline* user still shows
//!   "last seen …". The snapshot endpoint reads it.
//!
//! Presence *changes* are pushed only to a user's contacts (DM partners +
//! channel co-members) over the existing `ws:user:*` fan-out, so the dot flips
//! live without a poll. Connect broadcasts online immediately. Offline is
//! announced the instant a user's *last* socket closes: a per-user live-socket
//! counter (`presence:conns:{id}`, shared across instances) is incremented on
//! connect and decremented on disconnect, and when it reaches zero we remove
//! the score and announce offline right away — multi-tab and multi-instance
//! safe (another live socket keeps the count above zero). [`run_sweeper`] is
//! the crash-safe backstop: if an instance dies without decrementing, the score
//! goes stale and the sweep reaps it (clearing the leaked counter too).

use crate::cache::Cache;
use crate::prelude::*;
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

use super::websocket::{fan_out_user, is_online_local};

/// Redis sorted set holding `user_id → last-heartbeat unix seconds`.
const PRESENCE_KEY: &str = "presence:online";
/// Per-user live-socket counter key. Counts open chat sockets across all
/// instances so the last close can flip the user offline immediately.
fn conns_key(user_id: i32) -> String {
    format!("presence:conns:{user_id}")
}
/// A session whose last heartbeat is older than this is considered offline.
/// Must comfortably exceed the chat heartbeat interval (25s) so a live client
/// is never flapped offline between beats.
const STALE_AFTER_SECS: i64 = 45;
/// How often the sweeper scans for stale sessions to reap + announce offline.
const SWEEP_INTERVAL_SECS: u64 = 15;
/// Bound the snapshot fan-in so a crafted `?ids=` can't ask about the world.
const MAX_SNAPSHOT_IDS: usize = 500;

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

/// One user's presence as returned by the snapshot endpoint. `online` is the
/// live signal; `last_seen` is the durable fallback rendered when offline.
#[derive(Serialize)]
pub struct PresenceView {
    pub user_id: i32,
    pub online: bool,
    pub last_seen: Option<String>,
}

// ================= LIFECYCLE HOOKS (called from the WS actor) =================

/// A chat socket for `user_id` just connected. Marks them online (Redis, or the
/// local registry when Redis is down), stamps `last_seen`, and — only on a real
/// offline→online transition — announces online to their contacts.
pub async fn on_connect(cache: &Option<Cache>, pool: &PgPool, user_id: i32) {
    persist_last_seen(pool, user_id).await;

    let transitioned = match cache {
        Some(c) => {
            let now = now_ts();
            // Fresh transition when there was no score, or the previous one had
            // already gone stale (so contacts think they're offline).
            let was_online = c
                .zscore(PRESENCE_KEY, &user_id.to_string())
                .await
                .is_some_and(|prev| now - prev <= STALE_AFTER_SECS);
            // Count this socket so the last disconnect can flip us offline
            // immediately (see `on_disconnect`).
            c.incr(&conns_key(user_id)).await;
            c.zadd(PRESENCE_KEY, &user_id.to_string(), now).await;
            !was_online
        }
        // No Redis → single instance. `started` has already registered this
        // socket, so a redundant "online" is harmless; announce it.
        None => true,
    };

    if transitioned {
        broadcast_presence(pool, cache, user_id, true).await;
    }
}

/// Heartbeat tick — refresh the freshness score so the user stays online.
/// No-op without Redis (the local registry is the source of truth there).
pub async fn on_heartbeat(cache: &Option<Cache>, user_id: i32) {
    if let Some(c) = cache {
        c.zadd(PRESENCE_KEY, &user_id.to_string(), now_ts()).await;
    }
}

/// A chat socket for `user_id` closed. Always refresh `last_seen`, then announce
/// offline as soon as this was their *last* socket:
/// * With Redis, decrement the cross-instance socket counter; when it reaches
///   zero remove the score and announce offline immediately. Another open
///   socket (any tab, any instance) keeps the count positive, so we don't flap.
/// * Without Redis, announce offline iff no local socket remains (multi-tab).
///
/// The [`run_sweeper`] backstop still catches a socket that vanished without a
/// clean disconnect (e.g. an instance crash leaves the counter non-zero).
pub async fn on_disconnect(cache: &Option<Cache>, pool: &PgPool, user_id: i32) {
    persist_last_seen(pool, user_id).await;

    match cache {
        Some(c) => {
            // Last socket anywhere → offline now. The ZREM return value guards
            // the announce so exactly one caller emits (matches the sweeper).
            if c.decr(&conns_key(user_id)).await <= 0
                && c.zrem(PRESENCE_KEY, &user_id.to_string()).await == 1
            {
                broadcast_presence(pool, cache, user_id, false).await;
            }
        }
        None => {
            if !is_online_local(user_id) {
                broadcast_presence(pool, cache, user_id, false).await;
            }
        }
    }
}

// ================= SWEEPER (Redis mode, one per socket-serving instance) =====

/// Spawn the stale-session reaper. Runs on `All` / `Api` roles when Redis is
/// up; a no-op otherwise (single-instance offline is announced inline by
/// [`on_disconnect`]).
pub fn spawn_sweeper(pool: PgPool, cache: Cache) {
    actix_web::rt::spawn(run_sweeper(pool, cache));
}

async fn run_sweeper(pool: PgPool, cache: Cache) {
    let cache_opt = Some(cache.clone());
    loop {
        actix_web::rt::time::sleep(std::time::Duration::from_secs(SWEEP_INTERVAL_SECS)).await;

        let cutoff = now_ts() - STALE_AFTER_SECS;
        let stale = cache
            .zrangebyscore(PRESENCE_KEY, "-inf", &cutoff.to_string())
            .await;
        for member in stale {
            let Ok(user_id) = member.parse::<i32>() else {
                // A non-numeric member has no business here; drop it.
                cache.zrem(PRESENCE_KEY, &member).await;
                continue;
            };
            // Whichever instance's ZREM actually removes the member won the
            // race — only it announces offline, so contacts get one event.
            if cache.zrem(PRESENCE_KEY, &member).await == 1 {
                // Clear any socket count leaked by a crashed instance so the
                // fast-path counter starts clean on the user's next connect.
                cache.del(&conns_key(user_id)).await;
                persist_last_seen(&pool, user_id).await;
                broadcast_presence(&pool, &cache_opt, user_id, false).await;
            }
        }
    }
}

// ================= SNAPSHOT (HTTP) ===========================================

/// `GET /api/chat/presence?ids=1,2,3` — the caller's contacts' current
/// presence. Content-free: ids, an online flag, and a last-seen timestamp.
#[instrument(target = "http", skip(req, pool, cache, query))]
pub async fn get_presence(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    cache: web::Data<Option<Cache>>,
    query: web::Query<PresenceQuery>,
) -> AppResult {
    get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let ids: Vec<i32> = query
        .ids
        .split(',')
        .filter_map(|s| s.trim().parse::<i32>().ok())
        .take(MAX_SNAPSHOT_IDS)
        .collect();

    let views = snapshot(cache.get_ref(), pool.get_ref(), &ids).await;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "presence": views })))
}

#[derive(Deserialize)]
pub struct PresenceQuery {
    /// Comma-separated user ids to look up.
    pub ids: String,
}

/// Resolve online + last-seen for a set of user ids. `online` comes from Redis
/// freshness (or the local registry without Redis); `last_seen` from the DB.
pub async fn snapshot(cache: &Option<Cache>, pool: &PgPool, ids: &[i32]) -> Vec<PresenceView> {
    if ids.is_empty() {
        return Vec::new();
    }

    // Durable last_seen for all requested ids in one scan.
    let last_seen: std::collections::HashMap<i32, String> =
        sqlx::query_as::<_, (i32, Option<chrono::DateTime<chrono::Utc>>)>(
            "SELECT id, last_seen FROM users WHERE id = ANY($1)",
        )
        .bind(ids)
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| {
            warn!(target: "ws", error = ?e, "presence last_seen lookup failed");
            Vec::new()
        })
        .into_iter()
        .filter_map(|(id, ts)| ts.map(|t| (id, t.to_rfc3339())))
        .collect();

    let now = now_ts();
    let mut views = Vec::with_capacity(ids.len());
    for &id in ids {
        let online = match cache {
            Some(c) => c
                .zscore(PRESENCE_KEY, &id.to_string())
                .await
                .is_some_and(|score| now - score <= STALE_AFTER_SECS),
            None => is_online_local(id),
        };
        views.push(PresenceView {
            user_id: id,
            online,
            last_seen: last_seen.get(&id).cloned(),
        });
    }
    views
}

// ================= INTERNALS =================================================

/// Stamp `users.last_seen = NOW()`. Best-effort — a failed write just means the
/// "last seen …" label is a little stale.
async fn persist_last_seen(pool: &PgPool, user_id: i32) {
    if let Err(e) = sqlx::query("UPDATE users SET last_seen = NOW() WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await
    {
        warn!(target: "ws", user_id, error = ?e, "presence last_seen update failed");
    }
}

/// Push a presence change to everyone who'd care — the user's DM partners and
/// channel co-members — over the per-user fan-out.
async fn broadcast_presence(pool: &PgPool, cache: &Option<Cache>, user_id: i32, online: bool) {
    let contacts = contacts_of(pool, user_id).await;
    if contacts.is_empty() {
        return;
    }

    let payload = serde_json::json!({
        "type": "presence",
        "user_id": user_id,
        "online": online,
        // On connect this is ~now; on offline it's the moment we reaped them.
        "last_seen": chrono::Utc::now().to_rfc3339(),
    })
    .to_string();

    futures::future::join_all(contacts.into_iter().map(|contact_id| {
        let payload = payload.clone();
        async move { fan_out_user(cache, contact_id, payload).await }
    }))
    .await;
}

/// The distinct set of users who share a conversation with `user_id`: everyone
/// they've DM'd (either direction) plus every co-member of a channel they're
/// in. Runs on the pooled (owner) role, bypassing RLS like the sibling
/// on-connect delivered sweep — presence carries no message content.
async fn contacts_of(pool: &PgPool, user_id: i32) -> Vec<i32> {
    sqlx::query_scalar::<_, i32>(
        r#"
        SELECT DISTINCT other FROM (
            SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other
              FROM messages
             WHERE (sender_id = $1 OR receiver_id = $1)
               AND sender_id IS NOT NULL AND receiver_id IS NOT NULL
            UNION
            SELECT cm2.user_id AS other
              FROM channel_members cm1
              JOIN channel_members cm2 ON cm1.channel_id = cm2.channel_id
             WHERE cm1.user_id = $1
        ) c
        WHERE other IS NOT NULL AND other <> $1
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| {
        warn!(target: "ws", user_id, error = ?e, "presence contacts lookup failed");
        Vec::new()
    })
}
