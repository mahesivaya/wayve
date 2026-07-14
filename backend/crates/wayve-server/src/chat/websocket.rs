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

// The ping keeps intermediaries from idling the socket out, and a client silent
// past CLIENT_TIMEOUT is dropped as dead. HEARTBEAT_INTERVAL must stay well under
// both CLIENT_TIMEOUT and the nginx /ws proxy_read_timeout (3600s).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

static SESSIONS: Lazy<SessionRegistry<ChatSession>> = Lazy::new(SessionRegistry::new);

#[derive(ActixMessage)]
#[rtype(result = "()")]
pub struct WsMessage(pub String);

/// Redis pub/sub channel for a user's realtime frames. `chat::pubsub` PSUBSCRIBEs
/// `ws:user:*`, which is what makes chat work across backend instances.
pub fn user_channel(user_id: i32) -> String {
    format!("ws:user:{user_id}")
}

/// Deliver a payload to a user's session on this instance, if they have one.
pub fn deliver_local(user_id: i32, payload: String) {
    if let Some(addr) = SESSIONS.addr(user_id) {
        addr.do_send(WsMessage(payload));
    }
}

/// Whether this user holds a live chat socket on this instance. The presence
/// source of truth when Redis is unavailable; see [`crate::chat::presence`].
pub fn is_online_local(user_id: i32) -> bool {
    SESSIONS.addr(user_id).is_some()
}

/// Fan a realtime frame out to a user. With Redis we PUBLISH, so whichever
/// instance holds their socket delivers it; if the publish fails we fall back to
/// local delivery. Exactly one path runs, so a frame is never duplicated.
pub async fn fan_out_user(cache: &Option<Cache>, user_id: i32, payload: String) {
    let published = match cache {
        Some(c) => c.publish(&user_channel(user_id), &payload).await,
        None => false,
    };
    if !published {
        deliver_local(user_id, payload);
    }
}

/// Flip every direct message still `sent` for `receiver_id` to `delivered` and
/// notify each sender. Covers the case the send-time check misses: the recipient
/// was offline then and only connects now.
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

pub struct ChatSession {
    pub pool: PgPool,
    pub user_id: i32,
    pub cache: Option<Cache>,
    // Enterprise senders use standard, server-readable encryption, so plaintext
    // is accepted from them instead of an E2E envelope. Resolved once at connect,
    // so a tier change applies on the next reconnect.
    pub uses_standard_encryption: bool,
    // Resolved once at connect so channel broadcasts carry a sender label without
    // a per-row user lookup.
    pub sender_name: String,
    // Drives dead-client detection.
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
    // Invariant: user_id comes from verified credentials only. The ?token=
    // fallback is decoded and verified, never trusted as a raw query value.
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

    // Resolved here because the actor cannot await.
    let uses_standard_encryption =
        crate::encryption_policy::uses_standard_encryption(pool.get_ref(), user_id).await;

    let sender_name: String =
        sqlx::query_scalar("SELECT COALESCE(NULLIF(username, ''), email) FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await
            .ok()
            .flatten()
            .unwrap_or_default();

    ws::start(
        ChatSession {
            pool: pool.get_ref().clone(),
            user_id,
            cache: cache.get_ref().clone(),
            uses_standard_encryption,
            sender_name,
            last_seen: Instant::now(),
        },
        &req,
        stream,
    )
}

impl Actor for ChatSession {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        info!("Chat WS connected: user_id={}", self.user_id);
        SESSIONS.register(self.user_id, ctx.address());
        self.last_seen = Instant::now();

        let pool = self.pool.clone();
        let cache = self.cache.clone();
        let me = self.user_id;
        actix_web::rt::spawn(async move {
            mark_delivered_on_connect(&pool, &cache, me).await;
            crate::chat::presence::on_connect(&cache, &pool, me).await;
        });

        // Each beat also refreshes the presence freshness score, which is what
        // keeps the user showing as online.
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

            let cache = act.cache.clone();
            let me = act.user_id;
            actix_web::rt::spawn(async move {
                crate::chat::presence::on_heartbeat(&cache, me).await;
            });
        });
    }

    fn stopped(&mut self, _: &mut Self::Context) {
        info!("Chat WS disconnected: user_id={}", self.user_id);
        // Unregister first so presence sees the accurate remaining-tabs state
        // before deciding whether to announce this user offline.
        SESSIONS.unregister(self.user_id);

        let pool = self.pool.clone();
        let cache = self.cache.clone();
        let me = self.user_id;
        actix_web::rt::spawn(async move {
            crate::chat::presence::on_disconnect(&cache, &pool, me).await;
        });
    }
}

impl Handler<WsMessage> for ChatSession {
    type Result = ();

    fn handle(&mut self, msg: WsMessage, ctx: &mut Self::Context) {
        ctx.text(msg.0);
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for ChatSession {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        // Any valid frame proves the client is alive.
        if msg.is_ok() {
            self.last_seen = Instant::now();
        }
        match msg {
            Ok(ws::Message::Text(text)) => {
                debug!(target: "ws", user_id = self.user_id, len = text.len(), "chat msg in");

                // Only reaction frames carry a `type` field, so this parse fails
                // for other frames and falls through. The emoji must not ride on
                // ChatMessage.content, which is held to the E2E-envelope check.
                if let Ok(frame) = serde_json::from_str::<super::reactions::ReactionFrame>(&text)
                    && frame.r#type == "react"
                {
                    let pool = self.pool.clone();
                    let cache = self.cache.clone();
                    let actor_id = self.user_id;
                    actix::spawn(async move {
                        super::reactions::handle_react(&pool, &cache, actor_id, frame).await;
                    });
                    return;
                }

                let parsed: Result<ChatMessage, _> = serde_json::from_str(&text);

                if let Ok(data) = parsed {
                    if matches!(data.status, Some(MessageStatus::Read)) {
                        let pool = self.pool.clone();
                        let cache = self.cache.clone();
                        let reader = self.user_id;
                        let Some(other) = data.receiver_id else {
                            return;
                        };

                        actix::spawn(async move {
                            // The sender's client keys status updates on
                            // `message_id`, so each receipt must name one.
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

                    let pool = self.pool.clone();
                    let cache = self.cache.clone();
                    let sender_id = self.user_id;
                    let uses_standard = self.uses_standard_encryption;
                    let receiver_id = data.receiver_id;
                    let channel_id = data.channel_id;
                    let parent_message_id = data.parent_message_id;
                    let client_id = data.client_id.clone();
                    let content = data.content.clone();
                    let attachment_ids = data.attachment_ids.clone();

                    // Threads are channel-only: the `messages` (DM) table has no
                    // parent column, so a DM carrying one is malformed.
                    if parent_message_id.is_some() && channel_id.is_none() {
                        warn!(
                            target: "ws",
                            sender_id,
                            parent_message_id = ?parent_message_id,
                            "rejected DM with parent_message_id (threads are channel-only)"
                        );
                        return;
                    }

                    // The server must never see chat plaintext. Only enterprise
                    // senders may send it; everyone else must supply an E2E
                    // envelope and their plaintext is rejected. The server-AES
                    // layer below wraps whatever arrives for storage at rest and
                    // is not the confidentiality boundary.
                    if !uses_standard && !content.starts_with(CHAT_E2E_PREFIX) {
                        error!(
                            target: "ws",
                            sender_id,
                            receiver_id = ?receiver_id,
                            channel_id = ?channel_id,
                            "rejected plaintext chat message from non-enterprise sender"
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

                                // The parent must exist in this same channel and
                                // be top-level: threads are flat, never nested.
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

                                let message_id: i32 = row.get("id");

                                // An attachment targets a channel_message_id or a
                                // message_id, never both: DMs and channel
                                // messages are separate tables with separate id
                                // spaces. Scoped to unlinked rows this sender
                                // uploaded.
                                if !attachment_ids.is_empty() {
                                    let _ = sqlx::query(
                                        "UPDATE chat_attachments SET channel_message_id = $1 \
                                         WHERE id = ANY($2) AND uploader_id = $3 \
                                           AND message_id IS NULL \
                                           AND channel_message_id IS NULL",
                                    )
                                    .bind(message_id)
                                    .bind(&attachment_ids)
                                    .bind(sender_id)
                                    .execute(&pool)
                                    .await;
                                }

                                let members_fut = sqlx::query_scalar::<_, i32>(
                                    "SELECT user_id FROM channel_members WHERE channel_id = $1",
                                )
                                .bind(channel_id)
                                .fetch_all(&pool);
                                let owner_fut =
                                    crate::webhooks::handler::owner_for_user(&pool, sender_id);
                                let (members, owner) = tokio::join!(members_fut, owner_fut);
                                let members = members?;

                                // Metadata only: the server has no plaintext to
                                // emit.
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
                        let pool_for_slack = pool.clone();
                        let content_for_slack = content.clone();
                        let sender_name = self.sender_name.clone();
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
                                        "sender_name": sender_name.clone(),
                                        "content": content,
                                        "status": "sent",
                                        "created_at": created_at.to_rfc3339(),
                                        "parent_message_id": parent_message_id,
                                        "client_id": client_id,
                                    })
                                    .to_string();

                                    // Concurrent so latency does not scale with
                                    // channel size.
                                    let recipients: Vec<i32> =
                                        members.into_iter().filter(|&m| m != sender_id).collect();
                                    let payload = msg_json.clone();
                                    actix_web::rt::spawn(async move {
                                        futures::future::join_all(
                                            recipients.into_iter().map(|member_id| {
                                                let cache = cache_for_fanout.clone();
                                                let payload = payload.clone();
                                                async move {
                                                    fan_out_user(&cache, member_id, payload).await
                                                }
                                            }),
                                        )
                                        .await;
                                    });

                                    // Gated on `uses_standard` so an E2E envelope
                                    // is never forwarded to Slack.
                                    if uses_standard {
                                        let pool_slack = pool_for_slack.clone();
                                        let text = content_for_slack.clone();
                                        let author = sender_name.clone();
                                        actix_web::rt::spawn(async move {
                                            crate::integrations::slack::sync::push_to_slack_if_linked(
                                                &pool_slack,
                                                channel_id,
                                                &text,
                                                &author,
                                            )
                                            .await;
                                        });
                                    }

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
                        // Tenant isolation: a DM is allowed only between accounts
                        // sharing a scope. User ids are guessable, so the boundary
                        // cannot live in the people-picker alone.
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

                        // The DM side of the attachment XOR: message_id is set and
                        // channel_message_id stays null.
                        if !attachment_ids.is_empty() {
                            let _ = sqlx::query(
                                "UPDATE chat_attachments SET message_id = $1 \
                                 WHERE id = ANY($2) AND uploader_id = $3 \
                                   AND message_id IS NULL \
                                   AND channel_message_id IS NULL",
                            )
                            .bind(message_id)
                            .bind(&attachment_ids)
                            .bind(sender_id)
                            .execute(&pool)
                            .await;
                        }

                        // Persist `delivered` for a connected recipient so it
                        // survives a history refetch. The offline case is handled
                        // by mark_delivered_on_connect.
                        if SESSIONS.addr(receiver_id).is_some() {
                            let _ = sqlx::query(
                                "UPDATE messages SET status = 'delivered' \
                                 WHERE id = $1 AND status = 'sent'",
                            )
                            .bind(message_id)
                            .execute(&pool)
                            .await;
                        }

                        // Metadata only: content stays end-to-end encrypted.
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

                                // Best-effort and gated on local presence; a
                                // cross-instance answer needs a shared presence
                                // registry. The status must ride on this same echo
                                // frame as the server-assigned message_id: a
                                // separate status_update can race the sender's
                                // optimistic reconciliation and be dropped.
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

                                let cache_for_fanout = cache.clone();
                                let payload = msg_json.clone();
                                actix_web::rt::spawn(async move {
                                    fan_out_user(&cache_for_fanout, receiver_id, payload).await;
                                });

                                ctx.text(msg_json);

                                // So the next history fetch sees this message.
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
            Ok(ws::Message::Pong(_)) => {}
            Ok(ws::Message::Close(_)) => ctx.stop(),
            _ => {}
        }
    }
}
