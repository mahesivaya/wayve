use crate::prelude::*;
use wayve_security::encryption::decrypt;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::ChannelMessagesQuery;

use sqlx::Row;
use tracing::{error, instrument};

// History for the main channel feed: the 50 most recent top-level messages, each
// carrying its reply count so the UI can render the thread link without a second
// round-trip. Replies themselves come from `get_channel_thread` on demand.
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

    // `channel_messages` is RLS-enabled, so read under the restricted role with
    // the caller's GUC to engage the membership policy.
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.user_id', $1, true)")
        .bind(user_id.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL ROLE wayve_app")
        .execute(&mut *tx)
        .await?;

    // Reconnect resync: with `since_id` set, return top-level messages newer than
    // that id in chronological order, backfilling what the dropped socket missed.
    // Otherwise return the latest 50.
    let rows = if let Some(since_id) = query.since_id {
        sqlx::query(
            r#"
            SELECT m.id,
                   m.channel_id,
                   m.sender_id,
                   COALESCE(NULLIF(u.username, ''), u.email) AS sender_name,
                   m.content_encrypted,
                   m.content_iv,
                   m.created_at,
                   m.parent_message_id,
                   COALESCE((
                       SELECT COUNT(*) FROM channel_messages r
                       WHERE r.parent_message_id = m.id
                   ), 0) AS reply_count
            FROM channel_messages m
            LEFT JOIN users u ON u.id = m.sender_id
            WHERE m.channel_id = $1 AND m.parent_message_id IS NULL
              AND m.id > $2
            ORDER BY m.created_at ASC
            LIMIT 500
            "#,
        )
        .bind(query.channel_id)
        .bind(since_id)
        .fetch_all(&mut *tx)
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT m.id,
                   m.channel_id,
                   m.sender_id,
                   COALESCE(NULLIF(u.username, ''), u.email) AS sender_name,
                   m.content_encrypted,
                   m.content_iv,
                   m.created_at,
                   m.parent_message_id,
                   COALESCE((
                       SELECT COUNT(*) FROM channel_messages r
                       WHERE r.parent_message_id = m.id
                   ), 0) AS reply_count
            FROM channel_messages m
            LEFT JOIN users u ON u.id = m.sender_id
            WHERE m.channel_id = $1 AND m.parent_message_id IS NULL
            ORDER BY m.created_at DESC
            LIMIT 50
            "#,
        )
        .bind(query.channel_id)
        .fetch_all(&mut *tx)
        .await?
    };
    tx.commit().await?;

    let mut messages: Vec<_> = rows.into_iter().map(row_to_message_json).collect();
    // The default query is newest-first; the since_id query already ASC.
    if query.since_id.is_none() {
        messages.reverse();
    }
    super::reactions::attach_to_json(pool.get_ref(), &mut messages, true).await;
    Ok(HttpResponse::Ok().json(messages))
}

// Every reply under a top-level channel message, oldest first. The parent is not
// included; the frontend already has it from the main feed.
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

    let rows = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let rows = sqlx::query(
            r#"
        SELECT m.id,
               m.channel_id,
               m.sender_id,
               COALESCE(NULLIF(u.username, ''), u.email) AS sender_name,
               m.content_encrypted,
               m.content_iv,
               m.created_at,
               m.parent_message_id,
               0::bigint AS reply_count
        FROM channel_messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.parent_message_id = $1
        ORDER BY m.created_at ASC
        "#,
        )
        .bind(parent_id)
        .fetch_all(&mut *tx)
        .await?;
        Ok((tx, rows))
    })
    .await?;

    let mut messages: Vec<_> = rows.into_iter().map(row_to_message_json).collect();
    super::reactions::attach_to_json(pool.get_ref(), &mut messages, true).await;
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
        "sender_name": row.try_get::<Option<String>, _>("sender_name").ok().flatten(),
        "content": content,
        "status": "sent",
        "created_at": created_at.to_rfc3339(),
        "parent_message_id": row.get::<Option<i32>, _>("parent_message_id"),
        "reply_count": row.get::<i64, _>("reply_count"),
    })
}
