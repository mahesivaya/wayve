use crate::cache::Cache;
use crate::models::message::Message;
use crate::prelude::*;
use wayve_security::encryption::decrypt;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::QueryParams;

use sqlx::Row;
use tracing::{error, instrument, warn};

#[instrument(target = "http", skip(req, pool, cache, query), fields(user1 = query.user1, user2 = query.user2))]
pub async fn get_messages(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    cache: web::Data<Option<Cache>>,
    query: web::Query<QueryParams>,
) -> AppResult {
    // Auth: require a valid JWT and confirm the caller is one of the two
    // participants. Without this, any caller could read any conversation by
    // supplying arbitrary user1/user2 ids.
    let caller_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    if caller_id != query.user1 && caller_id != query.user2 {
        warn!(
            target: "auth",
            caller_id,
            user1 = query.user1,
            user2 = query.user2,
            "get_messages rejected: caller is not a conversation participant"
        );
        return Ok(HttpResponse::Forbidden().finish());
    }

    // Reconnect resync: when `since_id` is set, return everything newer than
    // that id (chronological), so a client that briefly dropped can backfill
    // exactly the messages it missed instead of just re-fetching the latest 50.
    // Capped to bound the response. Otherwise fall back to "latest 50".
    let rows = if let Some(since_id) = query.since_id {
        sqlx::query(
            r#"
            SELECT id, sender_id, receiver_id, content_encrypted, content_iv, status::TEXT AS status, created_at
            FROM messages
            WHERE ((sender_id = $1 AND receiver_id = $2)
                OR (sender_id = $2 AND receiver_id = $1))
              AND id > $3
            ORDER BY created_at ASC
            LIMIT 500
            "#,
        )
        .bind(query.user1)
        .bind(query.user2)
        .bind(since_id)
        .fetch_all(pool.get_ref())
        .await?
    } else {
        // Two ordered scans (each index-served by idx_messages_conversation /
        // idx_messages_reverse) merged via UNION ALL, then a final 50-row cap.
        // Faster than a single OR-predicate which forces a bitmap scan + sort.
        sqlx::query(
            r#"
            SELECT id, sender_id, receiver_id, content_encrypted, content_iv, status::TEXT AS status, created_at
            FROM (
                (
                    SELECT id, sender_id, receiver_id, content_encrypted, content_iv, status, created_at
                    FROM messages
                    WHERE sender_id = $1 AND receiver_id = $2
                    ORDER BY created_at DESC
                    LIMIT 50
                )
                UNION ALL
                (
                    SELECT id, sender_id, receiver_id, content_encrypted, content_iv, status, created_at
                    FROM messages
                    WHERE sender_id = $2 AND receiver_id = $1
                    ORDER BY created_at DESC
                    LIMIT 50
                )
            ) AS m
            ORDER BY created_at DESC
            LIMIT 50
            "#,
        )
        .bind(query.user1)
        .bind(query.user2)
        .fetch_all(pool.get_ref())
        .await?
    };

    // Mark everything the caller (user1) received from user2 as read, and
    // notify the sender (user2) live so their bubbles flip to the blue
    // double-check without waiting for their next history fetch.
    let read_ids: Vec<(i32,)> = sqlx::query_as(
        r#"
        UPDATE messages
        SET status = 'read'
        WHERE receiver_id = $1 AND sender_id = $2
          AND status <> 'read'
        RETURNING id
        "#,
    )
    .bind(query.user1)
    .bind(query.user2)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();

    for (message_id,) in &read_ids {
        let payload = serde_json::json!({
            "type": "status_update",
            "message_id": message_id,
            "status": "read"
        })
        .to_string();
        super::websocket::fan_out_user(cache.get_ref(), query.user2, payload).await;
    }

    let mut messages: Vec<Message> = rows
        .into_iter()
        .map(|row| {
            let encrypted: String = row.get("content_encrypted");
            let iv: String = row.get("content_iv");

            let content = match decrypt(&iv, &encrypted) {
                Ok(text) => text,
                Err(e) => {
                    error!(target: "ws", error = %e, "message decrypt failed");
                    "[decryption failed]".to_string()
                }
            };

            let created_naive: chrono::NaiveDateTime = row.get("created_at");
            let created_at = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                created_naive,
                chrono::Utc,
            );

            Message {
                message_id: Some(row.get("id")),
                sender_id: row.get("sender_id"),
                receiver_id: row.get("receiver_id"),
                content,
                status: Some(row.get::<String, _>("status")),
                created_at: Some(created_at),
            }
        })
        .collect();

    // The default ("latest 50") query returns rows newest-first; flip to
    // chronological for the client. The since_id query already selects ASC.
    if query.since_id.is_none() {
        messages.reverse();
    }

    Ok(HttpResponse::Ok().json(messages))
}

/// `GET /chat/conversations` — per-DM-conversation summary for the caller:
/// the other participant's id, the timestamp of the latest message (for
/// recency ordering), and how many messages from them are still unread. Plus
/// a `total_unread` across all conversations. Content stays E2E-encrypted —
/// this returns only counts + timestamps, never message text. One grouped
/// scan over `messages` (DM-only table), served by the conversation indexes.
#[instrument(target = "http", skip(req, pool))]
pub async fn get_conversation_summary(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = sqlx::query(
        r#"
        SELECT
            CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS other_id,
            MAX(created_at) AS last_message_at,
            COUNT(*) FILTER (WHERE receiver_id = $1 AND status <> 'read') AS unread_count
        FROM messages
        WHERE (sender_id = $1 OR receiver_id = $1)
          AND sender_id IS NOT NULL
          AND receiver_id IS NOT NULL
        GROUP BY other_id
        ORDER BY last_message_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool.get_ref())
    .await?;

    let mut total_unread: i64 = 0;
    let conversations: Vec<_> = rows
        .into_iter()
        .filter_map(|row| {
            let other_id: Option<i32> = row.try_get("other_id").ok().flatten();
            let other_id = other_id?;
            let last: Option<NaiveDateTime> = row.try_get("last_message_at").ok().flatten();
            let unread: i64 = row.try_get("unread_count").unwrap_or(0);
            total_unread += unread;
            let last_message_at = last.map(|dt| {
                chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc)
                    .to_rfc3339()
            });
            Some(serde_json::json!({
                "user_id": other_id,
                "unread_count": unread,
                "last_message_at": last_message_at,
            }))
        })
        .collect();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "total_unread": total_unread,
        "conversations": conversations,
    })))
}
