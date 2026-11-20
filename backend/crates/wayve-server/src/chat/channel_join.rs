use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::JoinRequestActionInput;
use super::helpers::{can_manage_channel, channel_full, lock_channel, would_exceed_member_cap};
use wayve_security::rbac::resolve_role_context_moded;

use sqlx::Row;
use tracing::instrument;

/// SQL: whether the caller (`$2`) may reach the `channels` row at all. Inside
/// an organization or the platform that is sharing its tenant. Personal
/// accounts share no tenant, so being one is not enough: the channel's creator
/// must have made it public, or have invited the caller's email address.
const MAY_REACH: &str = r#"
            COALESCE((
                SELECT (creator.account_type = 'platform_admin'
                            AND me.account_type = 'platform_admin')
                    OR (creator.account_type IN ('organization', 'organization_admin')
                            AND me.account_type IN ('organization', 'organization_admin')
                            AND creator.organization_id = me.organization_id)
                    OR (creator.account_type = 'personal'
                            AND me.account_type = 'personal'
                            AND (channels.visibility = 'public'
                                 OR EXISTS (
                                     SELECT 1 FROM channel_invites ci
                                     WHERE ci.channel_id = channels.id
                                       AND lower(ci.email) = lower(me.email))))
                FROM users creator, users me
                WHERE creator.id = channels.created_by AND me.id = $2
            ), FALSE)"#;

#[post("/chat/channels/{channel_id}/join")]
#[instrument(target = "http", skip(req, pool), fields(channel_id))]
pub async fn join_channel(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    let sql = r#"
        SELECT
            visibility,
            name,
            EXISTS(
                SELECT 1 FROM channel_members
                WHERE channel_id = channels.id AND user_id = $2
            ) AS is_member,

        "#
    .to_string()
        + MAY_REACH
        + r#" AS may_reach
        FROM channels
        WHERE id = $1
        "#;
    let row = sqlx::query(&sql)
        .bind(channel_id)
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or(AppError::NotFound("channel"))?;

    if row.get::<bool, _>("is_member") {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "status": "joined" })));
    }

    // A channel can be joined, or asked to be joined, only by someone it is
    // open to (see `may_reach` above). Organization channels are always public,
    // so without this anyone who guessed a channel's number could add
    // themselves and read its whole history; and a personal account's private
    // channel would take a join request from any stranger, confirming it
    // exists. Answered as "not found" so the number reveals nothing.
    if !row.get::<bool, _>("may_reach") {
        return Err(AppError::NotFound("channel"));
    }

    if row.get::<String, _>("visibility") == "public" {
        let mut tx = pool.begin().await?;
        lock_channel(&mut tx, channel_id).await?;
        if would_exceed_member_cap(&mut tx, channel_id, &[user_id]).await? {
            return Ok(channel_full());
        }
        sqlx::query(
            r#"
            INSERT INTO channel_members (channel_id, user_id, role)
            VALUES ($1, $2, 'user')
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(channel_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        let channel_name: String = row.get("name");
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "channel_joined",
                resource_type: "channel",
                resource_id: Some(channel_id.to_string()),
                metadata: Some(serde_json::json!({
                    "channel_id": channel_id,
                    "channel": channel_name,
                })),
            },
        )
        .await;
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

/// What a channel link shows someone before they join: enough to recognise the
/// channel and to join it or ask to. Open to exactly the people `join_channel`
/// would accept, and "not found" to everyone else, so a link (or a guessed
/// number) tells a stranger nothing. Members' addresses are left out; a
/// non-member gets the count.
#[get("/chat/channels/{channel_id}/preview")]
#[instrument(target = "http", skip(req, pool), fields(channel_id))]
pub async fn get_channel_preview(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    let sql = r#"
        SELECT
            id,
            name,
            visibility,
            created_by,
            created_at,
            (SELECT COUNT(*) FROM channel_members WHERE channel_id = channels.id) AS member_count,
            EXISTS(
                SELECT 1 FROM channel_members
                WHERE channel_id = channels.id AND user_id = $2
            ) AS is_member,
            EXISTS(
                SELECT 1 FROM channel_join_requests
                WHERE channel_id = channels.id AND user_id = $2 AND status = 'pending'
            ) AS pending,
        "#
    .to_string()
        + MAY_REACH
        + r#" AS may_reach
        FROM channels
        WHERE id = $1
        "#;
    let row = sqlx::query(&sql)
        .bind(channel_id)
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?
        .ok_or(AppError::NotFound("channel"))?;

    let is_member: bool = row.get("is_member");
    if !is_member && !row.get::<bool, _>("may_reach") {
        return Err(AppError::NotFound("channel"));
    }

    let created_at = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
        row.get::<chrono::NaiveDateTime, _>("created_at"),
        chrono::Utc,
    );
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "visibility": row.get::<String, _>("visibility"),
        "created_by": row.get::<Option<i32>, _>("created_by"),
        "created_at": created_at.to_rfc3339(),
        "is_member": is_member,
        "join_status": row.get::<bool, _>("pending").then_some("pending"),
        "member_count": row.get::<i64, _>("member_count"),
        "member_ids": Vec::<i32>::new(),
        "member_emails": Vec::<String>::new(),
    })))
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

    let ctx = resolve_role_context_moded(&req, pool.get_ref(), admin_id).await?;
    if !can_manage_channel(pool.get_ref(), &ctx, channel_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can approve requests"
        })));
    }

    let mut tx = pool.begin().await?;

    // A full channel keeps the request pending, so it can be approved once a
    // seat frees up.
    lock_channel(&mut tx, channel_id).await?;
    if would_exceed_member_cap(&mut tx, channel_id, &[input.user_id]).await? {
        return Ok(channel_full());
    }

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

    // Recorded via record_action_system, without the request IP, because the
    // request actor is the approving admin rather than the joining user.
    let channel_name: Option<String> =
        sqlx::query_scalar("SELECT name FROM channels WHERE id = $1")
            .bind(channel_id)
            .fetch_optional(pool.get_ref())
            .await
            .ok()
            .flatten();
    crate::audit::record_action_system(
        pool.get_ref(),
        crate::audit::AuditEvent {
            actor_user_id: input.user_id,
            action: "channel_joined",
            resource_type: "channel",
            resource_id: Some(channel_id.to_string()),
            metadata: Some(serde_json::json!({
                "channel_id": channel_id,
                "channel": channel_name,
                "approved_by": admin_id,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().finish())
}
