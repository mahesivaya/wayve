//! HTTP surface for shared inboxes.
//!
//! Admin endpoints (require `inbox:manage` permission + organization access):
//!   GET    /api/shared-inboxes                              — list inboxes in scope
//!   POST   /api/shared-inboxes                              — mark an email_account as shared
//!   PATCH  /api/shared-inboxes/{id}                         — rename / re-scope
//!   DELETE /api/shared-inboxes/{id}                         — un-share
//!   GET    /api/shared-inboxes/{id}/members                 — list members
//!   POST   /api/shared-inboxes/{id}/members                 — add a member
//!   DELETE /api/shared-inboxes/{id}/members/{user_id}       — remove a member
//!
//! Workflow endpoint (require account access — owner or shared member):
//!   PATCH  /api/shared-inboxes/emails/{email_id}/state      — change status / assignee

use crate::email::shared_inbox::{InboxMember, StatusUpdate, can_access_account, upsert_state};
use crate::prelude::*;
use crate::security::jwt::get_user_id_from_request;
use crate::security::rbac::{self, Permission, Scope};
use actix_web::{HttpRequest, HttpResponse, delete, get, patch, post, web};
use chrono::{DateTime, Utc};
use tracing::{info, instrument};

// =============================================================
// Shared DTOs
// =============================================================

#[derive(Debug, Serialize, FromRow)]
pub struct SharedInboxView {
    pub id: i32,
    pub email: String,
    pub provider: String,
    pub shared_label: Option<String>,
    pub organization_id: Option<i32>,
    pub is_shared: bool,
    pub owner_user_id: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ShareInput {
    pub account_id: i32,
    pub label: Option<String>,
    /// Org scope. Required for organization admins (they must scope to
    /// their own org); platform admins may set NULL to publish a
    /// platform-level inbox.
    pub organization_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateInput {
    pub label: Option<String>,
    pub is_shared: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct MemberInput {
    pub user_id: i32,
    #[serde(default = "default_can_reply")]
    pub can_reply: bool,
    #[serde(default)]
    pub can_manage: bool,
}

fn default_can_reply() -> bool {
    true
}

// =============================================================
// Admin helpers
// =============================================================

/// Enforce: caller has `inbox:manage` AND can act on `organization_id`.
/// Platform staff may operate on any org or on NULL (platform-level).
/// Organization staff may operate only on their own org.
async fn require_scope_for_org(
    req: &HttpRequest,
    pool: &PgPool,
    organization_id: Option<i32>,
) -> Result<rbac::RoleContext, HttpResponse> {
    let ctx = rbac::require_permission(req, pool, Permission::InboxManage).await?;
    let allowed = match ctx.scope {
        Scope::Platform => true, // any org or platform-level
        Scope::Organization => organization_id.is_some() && organization_id == ctx.organization_id,
        Scope::Personal => false,
    };
    if !allowed {
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "You do not have access to manage this scope's inboxes"
        })));
    }
    Ok(ctx)
}

async fn load_account(pool: &PgPool, account_id: i32) -> sqlx::Result<Option<SharedInboxView>> {
    sqlx::query_as::<_, SharedInboxView>(
        r#"SELECT id, email, provider, shared_label, organization_id, is_shared,
                  user_id AS owner_user_id, created_at
             FROM email_accounts
            WHERE id = $1"#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

// =============================================================
// GET /api/shared-inboxes
// =============================================================

#[get("/shared-inboxes")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn list_shared_inboxes(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::InboxManage).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let rows = match ctx.scope {
        Scope::Platform => {
            sqlx::query_as::<_, SharedInboxView>(
                r#"SELECT id, email, provider, shared_label, organization_id, is_shared,
                          user_id AS owner_user_id, created_at
                     FROM email_accounts
                    WHERE is_shared = TRUE
                    ORDER BY created_at DESC"#,
            )
            .fetch_all(pool.get_ref())
            .await?
        }
        Scope::Organization => {
            sqlx::query_as::<_, SharedInboxView>(
                r#"SELECT id, email, provider, shared_label, organization_id, is_shared,
                          user_id AS owner_user_id, created_at
                     FROM email_accounts
                    WHERE is_shared = TRUE AND organization_id = $1
                    ORDER BY created_at DESC"#,
            )
            .bind(ctx.organization_id)
            .fetch_all(pool.get_ref())
            .await?
        }
        Scope::Personal => Vec::new(),
    };
    Ok(HttpResponse::Ok().json(rows))
}

// =============================================================
// POST /api/shared-inboxes — mark an account as shared
// =============================================================

#[post("/shared-inboxes")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn create_shared_inbox(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ShareInput>,
) -> AppResult {
    if let Err(resp) = require_scope_for_org(&req, pool.get_ref(), body.organization_id).await {
        return Ok(resp);
    }
    let acc = match load_account(pool.get_ref(), body.account_id).await? {
        Some(acc) => acc,
        None => {
            return Ok(HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "Email account not found" })));
        }
    };
    if acc.is_shared {
        return Ok(HttpResponse::Conflict().json(serde_json::json!({
            "message": "Account is already shared. Use PATCH to rename."
        })));
    }

    let updated = sqlx::query_as::<_, SharedInboxView>(
        r#"UPDATE email_accounts
              SET is_shared = TRUE,
                  shared_label = $1,
                  organization_id = $2
            WHERE id = $3
        RETURNING id, email, provider, shared_label, organization_id, is_shared,
                  user_id AS owner_user_id, created_at"#,
    )
    .bind(body.label.as_deref().map(str::trim))
    .bind(body.organization_id)
    .bind(body.account_id)
    .fetch_one(pool.get_ref())
    .await?;

    info!(
        target: "http",
        account_id = updated.id,
        organization_id = ?updated.organization_id,
        "marked account as shared"
    );
    Ok(HttpResponse::Ok().json(updated))
}

// =============================================================
// PATCH /api/shared-inboxes/{id} — rename / toggle enable
// =============================================================

#[patch("/shared-inboxes/{id}")]
#[instrument(target = "auth", skip(req, pool, path, body))]
pub async fn update_shared_inbox(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<UpdateInput>,
) -> AppResult {
    let account_id = path.into_inner();
    let acc = match load_account(pool.get_ref(), account_id).await? {
        Some(acc) => acc,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "Inbox not found" }))
            );
        }
    };
    if let Err(resp) = require_scope_for_org(&req, pool.get_ref(), acc.organization_id).await {
        return Ok(resp);
    }

    let updated = sqlx::query_as::<_, SharedInboxView>(
        r#"UPDATE email_accounts
              SET shared_label = COALESCE($1, shared_label),
                  is_shared    = COALESCE($2, is_shared)
            WHERE id = $3
        RETURNING id, email, provider, shared_label, organization_id, is_shared,
                  user_id AS owner_user_id, created_at"#,
    )
    .bind(body.label.as_deref().map(str::trim))
    .bind(body.is_shared)
    .bind(account_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(updated))
}

// =============================================================
// DELETE /api/shared-inboxes/{id} — un-share (members removed via cascade)
// =============================================================

#[delete("/shared-inboxes/{id}")]
#[instrument(target = "auth", skip(req, pool, path))]
pub async fn delete_shared_inbox(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let account_id = path.into_inner();
    let acc = match load_account(pool.get_ref(), account_id).await? {
        Some(acc) => acc,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "Inbox not found" }))
            );
        }
    };
    if let Err(resp) = require_scope_for_org(&req, pool.get_ref(), acc.organization_id).await {
        return Ok(resp);
    }

    sqlx::query(
        "UPDATE email_accounts
            SET is_shared = FALSE, organization_id = NULL, shared_label = NULL
          WHERE id = $1",
    )
    .bind(account_id)
    .execute(pool.get_ref())
    .await?;

    sqlx::query("DELETE FROM shared_inbox_members WHERE account_id = $1")
        .bind(account_id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::NoContent().finish())
}

// =============================================================
// Members
// =============================================================

#[get("/shared-inboxes/{id}/members")]
#[instrument(target = "auth", skip(req, pool, path))]
pub async fn list_inbox_members(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let account_id = path.into_inner();
    let acc = match load_account(pool.get_ref(), account_id).await? {
        Some(acc) => acc,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "Inbox not found" }))
            );
        }
    };
    if let Err(resp) = require_scope_for_org(&req, pool.get_ref(), acc.organization_id).await {
        return Ok(resp);
    }
    let members = sqlx::query_as::<_, InboxMember>(
        r#"SELECT m.account_id, m.user_id, u.email, u.first_name, m.can_reply, m.can_manage, m.created_at
             FROM shared_inbox_members m
             JOIN users u ON u.id = m.user_id
            WHERE m.account_id = $1
            ORDER BY u.email"#,
    )
    .bind(account_id)
    .fetch_all(pool.get_ref())
    .await?;
    Ok(HttpResponse::Ok().json(members))
}

#[post("/shared-inboxes/{id}/members")]
#[instrument(target = "auth", skip(req, pool, path, body))]
pub async fn add_inbox_member(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<MemberInput>,
) -> AppResult {
    let account_id = path.into_inner();
    let acc = match load_account(pool.get_ref(), account_id).await? {
        Some(acc) => acc,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "Inbox not found" }))
            );
        }
    };
    let ctx = match require_scope_for_org(&req, pool.get_ref(), acc.organization_id).await {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };

    // Verify the target user exists and (for org-scoped inboxes) belongs
    // to the same org. Platform-level inboxes have no org-membership
    // requirement — platform staff are eligible by default.
    let row: Option<(Option<i32>,)> =
        sqlx::query_as("SELECT organization_id FROM users WHERE id = $1")
            .bind(body.user_id)
            .fetch_optional(pool.get_ref())
            .await?;
    let target_org = match row {
        Some(tuple) => tuple.0,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "User not found" }))
            );
        }
    };
    if let Some(inbox_org) = acc.organization_id
        && target_org != Some(inbox_org)
    {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Target user is not a member of this organization"
        })));
    }

    sqlx::query(
        r#"INSERT INTO shared_inbox_members (account_id, user_id, can_reply, can_manage, added_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (account_id, user_id) DO UPDATE
             SET can_reply = EXCLUDED.can_reply,
                 can_manage = EXCLUDED.can_manage"#,
    )
    .bind(account_id)
    .bind(body.user_id)
    .bind(body.can_reply)
    .bind(body.can_manage)
    .bind(ctx.user_id)
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().finish())
}

#[delete("/shared-inboxes/{id}/members/{user_id}")]
#[instrument(target = "auth", skip(req, pool, path))]
pub async fn remove_inbox_member(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
) -> AppResult {
    let (account_id, user_id) = path.into_inner();
    let acc = match load_account(pool.get_ref(), account_id).await? {
        Some(acc) => acc,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "Inbox not found" }))
            );
        }
    };
    if let Err(resp) = require_scope_for_org(&req, pool.get_ref(), acc.organization_id).await {
        return Ok(resp);
    }
    sqlx::query("DELETE FROM shared_inbox_members WHERE account_id = $1 AND user_id = $2")
        .bind(account_id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;
    Ok(HttpResponse::NoContent().finish())
}

// =============================================================
// Workflow: status / assignee update on a single email
// =============================================================

#[patch("/shared-inboxes/emails/{email_id}/state")]
#[instrument(target = "auth", skip(req, pool, path, body))]
pub async fn update_email_state(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<StatusUpdate>,
) -> AppResult {
    let email_id = path.into_inner();
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    // Look up the account this email belongs to + verify the caller has
    // *any* access (owner or member). Anyone who can read can also patch
    // workflow state; that's how every help-desk tool I've seen works.
    let row: Option<(i32,)> = sqlx::query_as("SELECT account_id FROM emails WHERE id = $1")
        .bind(email_id)
        .fetch_optional(pool.get_ref())
        .await?;
    let account_id = match row {
        Some(tuple) => tuple.0,
        None => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "Email not found" }))
            );
        }
    };
    if !can_access_account(pool.get_ref(), user_id, account_id).await? {
        return Ok(HttpResponse::Forbidden()
            .json(serde_json::json!({ "message": "No access to this inbox" })));
    }

    match upsert_state(pool.get_ref(), email_id, user_id, &body).await {
        Ok(state) => Ok(HttpResponse::Ok().json(state)),
        Err(msg) => Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": msg
        }))),
    }
}
