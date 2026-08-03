use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac;

use sqlx::Row;
use tracing::instrument;

#[get("/chat/channels")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_channels(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // A channel is visible only when its creator shares the caller's scope, so
    // cross-tenant channels never appear. Personal accounts share no tenant with
    // each other, so for them visibility narrows to channels they actually
    // belong to — see `directory_scope::VISIBLE_CHANNELS`.
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id).await?;

    // Built by concatenation rather than `format!` because the SQL contains
    // `'{}'` empty-array literals, which `format!` would read as placeholders.
    let sql = r#"
        SELECT
            c.id,
            c.name,
            c.visibility,
            c.created_by,
            c.created_at,
            (SELECT MAX(cm_last.created_at) FROM channel_messages cm_last
                WHERE cm_last.channel_id = c.id) AS last_message_at,
            mine.role AS current_user_role,
            mine.user_id IS NOT NULL AS is_member,
            jr.status AS join_status,
            COALESCE((
                SELECT array_agg(cm_all.user_id ORDER BY u_all.email)
                FROM channel_members cm_all
                JOIN users u_all ON u_all.id = cm_all.user_id
                WHERE cm_all.channel_id = c.id
            ), '{}') AS member_ids,
            COALESCE((
                SELECT array_agg(u_all.email ORDER BY u_all.email)
                FROM channel_members cm_all
                JOIN users u_all ON u_all.id = cm_all.user_id
                WHERE cm_all.channel_id = c.id
            ), '{}') AS member_emails,
            COALESCE((
                SELECT array_agg(u_all.email ORDER BY u_all.email)
                FROM channel_members cm_all
                JOIN users u_all ON u_all.id = cm_all.user_id
                WHERE cm_all.channel_id = c.id AND cm_all.role = 'admin'
            ), '{}') AS admin_emails,
            COALESCE((
                SELECT array_agg(u_all.email ORDER BY u_all.email)
                FROM channel_members cm_all
                JOIN users u_all ON u_all.id = cm_all.user_id
                WHERE cm_all.channel_id = c.id AND cm_all.role <> 'admin'
            ), '{}') AS user_emails,
            COALESCE((
                SELECT array_agg(ci.email ORDER BY ci.email)
                FROM channel_invites ci
                WHERE ci.channel_id = c.id
            ), '{}') AS invite_emails,
            COALESCE((
                SELECT array_agg(ci.email ORDER BY ci.email)
                FROM channel_invites ci
                WHERE ci.channel_id = c.id AND ci.role = 'admin'
            ), '{}') AS admin_invite_emails,
            COALESCE((
                SELECT array_agg(ci.email ORDER BY ci.email)
                FROM channel_invites ci
                WHERE ci.channel_id = c.id AND ci.role <> 'admin'
            ), '{}') AS user_invite_emails,
            COALESCE((
                SELECT array_agg(json_build_object('user_id', u_req.id, 'email', u_req.email) ORDER BY u_req.email)
                FROM channel_join_requests cjr
                JOIN users u_req ON u_req.id = cjr.user_id
                WHERE cjr.channel_id = c.id AND cjr.status = 'pending'
            ), '{}') AS pending_join_requests
        FROM channels c
        JOIN users creator ON creator.id = c.created_by
        LEFT JOIN channel_members mine
            ON mine.channel_id = c.id AND mine.user_id = $1
        LEFT JOIN channel_join_requests jr
            ON jr.channel_id = c.id AND jr.user_id = $1 AND jr.status = 'pending'
        WHERE "#
        .to_string()
        + crate::directory_scope::VISIBLE_CHANNELS
        + r#"
        ORDER BY c.created_at DESC
        "#;

    let rows = sqlx::query(&sql)
        .bind(user_id)
        .bind(ctx.scope.as_str())
        .bind(ctx.organization_id)
        .fetch_all(pool.get_ref())
        .await?;

    let channels: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let created_naive: chrono::NaiveDateTime = row.get("created_at");
            let created_at = chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                created_naive,
                chrono::Utc,
            );

            // Null for a channel that has no messages yet.
            let last_message_at = row
                .get::<Option<chrono::NaiveDateTime>, _>("last_message_at")
                .map(|t| {
                    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(t, chrono::Utc)
                        .to_rfc3339()
                });

            serde_json::json!({
                "id": row.get::<i32, _>("id"),
                "name": row.get::<String, _>("name"),
                "visibility": row.get::<String, _>("visibility"),
                "created_by": row.get::<i32, _>("created_by"),
                "created_at": created_at.to_rfc3339(),
                "last_message_at": last_message_at,
                "current_user_role": row.get::<Option<String>, _>("current_user_role"),
                "is_member": row.get::<bool, _>("is_member"),
                "join_status": row.get::<Option<String>, _>("join_status"),
                "member_ids": row.get::<Vec<i32>, _>("member_ids"),
                "member_emails": row.get::<Vec<String>, _>("member_emails"),
                "admin_emails": row.get::<Vec<String>, _>("admin_emails"),
                "user_emails": row.get::<Vec<String>, _>("user_emails"),
                "invite_emails": row.get::<Vec<String>, _>("invite_emails"),
                "admin_invite_emails": row.get::<Vec<String>, _>("admin_invite_emails"),
                "user_invite_emails": row.get::<Vec<String>, _>("user_invite_emails"),
                "pending_join_requests": row.get::<Vec<serde_json::Value>, _>("pending_join_requests"),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(channels))
}
