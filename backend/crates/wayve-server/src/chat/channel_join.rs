use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::JoinRequestActionInput;
use super::helpers::is_channel_admin;

use sqlx::Row;
use tracing::instrument;

#[post("/chat/channels/{channel_id}/join")]
#[instrument(target = "http", skip(req, pool), fields(channel_id))]
pub async fn join_channel(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    let row = sqlx::query(
        r#"
        SELECT
            visibility,
            EXISTS(
                SELECT 1 FROM channel_members
                WHERE channel_id = channels.id AND user_id = $2
            ) AS is_member
        FROM channels
        WHERE id = $1
        "#,
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("channel"))?;

    if row.get::<bool, _>("is_member") {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "status": "joined" })));
    }

    if row.get::<String, _>("visibility") == "public" {
        sqlx::query(
            r#"
            INSERT INTO channel_members (channel_id, user_id, role)
            VALUES ($1, $2, 'user')
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(channel_id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
        Ok(HttpResponse::Ok().json(serde_json::json!({ "status": "joined" })))
    } else {
        sqlx::query(
            r#"
            INSERT INTO channel_join_requests (channel_id, user_id, status)
            VALUES ($1, $2, 'pending')
            ON CONFLICT (channel_id, user_id)
            DO UPDATE SET status = 'pending', requested_at = NOW()
            "#,
        )
        .bind(channel_id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
        Ok(HttpResponse::Ok().json(serde_json::json!({ "status": "pending" })))
    }
}

#[post("/chat/channels/{channel_id}/join-requests/approve")]
#[instrument(target = "http", skip(req, pool, input), fields(channel_id))]
pub async fn approve_channel_join_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
    input: web::Json<JoinRequestActionInput>,
) -> AppResult {
    let admin_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    if !is_channel_admin(pool.get_ref(), channel_id, admin_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can approve requests"
        })));
    }

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO channel_members (channel_id, user_id, role)
        VALUES ($1, $2, 'user')
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(channel_id)
    .bind(input.user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM channel_join_requests WHERE channel_id = $1 AND user_id = $2")
        .bind(channel_id)
        .bind(input.user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(HttpResponse::Ok().finish())
}
