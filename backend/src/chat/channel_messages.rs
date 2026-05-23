use crate::prelude::*;
use crate::security::encryption::decrypt;
use crate::security::jwt::get_user_id_from_request;

use super::dto::ChannelMessagesQuery;

use sqlx::Row;
use tracing::{error, instrument};

// History fetch for the main channel feed. Returns the 50 most recent
// *top-level* messages (parent_message_id IS NULL). Each row carries the
// number of replies under it so the UI can render the "N replies →" link
// without a second round-trip. Threaded replies themselves are fetched on
// demand via `get_channel_thread` when the user opens a thread.
#[get("/chat/channel-messages")]
#[instrument(target = "http", skip(req, pool, query), fields(channel_id = query.channel_id))]
pub async fn get_channel_messages(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<ChannelMessagesQuery>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    if !is_channel_member(pool.get_ref(), query.channel_id, user_id).await? {
        return Ok(HttpResponse::Forbidden().finish());
    }

    let rows = sqlx::query(
        r#"
        SELECT m.id,
               m.channel_id,
               m.sender_id,
               m.content_encrypted,
               m.content_iv,
               m.created_at,
               m.parent_message_id,
               COALESCE((
                   SELECT COUNT(*) FROM channel_messages r
                   WHERE r.parent_message_id = m.id
               ), 0) AS reply_count
        FROM channel_messages m
        WHERE m.channel_id = $1 AND m.parent_message_id IS NULL
        ORDER BY m.created_at DESC
        LIMIT 50
        "#,
    )
    .bind(query.channel_id)
    .fetch_all(pool.get_ref())
    .await?;

    let mut messages: Vec<_> = rows.into_iter().map(row_to_message_json).collect();
    messages.reverse();
    Ok(HttpResponse::Ok().json(messages))
}

// Returns every reply under a given top-level channel message, in ascending
// time order. The parent is NOT included — the frontend already has it from
// the main feed fetch. Forbidden if the caller isn't a member of the parent's
// channel; 404 if the parent doesn't exist.
#[get("/chat/channel-messages/{id}/thread")]
#[instrument(target = "http", skip(req, pool, path), fields(parent_id = *path))]
pub async fn get_channel_thread(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let parent_id = path.into_inner();

    let parent_channel: Option<i32> =
        sqlx::query_scalar("SELECT channel_id FROM channel_messages WHERE id = $1")
            .bind(parent_id)
            .fetch_optional(pool.get_ref())
            .await?;

    let Some(channel_id) = parent_channel else {
        return Ok(HttpResponse::NotFound().finish());
    };

    if !is_channel_member(pool.get_ref(), channel_id, user_id).await? {
        return Ok(HttpResponse::Forbidden().finish());
    }

    let rows = sqlx::query(
        r#"
        SELECT id,
               channel_id,
               sender_id,
               content_encrypted,
               content_iv,
               created_at,
               parent_message_id,
               0::bigint AS reply_count
        FROM channel_messages
        WHERE parent_message_id = $1
        ORDER BY created_at ASC
        "#,
    )
    .bind(parent_id)
    .fetch_all(pool.get_ref())
    .await?;

    let messages: Vec<_> = rows.into_iter().map(row_to_message_json).collect();
    Ok(HttpResponse::Ok().json(messages))
}

async fn is_channel_member(pool: &PgPool, channel_id: i32, user_id: i32) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM channel_members
            WHERE channel_id = $1 AND user_id = $2
        )
        "#,
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?)
}

fn row_to_message_json(row: sqlx::postgres::PgRow) -> serde_json::Value {
    let encrypted: String = row.get("content_encrypted");
    let iv: String = row.get("content_iv");
    let content = match decrypt(&iv, &encrypted) {
        Ok(text) => text,
        Err(e) => {
            error!(target: "ws", error = %e, "channel message decrypt failed");
            "[decryption failed]".to_string()
        }
    };

    let created_naive: chrono::NaiveDateTime = row.get("created_at");
    let created_at =
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(created_naive, chrono::Utc);

    serde_json::json!({
        "message_id": row.get::<i32, _>("id"),
        "channel_id": row.get::<i32, _>("channel_id"),
        "sender_id": row.get::<i32, _>("sender_id"),
        "content": content,
        "status": "sent",
        "created_at": created_at.to_rfc3339(),
        "parent_message_id": row.get::<Option<i32>, _>("parent_message_id"),
        "reply_count": row.get::<i64, _>("reply_count"),
    })
}
