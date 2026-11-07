//! The DM details panel: who the other person is, and every file the two of you
//! have exchanged.
//!
//! - `GET /api/chat/users/{id}/profile`: the peer's public profile fields,
//!   presence status and the channels you both belong to. Only for people the
//!   caller may already see in the chat directory, or has a DM with.
//! - `GET /api/chat/direct-messages/{peer_id}/files`: the DM messages that carry
//!   attachments, newest first and paged by `before_id`. File names, sizes and
//!   per-file keys live inside each message's E2E envelope, so the rows come back
//!   as envelopes (storage layer stripped) for the browser to decrypt, exactly as
//!   the history endpoint returns them.

use crate::models::message::Message;
use crate::prelude::*;
use chrono::{DateTime, Utc};
use sqlx::Row;
use tracing::{error, instrument};
use wayve_security::encryption::decrypt;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac;

const FILES_DEFAULT_LIMIT: i64 = 50;
const FILES_MAX_LIMIT: i64 = 200;
const SHARED_CHANNELS_LIMIT: i64 = 50;

fn utc(naive: Option<NaiveDateTime>) -> Option<DateTime<Utc>> {
    naive.map(|dt| DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc))
}

#[derive(Serialize)]
struct SharedChannel {
    id: i32,
    name: String,
}

#[derive(Serialize)]
struct PeerProfile {
    id: i32,
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
    username: Option<String>,
    has_avatar: bool,
    /// The status the person picked (active / dnd / away). Live
    /// online/offline still comes from the presence endpoint.
    chat_status: String,
    last_seen: Option<DateTime<Utc>>,
    organization_name: Option<String>,
    member_since: Option<DateTime<Utc>>,
    shared_channels: Vec<SharedChannel>,
}

#[get("/chat/users/{id}/profile")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_peer_profile(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let caller_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let peer_id = path.into_inner();
    let ctx = rbac::resolve_role_context(pool.get_ref(), caller_id).await?;

    // Same visibility as the chat people-picker, widened to anyone the caller
    // already has a DM with (a conversation can outlive a tenant change). Anyone
    // else is a 404, so the endpoint can't be used to probe for accounts.
    let row = sqlx::query(&format!(
        r#"
        SELECT u.id, u.email, u.first_name, u.last_name, u.username,
               (u.avatar_path IS NOT NULL) AS has_avatar,
               u.chat_status, u.last_seen, u.created_at,
               o.name AS organization_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.id = $4
          AND ( {visible_users}
                OR EXISTS (
                    SELECT 1 FROM messages dm
                    WHERE (dm.sender_id = $1 AND dm.receiver_id = u.id)
                       OR (dm.sender_id = u.id AND dm.receiver_id = $1)
                ) )
        "#,
        visible_users = crate::directory_scope::VISIBLE_USERS,
    ))
    .bind(caller_id)
    .bind(ctx.scope.as_str())
    .bind(ctx.organization_id)
    .bind(peer_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({
            "message": "User not found"
        })));
    };

    let shared_channels = sqlx::query(
        r#"
        SELECT c.id, c.name
        FROM channels c
        JOIN channel_members mine ON mine.channel_id = c.id AND mine.user_id = $1
        JOIN channel_members theirs ON theirs.channel_id = c.id AND theirs.user_id = $2
        ORDER BY lower(c.name), c.id
        LIMIT $3
        "#,
    )
    .bind(caller_id)
    .bind(peer_id)
    .bind(SHARED_CHANNELS_LIMIT)
    .fetch_all(pool.get_ref())
    .await?
    .into_iter()
    .map(|r| SharedChannel {
        id: r.get("id"),
        name: r.get("name"),
    })
    .collect();

    Ok(HttpResponse::Ok().json(PeerProfile {
        id: row.get("id"),
        email: row.get("email"),
        first_name: row.get("first_name"),
        last_name: row.get("last_name"),
        username: row.get("username"),
        has_avatar: row.get("has_avatar"),
        chat_status: row.get("chat_status"),
        last_seen: row.get("last_seen"),
        organization_name: row.get("organization_name"),
        member_since: utc(row.get("created_at")),
        shared_channels,
    }))
}

#[derive(Deserialize)]
pub struct FilesQuery {
    /// Return messages older than this message id (the last one of the previous
    /// page).
    pub before_id: Option<i32>,
    pub limit: Option<i64>,
}

#[get("/chat/direct-messages/{peer_id}/files")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn get_dm_files(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    query: web::Query<FilesQuery>,
) -> AppResult {
    let caller_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let peer_id = path.into_inner();
    let limit = query
        .limit
        .unwrap_or(FILES_DEFAULT_LIMIT)
        .clamp(1, FILES_MAX_LIMIT);
    let before_id = query.before_id;

    // Under the caller's RLS context, `messages` only yields their own DMs and
    // `chat_attachments` only attachments on those, so the WHERE clause is a
    // second, not the only, guard.
    let rows = crate::db::with_rls_user_tx(pool.get_ref(), caller_id, |mut tx| async move {
        let rows = sqlx::query(
            r#"
            SELECT m.id, m.sender_id, m.receiver_id, m.content_encrypted, m.content_iv,
                   m.status::TEXT AS status, m.created_at
            FROM messages m
            WHERE ((m.sender_id = $1 AND m.receiver_id = $2)
                OR (m.sender_id = $2 AND m.receiver_id = $1))
              AND ($3::INT IS NULL OR m.id < $3)
              AND EXISTS (SELECT 1 FROM chat_attachments a WHERE a.message_id = m.id)
            ORDER BY m.id DESC
            LIMIT $4
            "#,
        )
        .bind(caller_id)
        .bind(peer_id)
        .bind(before_id)
        .bind(limit)
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
    .await?;

    // As in the history endpoint, only the storage-at-rest layer is removed; the
    // browser decrypts the envelope.
    let messages: Vec<Message> = rows
        .into_iter()
        .map(|row| {
            let encrypted: String = row.get("content_encrypted");
            let iv: String = row.get("content_iv");
            let content = decrypt(&iv, &encrypted).unwrap_or_else(|e| {
                error!(target: "ws", error = %e, "message decrypt failed");
                "[decryption failed]".to_string()
            });
            Message {
                message_id: Some(row.get("id")),
                sender_id: row.get("sender_id"),
                receiver_id: row.get("receiver_id"),
                content,
                status: Some(row.get::<String, _>("status")),
                created_at: utc(row.get("created_at")),
                reactions: Vec::new(),
            }
        })
        .collect();

    Ok(HttpResponse::Ok().json(messages))
}
