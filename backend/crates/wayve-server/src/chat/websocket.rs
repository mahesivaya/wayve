use crate::cache::{Cache, chat_history_key};
use crate::models::message::{ChatMessage, MessageStatus};
use crate::prelude::*;
use wayve_security::encryption::encrypt;

use super::dto::WsAuthQuery;

use crate::ws_registry::SessionRegistry;

use actix::{Actor, ActorFutureExt, AsyncContext, Handler, Message as ActixMessage, StreamHandler};
use actix_web_actors::ws;
use actix_web_actors::ws::WebsocketContext;
use sqlx::{PgPool, Row};
use std::time::{Duration, Instant};
use tracing::{debug, error, info, instrument, warn};

const CHAT_E2E_PREFIX: &str = "WAYVE_CHAT_E2E_V1\n";

// Server-driven heartbeat. We ping every HEARTBEAT_INTERVAL so the connection
// never idles out at an intermediary (nginx closes idle WS after its
// proxy_read_timeout) and so we can detect a dead/half-open client: if we
// haven't heard ANY frame (the browser auto-pongs our pings) within
// CLIENT_TIMEOUT, we drop the socket. Keep HEARTBEAT_INTERVAL well under both
// CLIENT_TIMEOUT and the nginx /ws proxy_read_timeout (3600s).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

static SESSIONS: Lazy<SessionRegistry<ChatSession>> = Lazy::new(SessionRegistry::new);

#[derive(ActixMessage)]
#[rtype(result = "()")]
pub struct WsMessage(pub String);

/// Redis pub/sub channel a user's realtime frames are published on. The global
/// subscriber (see `chat::pubsub`) PSUBSCRIBEs `ws:user:*` and delivers each
/// message to that user's local session, so chat works across many backend
/// instances — not just the one that received the send.
pub fn user_channel(user_id: i32) -> String {
    format!("ws:user:{user_id}")
}

/// Deliver a payload to a user's session **on this instance** (no-op if they're
/// not connected here). Called both by the local fast-path and by the pub/sub
/// subscriber.
pub fn deliver_local(user_id: i32, payload: String) {
    if let Some(addr) = SESSIONS.addr(user_id) {
        addr.do_send(WsMessage(payload));
    }
}

/// Fan a realtime frame out to a user. When Redis is available we PUBLISH so the
/// instance holding their socket (possibly a different one) delivers it; if the
/// publish fails we fall back to local delivery so single-instance / Redis-down
/// setups keep working. Exactly one delivery path runs, so no duplicates.
pub async fn fan_out_user(cache: &Option<Cache>, user_id: i32, payload: String) {
    let published = match cache {
        Some(c) => c.publish(&user_channel(user_id), &payload).await,
        None => false,
    };
    // If we couldn't publish (no Redis, or it's momentarily down) deliver to the
    // local session directly so single-instance setups keep working.
    if !published {
        deliver_local(user_id, payload);
    }
}

/// Mark every direct message addressed to `receiver_id` that is still `sent`
/// as `delivered`, and notify each distinct sender so their bubble advances
/// ✓ → ✓✓. Called when the receiver's socket connects, which covers the case
/// the inline send-time delivered misses: the recipient was offline when the
/// message was sent and only comes online later.
async fn mark_delivered_on_connect(pool: &PgPool, cache: &Option<Cache>, receiver_id: i32) {
    let rows = sqlx::query_as::<_, (i32, i32)>(
        r#"
        UPDATE messages
           SET status = 'delivered'
         WHERE receiver_id = $1 AND status = 'sent'
        RETURNING id, sender_id
        "#,
    )
    .bind(receiver_id)
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| {
        warn!(target: "ws", receiver_id, error = ?e, "on-connect delivered sweep failed");
        Vec::new()
    });

    if !rows.is_empty() {
        info!(target: "ws", receiver_id, count = rows.len(), "marked messages delivered on connect");
    }

    for (message_id, sender_id) in rows {
        let payload = serde_json::json!({
            "type": "status_update",
            "message_id": message_id,
            "status": "delivered"
        })
        .to_string();
        fan_out_user(cache, sender_id, payload).await;
    }
}

// ================= CHAT SESSION =================

pub struct ChatSession {
    pub pool: PgPool,
    pub user_id: i32,
    pub cache: Option<Cache>,
    // Last time we received any frame from the client (including the automatic
    // pong to our heartbeat ping). Drives dead-client detection.
    pub last_seen: Instant,
}

#[instrument(target = "ws", skip(req, stream, pool, cache, query))]
pub async fn chat_ws(
    req: HttpRequest,
    stream: web::Payload,
    pool: web::Data<PgPool>,
    cache: web::Data<Option<Cache>>,
    query: web::Query<WsAuthQuery>,
) -> Result<HttpResponse, actix_web::Error> {
    // Auth: an API key (resolved by ApiKeyMiddleware into the request
    // extensions) or a cookie/Bearer JWT, with a ?token= query fallback for
    // older clients.
    let user_id = match wayve_security::jwt::get_user_id_from_request(&req).or_else(|| {
        query
            .token
            .clone()
            .filter(|token| !token.trim().is_empty())
            .and_then(|token| wayve_security::jwt::decode_jwt(&token))
            .map(|claims| claims.sub)
    }) {
        Some(id) => id,
        None => {
            tracing::warn!(target: "ws", "chat_ws rejected: missing or invalid credentials");
            return Ok(HttpResponse::Unauthorized().body("Missing or invalid credentials"));
        }
    };

    ws::start(
        ChatSession {
            pool: pool.get_ref().clone(),
            user_id,
            cache: cache.get_ref().clone(),
            last_seen: Instant::now(),
        },
        &req,
        stream,
    )
}

// ================= ACTOR =================

impl Actor for ChatSession {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        info!("Chat WS connected: user_id={}", self.user_id);
        SESSIONS.register(self.user_id, ctx.address());
        self.last_seen = Instant::now();

        // Flip any messages addressed to this user that are still `sent` to
        // `delivered` now that they're online, and notify the senders.
        let pool = self.pool.clone();
        let cache = self.cache.clone();
        let me = self.user_id;
        actix_web::rt::spawn(async move {
            mark_delivered_on_connect(&pool, &cache, me).await;
        });

        // Heartbeat: ping the client on an interval, and reap the socket if the
        // client has gone silent past CLIENT_TIMEOUT (the browser auto-pongs,
        // which refreshes `last_seen`).
        ctx.run_interval(HEARTBEAT_INTERVAL, |act, ctx| {
            if Instant::now().duration_since(act.last_seen) > CLIENT_TIMEOUT {
                warn!(
                    target: "ws",
                    user_id = act.user_id,
                    "WS heartbeat timeout — closing dead client"
                );
                ctx.stop();
                return;
            }
            ctx.ping(b"");
        });
    }

    fn stopped(&mut self, _: &mut Self::Context) {
        info!("Chat WS disconnected: user_id={}", self.user_id);
        SESSIONS.unregister(self.user_id);
    }
}

// ================= RECEIVE WS =================

impl Handler<WsMessage> for ChatSession {
    type Result = ();

    fn handle(&mut self, msg: WsMessage, ctx: &mut Self::Context) {
        ctx.text(msg.0);
    }
}

// ================= MAIN WS LOGIC =================

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for ChatSession {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        // Any valid frame (text, the auto-pong to our heartbeat, ping, …) means
        // the client is alive — refresh the heartbeat clock.
        if msg.is_ok() {
            self.last_seen = Instant::now();
        }
        match msg {
            Ok(ws::Message::Text(text)) => {
                debug!(target: "ws", user_id = self.user_id, len = text.len(), "chat msg in");

                let parsed: Result<ChatMessage, _> = serde_json::from_str(&text);

                if let Ok(data) = parsed {
                    // ================= READ RECEIPT =================
                    if matches!(data.status, Some(MessageStatus::Read)) {
                        let pool = self.pool.clone();
                        let cache = self.cache.clone();
                        let reader = self.user_id;
                        let Some(other) = data.receiver_id else {
                            return;
                        };

                        actix::spawn(async move {
                            // Mark everything `other` sent to `reader` as read,
                            // returning the affected ids so we can notify the
                            // sender per message. The sender's client keys
                            // status updates on `message_id`, so the receipt MUST
                            // carry it (a sender_id/receiver_id-only payload was
                            // silently ignored — read ticks never went blue live).
                            let read_ids: Vec<(i32,)> = sqlx::query_as(
                                r#"
                                UPDATE messages
                                SET status = 'read'
                                WHERE receiver_id = $1 AND sender_id = $2
                                  AND status <> 'read'
                                RETURNING id
                                "#,
                            )
                            .bind(reader)
                            .bind(other)
                            .fetch_all(&pool)
                            .await
                            .unwrap_or_default();

                            if let Some(cache) = cache.as_ref() {
                                cache.del(&chat_history_key(reader, other)).await;
                            }

                            for (message_id,) in &read_ids {
                                let receipt = serde_json::json!({
                                    "type": "status_update",
                                    "message_id": message_id,
                                    "status": "read"
                                })
                                .to_string();

                                fan_out_user(&cache, other, receipt).await;
                            }
                        });

                        return;
                    }

                    // ================= NORMAL MESSAGE =================

                    let pool = self.pool.clone();
                    let cache = self.cache.clone();
                    let sender_id = self.user_id;
                    let receiver_id = data.receiver_id;
                    let channel_id = data.channel_id;
                    let parent_message_id = data.parent_message_id;
                    let client_id = data.client_id.clone();
                    let content = data.content.clone();
                    let attachment_ids = data.attachment_ids.clone();

                    // Threads are channel-only. A DM with parent_message_id set
                    // is malformed — drop it rather than silently storing the
                    // reference on a DM row (which has no such column).
                    if parent_message_id.is_some() && channel_id.is_none() {
                        warn!(
                            target: "ws",
                            sender_id,
                            parent_message_id = ?parent_message_id,
                            "rejected DM with parent_message_id (threads are channel-only)"
                        );
                        return;
                    }

                    if !content.starts_with(CHAT_E2E_PREFIX) {
                        error!(
                            target: "ws",
                            sender_id,
                            receiver_id = ?receiver_id,
                            channel_id = ?channel_id,
                            "rejected plaintext chat message"
                        );
                        return;
                    }

                    let (iv, encrypted) = match encrypt(&content) {
                        Ok(res) => res,
                        Err(e) => {
                            error!(
                                "Chat encrypt failed (sender={}, receiver={:?}): {:?}",
                                sender_id, receiver_id, e
                            );
                            return;
                        }
                    };

                    if let Some(channel_id) = channel_id {
                        let fut = {
                            let pool = pool.clone();
                            async move {
                                let is_member = sqlx::query_scalar::<_, bool>(
                                    r#"
                                    SELECT EXISTS(
                                        SELECT 1
                                        FROM channel_members
                                        WHERE channel_id = $1 AND user_id = $2
                                    )
                                    "#,
                                )
                                .bind(channel_id)
                                .bind(sender_id)
                                .fetch_one(&pool)
                                .await?;

                                if !is_member {
                                    return Err(sqlx::Error::RowNotFound);
                                }

                                // Parent must (a) exist, (b) live in this same
                                // channel, and (c) itself be top-level — flat
                                // threads, no thread-of-thread nesting.
                                if let Some(parent_id) = parent_message_id {
                                    let parent_ok = sqlx::query_scalar::<_, bool>(
                                        r#"
                                        SELECT EXISTS(
                                            SELECT 1
                                            FROM channel_messages
                                            WHERE id = $1
                                              AND channel_id = $2
                                              AND parent_message_id IS NULL
                                        )
                                        "#,
                                    )
                                    .bind(parent_id)
                                    .bind(channel_id)
                                    .fetch_one(&pool)
                                    .await?;

                                    if !parent_ok {
                                        return Err(sqlx::Error::RowNotFound);
                                    }
                                }

                                let row = sqlx::query(
                                    r#"
                                    INSERT INTO channel_messages
                                    (channel_id, sender_id, content_encrypted,
                                     content_iv, parent_message_id)
                                    VALUES ($1, $2, $3, $4, $5)
                                    RETURNING id, created_at
                                    "#,
                                )
                                .bind(channel_id)
                                .bind(sender_id)
                                .bind(encrypted)
                                .bind(iv)
                                .bind(parent_message_id)
                                .fetch_one(&pool)
                                .await?;

                                let members = sqlx::query_scalar::<_, i32>(
                                    "SELECT user_id FROM channel_members WHERE channel_id = $1",
                                )
                                .bind(channel_id)
                                .fetch_all(&pool)
                                .await?;

                                // Webhook fan-out. Metadata only — the
                                // content envelope is end-to-end encrypted
                                // and the server cannot reveal it.
                                let message_id: i32 = row.get("id");
                                let owner =
                                    crate::webhooks::handler::owner_for_user(&pool, sender_id)
                                        .await;
                                crate::webhooks::emit(
                                    &pool,
                                    owner,
                                    crate::webhooks::Event::ChatMessageSent,
                                    serde_json::json!({
                                        "message_id": message_id,
                                        "channel_id": channel_id,
                                        "sender_id": sender_id,
                                        "is_direct": false,
                                        "parent_message_id": parent_message_id,
                                    }),
                                )
                                .await;

                                Ok::<_, sqlx::Error>((row, members))
                            }
                        };

                        let cache_for_fanout = cache.clone();
                        ctx.spawn(actix::fut::wrap_future(fut).map(
                            move |res, _act, ctx: &mut WebsocketContext<Self>| {
                                if let Ok((row, members)) = res {
                                    let message_id: i32 = row.get("id");
                                    let created_naive: chrono::NaiveDateTime =
                                        row.get("created_at");
                                    let created_at =
                                        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                                            created_naive,
                                            chrono::Utc,
                                        );

                                    let msg_json = serde_json::json!({
                                        "message_id": message_id,
                                        "channel_id": channel_id,
                                        "sender_id": sender_id,
                                        "content": content,
                                        "status": "sent",
                                        "created_at": created_at.to_rfc3339(),
                                        "parent_message_id": parent_message_id,
                                        "client_id": client_id,
                                    })
                                    .to_string();

                                    // Fan out to every other member via Redis
                                    // (or local fallback) in one background task.
                                    let recipients: Vec<i32> =
                                        members.into_iter().filter(|&m| m != sender_id).collect();
                                    let payload = msg_json.clone();
                                    actix_web::rt::spawn(async move {
                                        for member_id in recipients {
                                            fan_out_user(
                                                &cache_for_fanout,
                                                member_id,
                                                payload.clone(),
                                            )
                                            .await;
                                        }
                                    });

                                    ctx.text(msg_json);
                                }
                            },
                        ));

                        return;
                    }

                    let Some(receiver_id) = receiver_id else {
                        return;
                    };

                    let fut = async move {
                        // Tenant isolation: a direct message may cross between
                        // two accounts only when they share a scope — same
                        // platform, same organization, or both personal. The
                        // people-picker is already scoped, but user ids are
                        // guessable, so the boundary is enforced here too.
                        let same_scope = sqlx::query_scalar::<_, bool>(
                            r#"
                            SELECT COALESCE(
                                (s.account_type = 'personal'
                                    AND r.account_type = 'personal')
                             OR (s.account_type = 'platform_admin'
                                    AND r.account_type = 'platform_admin')
                             OR (s.account_type IN ('organization', 'organization_admin')
                                    AND r.account_type IN ('organization', 'organization_admin')
                                    AND s.organization_id = r.organization_id),
                            false)
                            FROM
                                (SELECT account_type, organization_id
                                   FROM users WHERE id = $1) s,
                                (SELECT account_type, organization_id
                                   FROM users WHERE id = $2) r
                            "#,
                        )
                        .bind(sender_id)
                        .bind(receiver_id)
                        .fetch_optional(&pool)
                        .await?
                        .unwrap_or(false);

                        if !same_scope {
                            warn!(
                                target: "ws",
                                sender_id,
                                receiver_id,
                                "rejected cross-scope direct message"
                            );
                            return Err(sqlx::Error::RowNotFound);
                        }

                        let row = sqlx::query(
                            r#"
                            INSERT INTO messages
                            (sender_id, receiver_id, content_encrypted, content_iv, status)
                            VALUES ($1, $2, $3, $4, 'sent')
                            RETURNING id, created_at
                            "#,
                        )
                        .bind(sender_id)
                        .bind(receiver_id)
                        .bind(encrypted)
                        .bind(iv)
                        .fetch_one(&pool)
                        .await?;

                        let message_id: i32 = row.get("id");

                        // Link any uploaded attachments to this message. Scoped
                        // to rows this sender uploaded and not yet linked, so a
                        // client can't attach someone else's file.
                        if !attachment_ids.is_empty() {
                            let _ = sqlx::query(
                                "UPDATE chat_attachments SET message_id = $1 \
                                 WHERE id = ANY($2) AND uploader_id = $3 AND message_id IS NULL",
                            )
                            .bind(message_id)
                            .bind(&attachment_ids)
                            .bind(sender_id)
                            .execute(&pool)
                            .await;
                        }

                        // If the recipient is connected right now, the message
                        // is delivered the instant it's stored — persist that
                        // so it survives a history refetch (the live
                        // status_update event is sent from the continuation
                        // below). Covers the recipient-online-at-send case; the
                        // recipient-comes-online-later case is handled by
                        // mark_delivered_on_connect.
                        if SESSIONS.addr(receiver_id).is_some() {
                            let _ = sqlx::query(
                                "UPDATE messages SET status = 'delivered' \
                                 WHERE id = $1 AND status = 'sent'",
                            )
                            .bind(message_id)
                            .execute(&pool)
                            .await;
                        }

                        // Webhook fan-out. Metadata only — content stays
                        // end-to-end encrypted.
                        let owner =
                            crate::webhooks::handler::owner_for_user(&pool, sender_id).await;
                        crate::webhooks::emit(
                            &pool,
                            owner,
                            crate::webhooks::Event::ChatMessageSent,
                            serde_json::json!({
                                "message_id": message_id,
                                "sender_id": sender_id,
                                "recipient_id": receiver_id,
                                "is_direct": true,
                            }),
                        )
                        .await;

                        Ok::<_, sqlx::Error>(row)
                    };

                    ctx.spawn(actix::fut::wrap_future(fut).map(
                        move |res, _act, ctx: &mut WebsocketContext<Self>| {
                            if let Ok(row) = res {
                                let message_id: i32 = row.get("id");
                                let created_naive: chrono::NaiveDateTime = row.get("created_at");
                                let created_at =
                                    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                                        created_naive,
                                        chrono::Utc,
                                    );

                                // 🔥 DELIVERED — best-effort, gated on LOCAL
                                // presence. Accurate on a single instance; a
                                // cross-instance "delivered" would need a shared
                                // presence registry (future work). The DB row was
                                // already flipped to 'delivered' inside the async
                                // block above when the recipient was present.
                                //
                                // The delivered status rides on the SAME echo
                                // frame that carries the server-assigned
                                // message_id, so the sender's client applies it
                                // atomically while reconciling its optimistic
                                // bubble — no separate status_update that could
                                // race ahead of that reconciliation and be
                                // dropped (the "delivered only after reload" bug).
                                let delivered = SESSIONS.addr(receiver_id).is_some();
                                let status = if delivered { "delivered" } else { "sent" };

                                let msg_json = serde_json::json!({
                                    "message_id": message_id,
                                    "sender_id": sender_id,
                                    "receiver_id": receiver_id,
                                    "content": content,
                                    "status": status,
                                    "created_at": created_at.to_rfc3339(),
                                    "client_id": client_id,
                                })
                                .to_string();

                                // SEND TO RECEIVER — via Redis fan-out (or local
                                // fallback), so it reaches them on whichever
                                // instance holds their socket.
                                let cache_for_fanout = cache.clone();
                                let payload = msg_json.clone();
                                actix_web::rt::spawn(async move {
                                    fan_out_user(&cache_for_fanout, receiver_id, payload).await;
                                });

                                // SEND BACK TO SENDER (echo carries the delivered
                                // status above, so the tick advances live).
                                ctx.text(msg_json);

                                // BUST CACHE for this conversation so the next
                                // history fetch sees the new message immediately.
                                if let Some(c) = cache.clone() {
                                    let key = chat_history_key(sender_id, receiver_id);
                                    actix_web::rt::spawn(async move {
                                        c.del(&key).await;
                                    });
                                }
                            }
                        },
                    ));
                }
            }

            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            // Pong to our heartbeat — liveness already recorded above.
            Ok(ws::Message::Pong(_)) => {}
            Ok(ws::Message::Close(_)) => ctx.stop(),
            _ => {}
        }
    }
}
