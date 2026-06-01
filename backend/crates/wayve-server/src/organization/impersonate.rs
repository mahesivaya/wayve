//! Admin-read-as-member endpoints.
//!
//! Owners / admins (any holder of `org_keys:use_master`) use these to
//! list a target member's content for the impersonation view. The
//! returned rows are exactly what the member's own list endpoints
//! return — opaque ciphertext for the E2E surfaces (notes / emails /
//! chat / drive), plaintext for the non-E2E surfaces (tasks /
//! meetings, which are server-readable by design per the original
//! Plan A scope).
//!
//! Every call writes a `list_member_*` row to `org_key_audit_log` so
//! a reviewing owner can see who pulled what.
//!
//! Routes (all under `/api/organizations/{org_id}/members/{user_id}`):
//!
//!   GET /emails    — emails owned by the member (via email_accounts.user_id
//!                    OR the Phase-2 recipient_user_id channel). E2E rows
//!                    carry WAYVE_SECURE_V1 envelopes the caller decrypts
//!                    in-browser using the recovered member key.
//!   GET /messages  — direct messages where the member was sender OR
//!                    receiver. Each row carries a WAYVE_CHAT_E2E_V1
//!                    envelope with a wrapped key slot for the member.
//!   GET /channel-messages — channel_messages from channels the member
//!                    is a member of. Same envelope shape as direct.
//!   GET /files     — drive_files owned by the member. Each carries a
//!                    file_path on disk; downloading + decrypting the
//!                    blob itself is a follow-up (the listing already
//!                    proves the impersonation worked).
//!   GET /tasks     — plaintext task rows owned by the member.
//!   GET /meetings  — plaintext meeting rows owned by the member.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, web};
use sqlx::Row;
use tracing::{instrument, warn};
use wayve_security::rbac::{Permission, require_org_access};

use crate::organization::keys::{ensure_target_member, write_impersonation_audit};

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/members/{user_id}/emails
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/members/{user_id}/emails")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_member_emails(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (organization_id, target_user_id) = path.into_inner();
    let ctx = match require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysUseMaster,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    ensure_target_member(pool.get_ref(), organization_id, target_user_id).await?;

    // Emails owned by the target. Two sources:
    //   (a) Mailbox emails via the standard email_accounts join.
    //   (b) Wayve-internal emails (Phase 2 multi-recipient channel)
    //       addressed to the target via emails.recipient_user_id.
    let rows = sqlx::query(
        "SELECT e.id, e.subject, e.sender, e.receiver, e.body_encrypted, e.body_iv,
                e.created_at, COALESCE(e.source, 'imap') AS source
         FROM emails e
         LEFT JOIN email_accounts a ON a.id = e.account_id
         WHERE a.user_id = $1 OR e.recipient_user_id = $1
         ORDER BY e.created_at DESC
         LIMIT 200",
    )
    .bind(target_user_id)
    .fetch_all(pool.get_ref())
    .await?;

    write_impersonation_audit(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "list_member_emails",
        target_user_id,
        &req,
    )
    .await;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or_default(),
                "subject": row.try_get::<Option<String>, _>("subject").ok().flatten(),
                "sender": row.try_get::<Option<String>, _>("sender").ok().flatten(),
                "receiver": row.try_get::<Option<String>, _>("receiver").ok().flatten(),
                "body_encrypted": row.try_get::<Option<String>, _>("body_encrypted").ok().flatten(),
                "body_iv": row.try_get::<Option<String>, _>("body_iv").ok().flatten(),
                "source": row.try_get::<String, _>("source").unwrap_or_else(|_| "imap".into()),
                "created_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("created_at").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/members/{user_id}/messages
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/members/{user_id}/messages")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_member_messages(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (organization_id, target_user_id) = path.into_inner();
    let ctx = match require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysUseMaster,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    ensure_target_member(pool.get_ref(), organization_id, target_user_id).await?;

    // Direct messages where the target was sender OR receiver. Multi-
    // recipient envelopes have a key slot for the member, so the
    // recovered key decrypts both directions.
    let rows = sqlx::query(
        "SELECT id, sender_id, receiver_id, content_encrypted, content_iv,
                status::text AS status, created_at
         FROM messages
         WHERE sender_id = $1 OR receiver_id = $1
         ORDER BY created_at DESC
         LIMIT 200",
    )
    .bind(target_user_id)
    .fetch_all(pool.get_ref())
    .await?;

    write_impersonation_audit(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "list_member_messages",
        target_user_id,
        &req,
    )
    .await;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or_default(),
                "sender_id": row.try_get::<Option<i32>, _>("sender_id").ok().flatten(),
                "receiver_id": row.try_get::<Option<i32>, _>("receiver_id").ok().flatten(),
                "content_encrypted": row.try_get::<Option<String>, _>("content_encrypted").ok().flatten(),
                "content_iv": row.try_get::<Option<String>, _>("content_iv").ok().flatten(),
                "status": row.try_get::<Option<String>, _>("status").ok().flatten(),
                "created_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("created_at").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/members/{user_id}/channel-messages
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/members/{user_id}/channel-messages")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_member_channel_messages(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (organization_id, target_user_id) = path.into_inner();
    let ctx = match require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysUseMaster,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    ensure_target_member(pool.get_ref(), organization_id, target_user_id).await?;

    // Channel messages from channels the target is a member of. The
    // member's key has a slot in every WAYVE_CHAT_E2E_V1 envelope in
    // those channels (channel members are the recipient set).
    let rows = sqlx::query(
        "SELECT cm.id, cm.channel_id, cm.sender_id, cm.content_encrypted, cm.content_iv,
                cm.parent_message_id, cm.created_at,
                c.name AS channel_name
         FROM channel_messages cm
         JOIN channels c ON c.id = cm.channel_id
         JOIN channel_members mb ON mb.channel_id = cm.channel_id
         WHERE mb.user_id = $1
         ORDER BY cm.created_at DESC
         LIMIT 200",
    )
    .bind(target_user_id)
    .fetch_all(pool.get_ref())
    .await?;

    write_impersonation_audit(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "list_member_channel_messages",
        target_user_id,
        &req,
    )
    .await;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or_default(),
                "channel_id": row.try_get::<Option<i32>, _>("channel_id").ok().flatten(),
                "channel_name": row.try_get::<Option<String>, _>("channel_name").ok().flatten(),
                "sender_id": row.try_get::<Option<i32>, _>("sender_id").ok().flatten(),
                "content_encrypted": row.try_get::<Option<String>, _>("content_encrypted").ok().flatten(),
                "content_iv": row.try_get::<Option<String>, _>("content_iv").ok().flatten(),
                "parent_message_id": row.try_get::<Option<i32>, _>("parent_message_id").ok().flatten(),
                "created_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("created_at").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/members/{user_id}/files
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/members/{user_id}/files")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_member_files(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (organization_id, target_user_id) = path.into_inner();
    let ctx = match require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysUseMaster,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    ensure_target_member(pool.get_ref(), organization_id, target_user_id).await?;

    // Drive file listing — owner sees the member's files. Decryption
    // of the actual file body uses the existing WV1 binary format
    // (frontend/src/crypto/fileEnvelope.ts) with the recovered member
    // key; downloading the body is a follow-up (the listing already
    // proves the impersonation crypto works).
    let rows = sqlx::query(
        "SELECT id, name, file_type, file_path, size, created_at, updated_at
         FROM drive_files
         WHERE user_id = $1 AND COALESCE(is_deleted, FALSE) = FALSE
         ORDER BY updated_at DESC
         LIMIT 200",
    )
    .bind(target_user_id)
    .fetch_all(pool.get_ref())
    .await?;

    write_impersonation_audit(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "list_member_files",
        target_user_id,
        &req,
    )
    .await;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i64, _>("id").unwrap_or_default(),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "file_type": row.try_get::<Option<String>, _>("file_type").ok().flatten(),
                "file_path": row.try_get::<String, _>("file_path").unwrap_or_default(),
                "size": row.try_get::<Option<i64>, _>("size").ok().flatten().unwrap_or(0),
                "created_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("created_at").ok().flatten(),
                "updated_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("updated_at").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/members/{user_id}/tasks
// ---------------------------------------------------------------------------
//
//   Tasks are NOT E2E — `name` and `description` are plaintext per the
//   original Plan A scope decision. The impersonation view shows the
//   plaintext rows; no client-side decryption needed.

#[get("/organizations/{org_id}/members/{user_id}/tasks")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_member_tasks(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (organization_id, target_user_id) = path.into_inner();
    let ctx = match require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysUseMaster,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    ensure_target_member(pool.get_ref(), organization_id, target_user_id).await?;

    let rows = sqlx::query(
        "SELECT id, name, description, priority, status, created_at, updated_at
         FROM tasks
         WHERE user_id = $1
         ORDER BY priority DESC, created_at DESC
         LIMIT 200",
    )
    .bind(target_user_id)
    .fetch_all(pool.get_ref())
    .await?;

    write_impersonation_audit(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "list_member_tasks",
        target_user_id,
        &req,
    )
    .await;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or_default(),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "description": row.try_get::<String, _>("description").unwrap_or_default(),
                "priority": row.try_get::<i16, _>("priority").unwrap_or(3),
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
                "created_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("created_at").ok().flatten(),
                "updated_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("updated_at").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/members/{user_id}/meetings
// ---------------------------------------------------------------------------
//
//   Meetings keep both plaintext (`title`, `zoom_join_url`) AND the
//   server-AES-GCM-encrypted shadow columns from the existing scheduler
//   storage layer. Plaintext is what the user sees in the scheduler UI,
//   so it's what we return here — no E2E decryption involved.

#[get("/organizations/{org_id}/members/{user_id}/meetings")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_member_meetings(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (organization_id, target_user_id) = path.into_inner();
    let ctx = match require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysUseMaster,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };
    ensure_target_member(pool.get_ref(), organization_id, target_user_id).await?;

    let rows = sqlx::query(
        "SELECT id, title, date, start_time, end_time, zoom_join_url
         FROM meetings
         WHERE user_id = $1
         ORDER BY date DESC, start_time DESC
         LIMIT 200",
    )
    .bind(target_user_id)
    .fetch_all(pool.get_ref())
    .await?;

    write_impersonation_audit(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "list_member_meetings",
        target_user_id,
        &req,
    )
    .await;

    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or_default(),
                "title": row.try_get::<String, _>("title").unwrap_or_default(),
                "date": row.try_get::<Option<chrono::NaiveDate>, _>("date").ok().flatten(),
                "start_time": row.try_get::<Option<chrono::NaiveTime>, _>("start_time").ok().flatten().map(|t| t.to_string()),
                "end_time": row.try_get::<Option<chrono::NaiveTime>, _>("end_time").ok().flatten().map(|t| t.to_string()),
                "zoom_join_url": row.try_get::<Option<String>, _>("zoom_join_url").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

// Suppress unused-warning on warn import — it's used inside the
// write_impersonation_audit helper that lives in keys.rs but the import
// in the use-block above is for completeness.
#[allow(dead_code)]
fn _ensure_warn_imported() {
    warn!(target: "auth", "");
}
