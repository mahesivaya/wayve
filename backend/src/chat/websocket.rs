use crate::cache::{Cache, chat_history_key};
use crate::models::message::{ChatMessage, MessageStatus};
use crate::prelude::*;
use crate::security::encryption::encrypt;

use super::dto::WsAuthQuery;

use crate::ws_registry::SessionRegistry;

use actix::{Actor, ActorFutureExt, Handler, Message as ActixMessage, StreamHandler};
use actix_web_actors::ws;
use actix_web_actors::ws::WebsocketContext;
use sqlx::{PgPool, Row};
use tracing::{debug, error, info, instrument, warn};

const CHAT_E2E_PREFIX: &str = "WAYVE_CHAT_E2E_V1\n";

static SESSIONS: Lazy<SessionRegistry<ChatSession>> = Lazy::new(SessionRegistry::new);

#[derive(ActixMessage)]
#[rtype(result = "()")]
pub struct WsMessage(pub String);

// ================= CHAT SESSION =================

pub struct ChatSession {
    pub pool: PgPool,
    pub user_id: i32,
    pub cache: Option<Cache>,
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
    let user_id = match crate::security::jwt::get_user_id_from_request(&req).or_else(|| {
        query
            .token
            .clone()
            .filter(|token| !token.trim().is_empty())
            .and_then(|token| crate::security::jwt::decode_jwt(&token))
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
                            let updated = sqlx::query(
                                r#"
                                UPDATE messages
                                SET status = 'read'
                                WHERE receiver_id = $1 AND sender_id = $2
                                  AND status <> 'read'
                                "#,
                            )
                            .bind(reader)
                            .bind(other)
                            .execute(&pool)
                            .await;

                            if let Some(cache) = cache.as_ref() {
                                cache.del(&chat_history_key(reader, other)).await;
                            }

                            if updated
                                .as_ref()
                                .map(|result| result.rows_affected() > 0)
                                .unwrap_or(false)
                            {
                                let receipt = serde_json::json!({
                                    "type": "status_update",
                                    "sender_id": reader,
                                    "receiver_id": other,
                                    "status": "read"
                                })
                                .to_string();

                                if let Some(addr) = SESSIONS.addr(other) {
                                    addr.do_send(WsMessage(receipt));
                                }
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
                    let content = data.content.clone();

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

                                Ok::<_, sqlx::Error>((row, members))
                            }
                        };

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
                                    })
                                    .to_string();

                                    for member_id in members {
                                        if member_id == sender_id {
                                            continue;
                                        }

                                        if let Some(addr) = SESSIONS.addr(member_id) {
                                            addr.do_send(WsMessage(msg_json.clone()));
                                        }
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

                        sqlx::query(
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
                        .await
                    };

                    let sender_addr = ctx.address();

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

                                let msg_json = serde_json::json!({
                                    "message_id": message_id,
                                    "sender_id": sender_id,
                                    "receiver_id": receiver_id,
                                    "content": content,
                                    "status": "sent",
                                    "created_at": created_at.to_rfc3339()
                                })
                                .to_string();

                                // SEND TO RECEIVER
                                if let Some(addr) = SESSIONS.addr(receiver_id) {
                                    addr.do_send(WsMessage(msg_json.clone()));

                                    // 🔥 DELIVERED
                                    let delivered_json = serde_json::json!({
                                        "type": "status_update",
                                        "message_id": message_id,
                                        "status": "delivered"
                                    })
                                    .to_string();

                                    sender_addr.do_send(WsMessage(delivered_json));
                                }

                                // SEND BACK TO SENDER
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
            Ok(ws::Message::Close(_)) => ctx.stop(),
            _ => {}
        }
    }
}
