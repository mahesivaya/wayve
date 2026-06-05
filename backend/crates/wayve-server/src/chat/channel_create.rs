use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::CreateChannelInput;
use super::helpers::{normalize_channel_role, normalize_invite_emails};

use sqlx::Row;
use tracing::{error, instrument};

#[post("/chat/channels")]
#[instrument(target = "http", skip(req, pool, input))]
pub async fn create_channel(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    input: web::Json<CreateChannelInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Channel name is required"
        })));
    }

    let invite_role = normalize_channel_role(input.invite_role.as_deref());
    let invite_emails = normalize_invite_emails(&input.invite_emails.clone().unwrap_or_default());

    let invited_users = if invite_emails.is_empty() {
        Vec::new()
    } else {
        sqlx::query("SELECT id, email FROM users WHERE LOWER(email) = ANY($1)")
            .bind(&invite_emails)
            .fetch_all(pool.get_ref())
            .await?
            .into_iter()
            .map(|row| (row.get::<i32, _>("id"), row.get::<String, _>("email")))
            .collect::<Vec<_>>()
    };

    let mut member_ids = input.member_ids.clone().unwrap_or_default();
    member_ids.extend(invited_users.iter().map(|(id, _email)| *id));
    member_ids.push(user_id);
    member_ids.sort_unstable();
    member_ids.dedup();

    // A solo channel (just the creator) is allowed: the creator is added as
    // admin below and every other code path works with a single member.

    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        r#"
        INSERT INTO channels (name, created_by)
        VALUES ($1, $2)
        RETURNING id, created_at
        "#,
    )
    .bind(name)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;

    let channel_id: i32 = row.get("id");
    for member_id in &member_ids {
        let role = if *member_id == user_id {
            "admin"
        } else {
            invite_role
        };

        // A failed member insert is reported as a 400, not a 500 — the most
        // likely cause is a bad member id in the request body.
        if let Err(e) = sqlx::query(
            r#"
            INSERT INTO channel_members (channel_id, user_id, role)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(channel_id)
        .bind(member_id)
        .bind(role)
        .execute(&mut *tx)
        .await
        {
            error!(target: "db", error = ?e, channel_id, member_id, "create_channel member insert failed");
            return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                "error": "One or more members could not be added"
            })));
        }
    }

    let registered_invite_emails: Vec<String> = invited_users
        .iter()
        .map(|(_id, email)| email.to_lowercase())
        .collect();
    for email in invite_emails
        .iter()
        .filter(|email| !registered_invite_emails.contains(email))
    {
        sqlx::query(
            r#"
            INSERT INTO channel_invites (channel_id, email, role, invited_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
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

    let created_naive: chrono::NaiveDateTime = row.get("created_at");
    let created_at =
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(created_naive, chrono::Utc);

    // Webhook fan-out — strictly after commit. emit() opens its own
    // transaction; firing before commit would risk webhook_deliveries
    // referencing a channel that doesn't exist if the surrounding
    // transaction later rolls back.
    let owner = crate::webhooks::handler::owner_for_user(pool.get_ref(), user_id).await;
    crate::webhooks::emit(
        pool.get_ref(),
        owner,
        crate::webhooks::Event::ChatChannelCreated,
        serde_json::json!({
            "id": channel_id,
            "name": name,
            "created_by": user_id,
            "created_at": created_at,
            "member_ids": member_ids,
        }),
    )
    .await;
    // A failed member-email read is non-fatal: the channel already exists, so
    // we log and fall back to empty lists rather than failing the request.
    let member_rows = match sqlx::query(
        r#"
        SELECT u.email, cm.role
        FROM channel_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = $1
        ORDER BY u.email
        "#,
    )
    .bind(channel_id)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!(target: "db", error = ?e, channel_id, "create_channel member email lookup failed");
            Vec::new()
        }
    };
    let mut member_emails = Vec::new();
    let mut admin_emails = Vec::new();
    let mut user_emails = Vec::new();
    for row in member_rows {
        let email: String = row.get("email");
        let role: String = row.get("role");
        member_emails.push(email.clone());
        if role == "admin" {
            admin_emails.push(email);
        } else {
            user_emails.push(email);
        }
    }

    let admin_invite_emails: Vec<String> = if invite_role == "admin" {
        invite_emails.clone()
    } else {
        Vec::new()
    };
    let user_invite_emails: Vec<String> = if invite_role == "user" {
        invite_emails.clone()
    } else {
        Vec::new()
    };

    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": channel_id,
        "name": name,
        "visibility": "private",
        "created_by": user_id,
        "created_at": created_at.to_rfc3339(),
        "current_user_role": "admin",
        "is_member": true,
        "join_status": null,
        "member_ids": member_ids,
        "member_emails": member_emails,
        "admin_emails": admin_emails,
        "user_emails": user_emails,
        "invite_emails": invite_emails,
        "invite_role": invite_role,
        "admin_invite_emails": admin_invite_emails,
        "user_invite_emails": user_invite_emails,
        "pending_join_requests": [],
    })))
}
