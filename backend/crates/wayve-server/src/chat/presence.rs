//! User online/offline presence.
//!
//! Live state is a Redis sorted set of `user_id → last-heartbeat unix seconds`; a
//! user is online while that score is fresh (within [`STALE_AFTER_SECS`]).
//! Without Redis we fall back to the per-process session registry
//! ([`crate::chat::websocket::is_online_local`]), correct on a single instance.
//! Durable state is `users.last_seen`, so an offline user still renders
//! "last seen …".
//!
//! Changes are pushed over the `ws:user:*` fan-out to the user's contacts, so the
//! dot flips without polling. Offline is announced when the last socket closes,
//! tracked by a cross-instance counter so extra tabs never flap a user offline.
//! [`run_sweeper`] is the crash-safe backstop for sockets that vanished without a
//! clean disconnect.

use crate::cache::Cache;
use crate::prelude::*;
use tracing::{instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

use super::websocket::{fan_out_user, is_online_local};

/// Redis sorted set holding `user_id → last-heartbeat unix seconds`.
const PRESENCE_KEY: &str = "presence:online";
/// Open chat sockets for a user across all instances.
fn conns_key(user_id: i32) -> String {
    format!("presence:conns:{user_id}")
}
/// A session with no heartbeat for this long is offline. Must comfortably exceed
/// the chat heartbeat interval (25s) so a live client never flaps between beats.
const STALE_AFTER_SECS: i64 = 45;
/// How often the sweeper reaps stale sessions and announces them offline.
const SWEEP_INTERVAL_SECS: u64 = 15;
/// Bounds the snapshot fan-in so a crafted `?ids=` cannot ask about the world.
const MAX_SNAPSHOT_IDS: usize = 500;

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

/// `online` is the live signal; `last_seen` is the durable offline fallback.
#[derive(Serialize)]
pub struct PresenceView {
    pub user_id: i32,
    pub online: bool,
    pub last_seen: Option<String>,
}

/// Marks the user online and announces it to their contacts, but only on a real
/// offline-to-online transition.
pub async fn on_connect(cache: &Option<Cache>, pool: &PgPool, user_id: i32) {
    persist_last_seen(pool, user_id).await;

    let transitioned = match cache {
        Some(c) => {
            let now = now_ts();
            // A transition only if there was no score, or the previous one went
            // stale and contacts already believe the user is offline.
            let was_online = c
                .zscore(PRESENCE_KEY, &user_id.to_string())
                .await
                .is_some_and(|prev| now - prev <= STALE_AFTER_SECS);
            c.incr(&conns_key(user_id)).await;
            c.zadd(PRESENCE_KEY, &user_id.to_string(), now).await;
            !was_online
        }
        // Single-instance: the socket is already registered, so a redundant
        // announcement is harmless.
        None => true,
    };

    if transitioned {
        broadcast_presence(pool, cache, user_id, true).await;
    }
}

/// Refresh the freshness score so the user stays online. No-op without Redis,
/// where the local registry is the source of truth.
pub async fn on_heartbeat(cache: &Option<Cache>, user_id: i32) {
    if let Some(c) = cache {
        c.zadd(PRESENCE_KEY, &user_id.to_string(), now_ts()).await;
    }
}

/// Announces offline only when this was the user's last socket, across tabs and
/// instances. [`run_sweeper`] backstops unclean disconnects.
pub async fn on_disconnect(cache: &Option<Cache>, pool: &PgPool, user_id: i32) {
    persist_last_seen(pool, user_id).await;

    match cache {
        Some(c) => {
            // The ZREM return value guards the announce so exactly one caller
            // emits it, which is how this stays race-free against the sweeper.
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

/// Spawn the stale-session reaper. Only meaningful with Redis; without it
/// [`on_disconnect`] announces offline inline.
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
                cache.zrem(PRESENCE_KEY, &member).await;
                continue;
            };
            // Only the instance whose ZREM removed the member announces, so
            // contacts receive exactly one offline event.
            if cache.zrem(PRESENCE_KEY, &member).await == 1 {
                // Clears any count leaked by a crashed instance.
                cache.del(&conns_key(user_id)).await;
                persist_last_seen(&pool, user_id).await;
                broadcast_presence(&pool, &cache_opt, user_id, false).await;
            }
        }
    }
}

/// `GET /api/chat/presence?ids=1,2,3` — current presence for the given users.
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

/// `online` comes from Redis freshness, or the local registry without Redis;
/// `last_seen` comes from the DB.
pub async fn snapshot(cache: &Option<Cache>, pool: &PgPool, ids: &[i32]) -> Vec<PresenceView> {
    if ids.is_empty() {
        return Vec::new();
    }

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

/// Best-effort: a failed write only leaves the "last seen …" label stale.
async fn persist_last_seen(pool: &PgPool, user_id: i32) {
    if let Err(e) = sqlx::query("UPDATE users SET last_seen = NOW() WHERE id = $1")
        .bind(user_id)
        .execute(pool)
        .await
    {
        warn!(target: "ws", user_id, error = ?e, "presence last_seen update failed");
    }
}

/// Push a presence change to the user's contacts over the per-user fan-out.
async fn broadcast_presence(pool: &PgPool, cache: &Option<Cache>, user_id: i32, online: bool) {
    let contacts = contacts_of(pool, user_id).await;
    if contacts.is_empty() {
        return;
    }

    let payload = serde_json::json!({
        "type": "presence",
        "user_id": user_id,
        "online": online,
        "last_seen": chrono::Utc::now().to_rfc3339(),
    })
    .to_string();

    futures::future::join_all(contacts.into_iter().map(|contact_id| {
        let payload = payload.clone();
        async move { fan_out_user(cache, contact_id, payload).await }
    }))
    .await;
}

/// Every DM partner plus every co-member of the user's channels. Runs on the
/// pooled owner role, bypassing RLS, which is safe because presence carries no
/// message content.
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
