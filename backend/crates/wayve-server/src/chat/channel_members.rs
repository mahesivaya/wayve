use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::{AddChannelUsersInput, RemoveChannelUserInput};
use super::helpers::{is_channel_admin, normalize_channel_role, normalize_invite_emails};

use actix_web::delete;
use sqlx::Row;
use tracing::instrument;

#[post("/chat/channels/{channel_id}/members")]
#[instrument(target = "http", skip(req, pool, input), fields(channel_id))]
pub async fn add_channel_users(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
    input: web::Json<AddChannelUsersInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    if !is_channel_admin(pool.get_ref(), channel_id, user_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can add users"
        })));
    }

    let invite_role = normalize_channel_role(input.invite_role.as_deref());
    let invite_emails = normalize_invite_emails(&input.invite_emails);
    if invite_emails.is_empty() {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Add at least one email"
        })));
    }

    let invited_users = sqlx::query("SELECT id, email FROM users WHERE LOWER(email) = ANY($1)")
        .bind(&invite_emails)
        .fetch_all(pool.get_ref())
        .await?
        .into_iter()
        .map(|row| (row.get::<i32, _>("id"), row.get::<String, _>("email")))
        .collect::<Vec<_>>();

    let mut tx = pool.begin().await?;

    for (member_id, email) in &invited_users {
        sqlx::query(
            r#"
            INSERT INTO channel_members (channel_id, user_id, role)
            VALUES ($1, $2, $3)
            ON CONFLICT (channel_id, user_id)
            DO UPDATE SET role = EXCLUDED.role
            "#,
        )
        .bind(channel_id)
        .bind(member_id)
        .bind(invite_role)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "DELETE FROM channel_invites WHERE channel_id = $1 AND LOWER(email) = LOWER($2)",
        )
        .bind(channel_id)
        .bind(email)
        .execute(&mut *tx)
        .await?;
    }

    let registered_invite_emails = invited_users
        .iter()
        .map(|(_id, email)| email.to_lowercase())
        .collect::<Vec<_>>();
    for email in invite_emails
        .iter()
        .filter(|email| !registered_invite_emails.contains(email))
    {
        sqlx::query(
            r#"
            INSERT INTO channel_invites (channel_id, email, role, invited_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (channel_id, email)
            DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by
            "#,
        )
        .bind(channel_id)
        .bind(email)
        .bind(invite_role)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(HttpResponse::Ok().finish())
}

#[delete("/chat/channels/{channel_id}/members")]
#[instrument(target = "http", skip(req, pool, input), fields(channel_id))]
pub async fn remove_channel_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
    input: web::Json<RemoveChannelUserInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    if !is_channel_admin(pool.get_ref(), channel_id, user_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can delete users"
        })));
    }

    let email = input.email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Email is required"
        })));
    }

    let target = sqlx::query(
        r#"
        SELECT cm.user_id, cm.role
        FROM channel_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = $1 AND LOWER(u.email) = $2
        "#,
    )
    .bind(channel_id)
    .bind(&email)
    .fetch_optional(pool.get_ref())
    .await?;

    if let Some(row) = target {
        let target_user_id: i32 = row.get("user_id");
        let target_role: String = row.get("role");

        if target_role == "admin" {
            let admin_count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM channel_members WHERE channel_id = $1 AND role = 'admin'",
            )
            .bind(channel_id)
            .fetch_one(pool.get_ref())
            .await?;

            if admin_count <= 1 {
                return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                    "error": "A channel must keep at least one admin"
                })));
            }
        }

        sqlx::query("DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2")
            .bind(channel_id)
            .bind(target_user_id)
            .execute(pool.get_ref())
            .await?;
    } else {
        sqlx::query("DELETE FROM channel_invites WHERE channel_id = $1 AND LOWER(email) = $2")
            .bind(channel_id)
            .bind(&email)
            .execute(pool.get_ref())
            .await?;
    }

    Ok(HttpResponse::Ok().finish())
}
