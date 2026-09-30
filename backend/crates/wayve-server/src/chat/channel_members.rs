use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::resolve_role_context_moded;

use super::dto::{AddChannelUsersInput, RemoveChannelUserInput, SetChannelMemberRoleInput};
use super::helpers::{
    can_manage_channel, lock_channel, normalize_channel_role, normalize_invite_emails,
    strands_channel,
};

use actix_web::{delete, patch};
use sqlx::Row;
use tracing::instrument;

// Every handler here keeps the channel admin invariant (see `helpers`): it
// takes the channel row lock first, then authorizes and checks against state
// no concurrent change can move underneath it.

const LAST_ADMIN: &str =
    "A channel must keep at least one admin. Make another member an admin first.";

fn forbidden(message: &str) -> HttpResponse {
    HttpResponse::Forbidden().json(serde_json::json!({ "error": message }))
}

fn bad_request(message: &str) -> HttpResponse {
    HttpResponse::BadRequest().json(serde_json::json!({ "error": message }))
}

async fn channel_name(pool: &PgPool, channel_id: i32) -> Option<String> {
    sqlx::query_scalar("SELECT name FROM channels WHERE id = $1")
        .bind(channel_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

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
    let ctx = resolve_role_context_moded(&req, pool.get_ref(), user_id).await?;

    let mut tx = pool.begin().await?;
    if !lock_channel(&mut tx, channel_id).await?
        || !can_manage_channel(&mut *tx, &ctx, channel_id).await?
    {
        return Ok(forbidden("Only channel admins can add users"));
    }

    let invite_role = normalize_channel_role(input.invite_role.as_deref());
    let invite_emails = normalize_invite_emails(&input.invite_emails);
    if invite_emails.is_empty() {
        return Ok(bad_request("Add at least one email"));
    }

    let invited_users = sqlx::query("SELECT id, email FROM users WHERE LOWER(email) = ANY($1)")
        .bind(&invite_emails)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|row| (row.get::<i32, _>("id"), row.get::<String, _>("email")))
        .collect::<Vec<_>>();

    for (member_id, email) in &invited_users {
        // Adding never changes an existing member's role: re-adding an admin
        // with the form's default "Member" role used to silently demote them.
        // Role changes go through `set_channel_member_role`.
        sqlx::query(
            r#"
            INSERT INTO channel_members (channel_id, user_id, role)
            VALUES ($1, $2, $3)
            ON CONFLICT (channel_id, user_id) DO NOTHING
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
    let ctx = resolve_role_context_moded(&req, pool.get_ref(), user_id).await?;

    let mut tx = pool.begin().await?;
    if !lock_channel(&mut tx, channel_id).await?
        || !can_manage_channel(&mut *tx, &ctx, channel_id).await?
    {
        return Ok(forbidden("Only channel admins can delete users"));
    }

    let email = input.email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(bad_request("Email is required"));
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
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = target else {
        sqlx::query("DELETE FROM channel_invites WHERE channel_id = $1 AND LOWER(email) = $2")
            .bind(channel_id)
            .bind(&email)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(HttpResponse::Ok().finish());
    };

    let target_user_id: i32 = row.get("user_id");
    let target_role: String = row.get("role");

    if target_role == "admin" && strands_channel(&mut tx, channel_id, target_user_id, true).await? {
        return Ok(bad_request(LAST_ADMIN));
    }

    sqlx::query("DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2")
        .bind(channel_id)
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // Audited after commit so a rolled-back removal leaves no record. The actor
    // is the user who left or was removed; the metadata records who performed
    // the removal, which matches the actor on a self-leave.
    crate::audit::record_action_system(
        pool.get_ref(),
        crate::audit::AuditEvent {
            actor_user_id: target_user_id,
            action: "channel_left",
            resource_type: "channel",
            resource_id: Some(channel_id.to_string()),
            metadata: Some(serde_json::json!({
                "channel_id": channel_id,
                "channel": channel_name(pool.get_ref(), channel_id).await,
                "removed_by": user_id,
                "self_left": target_user_id == user_id,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().finish())
}

/// Promote a member to admin or demote an admin to member. The only way to
/// change an existing member's role; demoting the last admin is refused.
#[patch("/chat/channels/{channel_id}/members/role")]
#[instrument(target = "http", skip(req, pool, input), fields(channel_id))]
pub async fn set_channel_member_role(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
    input: web::Json<SetChannelMemberRoleInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();
    let ctx = resolve_role_context_moded(&req, pool.get_ref(), user_id).await?;

    let role = match input.role.as_str() {
        "admin" => "admin",
        "user" => "user",
        _ => return Ok(bad_request("Role must be \"admin\" or \"user\"")),
    };

    let mut tx = pool.begin().await?;
    if !lock_channel(&mut tx, channel_id).await?
        || !can_manage_channel(&mut *tx, &ctx, channel_id).await?
    {
        return Ok(forbidden("Only channel admins can change roles"));
    }

    let email = input.email.trim().to_lowercase();
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
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = target else {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "error": "That person isn't a member of this channel" })));
    };
    let target_user_id: i32 = row.get("user_id");
    let current_role: String = row.get("role");

    if current_role == role {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "role": role })));
    }
    if current_role == "admin"
        && strands_channel(&mut tx, channel_id, target_user_id, false).await?
    {
        return Ok(bad_request(LAST_ADMIN));
    }

    sqlx::query("UPDATE channel_members SET role = $1 WHERE channel_id = $2 AND user_id = $3")
        .bind(role)
        .bind(channel_id)
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "channel_role_changed",
            resource_type: "channel",
            resource_id: Some(channel_id.to_string()),
            metadata: Some(serde_json::json!({
                "channel_id": channel_id,
                "channel": channel_name(pool.get_ref(), channel_id).await,
                "user_id": target_user_id,
                "from": current_role,
                "to": role,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "role": role })))
}

/// Leave a channel. Open to any member, not just admins; the last admin of a
/// channel that still has other members must promote someone first.
#[post("/chat/channels/{channel_id}/leave")]
#[instrument(target = "http", skip(req, pool), fields(channel_id))]
pub async fn leave_channel(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    let mut tx = pool.begin().await?;
    let role: Option<String> = if lock_channel(&mut tx, channel_id).await? {
        sqlx::query_scalar(
            "SELECT role FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        )
        .bind(channel_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?
    } else {
        None
    };
    let Some(role) = role else {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "error": "You're not a member of this channel" })));
    };

    if role == "admin" && strands_channel(&mut tx, channel_id, user_id, true).await? {
        return Ok(bad_request(
            "You're the last admin. Make another member an admin before leaving.",
        ));
    }

    sqlx::query("DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2")
        .bind(channel_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "channel_left",
            resource_type: "channel",
            resource_id: Some(channel_id.to_string()),
            metadata: Some(serde_json::json!({
                "channel_id": channel_id,
                "channel": channel_name(pool.get_ref(), channel_id).await,
                "removed_by": user_id,
                "self_left": true,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().finish())
}
