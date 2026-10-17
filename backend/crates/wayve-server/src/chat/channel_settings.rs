use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::{UpdateChannelSubjectInput, UpdateChannelVisibilityInput};
use super::helpers::{can_manage_channel, lock_channel};
use wayve_security::rbac::resolve_role_context_moded;

use actix_web::{delete, patch};
use tracing::{instrument, warn};

#[patch("/chat/channels/{channel_id}")]
#[instrument(target = "http", skip(req, pool, input), fields(channel_id))]
pub async fn update_channel_subject(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
    input: web::Json<UpdateChannelSubjectInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    let ctx = resolve_role_context_moded(&req, pool.get_ref(), user_id).await?;
    if !can_manage_channel(pool.get_ref(), &ctx, channel_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can change the subject"
        })));
    }

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Channel subject is required"
        })));
    }

    sqlx::query("UPDATE channels SET name = $1 WHERE id = $2")
        .bind(name)
        .bind(channel_id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "name": name })))
}

#[patch("/chat/channels/{channel_id}/visibility")]
#[instrument(target = "http", skip(req, pool, input), fields(channel_id))]
pub async fn update_channel_visibility(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
    input: web::Json<UpdateChannelVisibilityInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    let ctx = resolve_role_context_moded(&req, pool.get_ref(), user_id).await?;
    if !can_manage_channel(pool.get_ref(), &ctx, channel_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can change visibility"
        })));
    }

    let visibility = match input.visibility.as_str() {
        "public" => "public",
        _ => "private",
    };

    sqlx::query("UPDATE channels SET visibility = $1 WHERE id = $2")
        .bind(visibility)
        .bind(channel_id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "visibility": visibility })))
}

/// Delete a channel for everyone: its members, invites, join requests,
/// messages, replies, reactions and attachments, all of which cascade from
/// `channels`. Channel admins only (and an owner recovering an admin-less
/// channel), like every other channel setting. The channel row is locked first,
/// so it can't race a membership change.
#[delete("/chat/channels/{channel_id}")]
#[instrument(target = "http", skip(req, pool), fields(channel_id))]
pub async fn delete_channel(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();
    let ctx = resolve_role_context_moded(&req, pool.get_ref(), user_id).await?;

    let mut tx = pool.begin().await?;
    if !lock_channel(&mut tx, channel_id).await? {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({
            "error": "Channel not found"
        })));
    }
    if !can_manage_channel(&mut *tx, &ctx, channel_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can delete the channel"
        })));
    }

    let name: Option<String> = sqlx::query_scalar("SELECT name FROM channels WHERE id = $1")
        .bind(channel_id)
        .fetch_optional(&mut *tx)
        .await?;
    let members: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM channel_members WHERE channel_id = $1")
            .bind(channel_id)
            .fetch_one(&mut *tx)
            .await?;
    // The cascade removes attachment rows, not the stored files, so collect
    // their paths while the rows still exist.
    let files: Vec<String> = sqlx::query_scalar(
        "SELECT a.file_path FROM chat_attachments a \
         JOIN channel_messages m ON m.id = a.channel_message_id \
         WHERE m.channel_id = $1",
    )
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM channels WHERE id = $1")
        .bind(channel_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // After the commit, so a rolled-back delete never loses a file. Best
    // effort: a file left behind is unreachable, as its row is gone.
    for path in &files {
        if let Err(err) = crate::storage::delete(path).await {
            warn!(target: "chat", channel_id, path, error = %err, "channel attachment file not deleted");
        }
    }

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "channel_deleted",
            resource_type: "channel",
            resource_id: Some(channel_id.to_string()),
            metadata: Some(serde_json::json!({
                "channel_id": channel_id,
                "channel": name,
                "members": members,
                "attachments": files.len(),
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
