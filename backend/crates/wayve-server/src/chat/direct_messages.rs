use crate::cache::Cache;
use crate::models::message::Message;
use crate::prelude::*;
use wayve_security::encryption::decrypt;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::QueryParams;

use sqlx::Row;
use tracing::{error, instrument, warn};

#[instrument(target = "http", skip(req, pool, _cache, query), fields(user1 = query.user1, user2 = query.user2))]
pub async fn get_messages(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    _cache: web::Data<Option<Cache>>,
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

    // Two ordered scans (each index-served by idx_messages_conversation /
    // idx_messages_reverse) merged via UNION ALL, then a final 50-row cap.
    // Faster than a single OR-predicate which forces a bitmap scan + sort.
    let rows = sqlx::query(
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
    .await?;

    let _ = sqlx::query(
        r#"
        UPDATE messages
        SET status = 'read'
        WHERE receiver_id = $1 AND sender_id = $2
          AND status <> 'read'
        "#,
    )
    .bind(query.user1)
    .bind(query.user2)
    .execute(pool.get_ref())
    .await;

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

    messages.reverse();

    Ok(HttpResponse::Ok().json(messages))
}
