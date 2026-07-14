//! Admin-read-as-member endpoints under
//! `/api/organizations/{org_id}/members/{user_id}`, for holders of
//! `org_keys:use_master`.
//!
//! Rows are returned exactly as the member's own list endpoints return them:
//! opaque ciphertext for the E2E surfaces (notes, emails, chat, drive), which
//! the caller decrypts in-browser with the recovered member key, and plaintext
//! for the surfaces that are server-readable by design (tasks, meetings).
//!
//! Every call writes a `list_member_*` row to `org_key_audit_log` so a reviewing
//! owner can see who pulled what.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, web};
use sqlx::Row;
use tracing::{instrument, warn};
use wayve_security::encryption::decrypt;
use wayve_security::rbac::{Permission, require_org_access};

use crate::organization::keys::{ensure_target_member, write_impersonation_audit};

/// Undo the at-rest server-AES layer on a chat row, yielding either a
/// `WAYVE_CHAT_E2E_V1` envelope or legacy plaintext. A missing IV or a decrypt
/// failure means the stored value is already plaintext, so return it as-is.
fn decrypt_chat_content(enc: Option<String>, iv: Option<String>) -> Option<String> {
    match (enc, iv) {
        (Some(e), Some(i)) => Some(decrypt(&i, &e).unwrap_or(e)),
        (Some(e), None) => Some(e),
        _ => None,
    }
}

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

    // The target owns an email either through their mailbox account or as the
    // recipient of a Wayve-internal message, so both sources must be unioned.
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

    // Every envelope carries a key slot for the member, so the recovered key
    // decrypts messages they sent as well as ones they received.
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
            let enc = row.try_get::<Option<String>, _>("content_encrypted").ok().flatten();
            let iv = row.try_get::<Option<String>, _>("content_iv").ok().flatten();
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or_default(),
                "sender_id": row.try_get::<Option<i32>, _>("sender_id").ok().flatten(),
                "receiver_id": row.try_get::<Option<i32>, _>("receiver_id").ok().flatten(),
                "content": decrypt_chat_content(enc, iv),
                "status": row.try_get::<Option<String>, _>("status").ok().flatten(),
                "created_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("created_at").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

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

    // Channel members are the envelope recipient set, so the member's key has a
    // slot in every message of every channel they belong to.
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
            let enc = row.try_get::<Option<String>, _>("content_encrypted").ok().flatten();
            let iv = row.try_get::<Option<String>, _>("content_iv").ok().flatten();
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or_default(),
                "channel_id": row.try_get::<Option<i32>, _>("channel_id").ok().flatten(),
                "channel_name": row.try_get::<Option<String>, _>("channel_name").ok().flatten(),
                "sender_id": row.try_get::<Option<i32>, _>("sender_id").ok().flatten(),
                "content": decrypt_chat_content(enc, iv),
                "parent_message_id": row.try_get::<Option<i32>, _>("parent_message_id").ok().flatten(),
                "created_at": row.try_get::<Option<chrono::NaiveDateTime>, _>("created_at").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

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

    // Listing only. Decrypting a file body needs the WV1 binary format in
    // frontend/src/crypto/fileEnvelope.ts plus the recovered member key.
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

/// Tasks are not E2E: `name` and `description` are plaintext by design, so the
/// rows are returned as-is with no client-side decryption.
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

/// Meetings keep both plaintext columns and server-encrypted shadow columns. The
/// plaintext is what the scheduler UI shows, so it is what this returns.
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

// Keeps the `warn` import live; the real audit warnings are emitted by
// write_impersonation_audit over in keys.rs.
#[allow(dead_code)]
fn _ensure_warn_imported() {
    warn!(target: "auth", "");
}
