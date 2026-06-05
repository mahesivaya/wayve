//! Organization Master Key handlers.
//!
//! Six endpoints, all under `/api/organizations/{org_id}`:
//!
//! - `POST /keys` — bootstrap the org keypair (owner only). Inserts one
//!   `organization_keys` row + a `mnemonic`-wrapped row in
//!   `organization_wrapped_keys` + a `user_pubkey`-wrapped row for the
//!   founder. All in a single transaction so the org can never be in a
//!   "pubkey without wraps" state.
//! - `GET /keys` — return the org pubkey to any member, plus the
//!   caller's own wrap envelopes if they're a key-holder (admin/owner).
//!   The mnemonic envelope is only returned to owners on explicit
//!   `?include_mnemonic=true` (used by `/organization/recovery-key`).
//! - `GET /members/{user_id}/escrow` — fetch a member's org-wrapped
//!   private key. Key-holders only. Writes an audit row before returning
//!   so a refusal further down doesn't drop the trail.
//! - `POST /key-holders` — existing key-holder uploads the org private
//!   key re-wrapped for a newly-promoted key-holder. Inserts a
//!   `user_pubkey` row in `organization_wrapped_keys`.
//! - `GET /audit/key-access` — read the audit log. Key-holders only.
//! - `POST /members/{user_id}/reset-password` — atomic update: bcrypt
//!   the new password into `users.password` AND replace the member's
//!   `member_login_wrapped_keys` row with the new wrap the caller
//!   computed in-browser using the org private key. Key-holders only;
//!   audit-logged.
//!
//! The handlers never touch the org PRIVATE key themselves — that lives
//! only in the caller's browser, behind their mnemonic or pubkey wrap.
//! The server just shuffles wrapped envelopes around.

use crate::prelude::*;
use actix_web::{HttpRequest, HttpResponse, web};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tracing::{info, instrument, warn};
use wayve_security::password::hash_password;
use wayve_security::rbac::{
    Permission, Role, Scope, require_org_access, require_permission, resolve_role_context,
};

// ---------------------------------------------------------------------------
//   Request / response shapes
// ---------------------------------------------------------------------------

/// `POST /keys` request body.
#[derive(Debug, Deserialize)]
pub struct BootstrapKeysRequest {
    /// SPKI-encoded org public key as a JSON-array-of-bytes string (the
    /// same wire shape `users.public_key` uses — `Array.from(spkiBytes)`).
    pub public_key: String,
    pub wrapped_mnemonic: MnemonicWrap,
    pub wrapped_user: UserPubkeyWrap,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct MnemonicWrap {
    pub iv: String,
    pub ct: String,
    pub pbkdf2_salt: String,
    pub pbkdf2_iterations: i32,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct UserPubkeyWrap {
    pub iv: String,
    pub ct: String,
}

/// `GET /keys` response. `wrapped_user` is set when the caller holds a
/// `user_pubkey` row in `organization_wrapped_keys` for this org (i.e.
/// they're an owner or admin). `wrapped_mnemonic` is set only when the
/// caller is an owner AND requested `?include_mnemonic=true`.
#[derive(Debug, Serialize)]
pub struct GetKeysResponse {
    pub public_key: String,
    pub wrapped_user: Option<UserPubkeyWrap>,
    pub wrapped_mnemonic: Option<MnemonicWrap>,
}

#[derive(Debug, Deserialize)]
pub struct IncludeMnemonicQuery {
    #[serde(default)]
    pub include_mnemonic: bool,
}

/// `GET /members/{user_id}/escrow` response.
#[derive(Debug, Serialize)]
pub struct MemberEscrowResponse {
    /// The `WAYVE_SECURE_V1` envelope wrapping the member's PKCS8
    /// private key under the org pubkey. Caller unwraps with the org
    /// private key they already hold loaded in-browser.
    pub envelope: String,
}

#[derive(Debug, Deserialize)]
pub struct AddKeyHolderRequest {
    pub user_id: i32,
    pub wrapped_user: UserPubkeyWrap,
}

#[derive(Debug, Deserialize)]
pub struct ResetPasswordRequest {
    pub new_password: String,
    pub new_login_wrap: NewLoginWrap,
}

#[derive(Debug, Deserialize)]
pub struct NewLoginWrap {
    pub iv: String,
    pub ct: String,
    pub salt: String,
    pub iterations: i32,
}

#[derive(Debug, Serialize)]
pub struct AuditLogEntry {
    pub id: i64,
    pub actor_user_id: Option<i32>,
    pub actor_role: Option<String>,
    pub action: String,
    pub target_user_id: Option<i32>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

// ---------------------------------------------------------------------------
//   Helpers
// ---------------------------------------------------------------------------

fn client_ip(req: &HttpRequest) -> Option<String> {
    req.connection_info().realip_remote_addr().map(String::from)
}

fn user_agent(req: &HttpRequest) -> Option<String> {
    req.headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
}

/// Public wrapper around `write_audit_row` for sibling modules. Swallows
/// errors with a warn log — the audit-write should never block the
/// caller's response if the DB is briefly unavailable.
#[allow(clippy::too_many_arguments)]
pub async fn write_impersonation_audit(
    pool: &PgPool,
    organization_id: i32,
    actor_user_id: i32,
    actor_role: Role,
    action: &str,
    target_user_id: i32,
    req: &HttpRequest,
) {
    if let Err(e) = write_audit_row(
        pool,
        organization_id,
        actor_user_id,
        actor_role,
        action,
        Some(target_user_id),
        req,
    )
    .await
    {
        warn!(target: "auth", error = ?e, action, "audit log write failed");
    }
}

/// Public alias for sibling modules that need to assert the target is a
/// member of the org before serving impersonation reads.
pub async fn ensure_target_member(
    pool: &PgPool,
    organization_id: i32,
    target_user_id: i32,
) -> Result<(), AppError> {
    ensure_member_of(pool, organization_id, target_user_id).await
}

#[allow(clippy::too_many_arguments)]
async fn write_audit_row(
    pool: &PgPool,
    organization_id: i32,
    actor_user_id: i32,
    actor_role: Role,
    action: &str,
    target_user_id: Option<i32>,
    req: &HttpRequest,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO org_key_audit_log
            (organization_id, actor_user_id, actor_role, action, target_user_id, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(organization_id)
    .bind(actor_user_id)
    .bind(actor_role.as_str())
    .bind(action)
    .bind(target_user_id)
    .bind(client_ip(req))
    .bind(user_agent(req))
    .execute(pool)
    .await
    .map(|_| ())
}

/// Confirm `target_user_id` is a member of `organization_id`. Returns
/// 404 if not — we'd rather not leak whether the user exists in a
/// different org.
async fn ensure_member_of(
    pool: &PgPool,
    organization_id: i32,
    target_user_id: i32,
) -> Result<(), AppError> {
    let row = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM organization_members
         WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(organization_id)
    .bind(target_user_id)
    .fetch_one(pool)
    .await?;
    if row == 0 {
        return Err(AppError::NotFound("member"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
//   POST /api/organizations/{org_id}/keys   —   bootstrap
// ---------------------------------------------------------------------------

#[post("/organizations/{org_id}/keys")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn bootstrap_keys(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<BootstrapKeysRequest>,
) -> AppResult {
    let organization_id = path.into_inner();
    let ctx = match require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysBootstrap,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };

    // Atomic: the three inserts (pubkey, mnemonic wrap, founder pubkey
    // wrap) must all land together so the org never sits in a state
    // where a key-holder exists but the canonical mnemonic recovery is
    // missing — or vice versa.
    let mut tx = pool.get_ref().begin().await?;

    // Refuse re-bootstrap. If a key already exists, this call is either a
    // mistake or an attack — either way, deny without modification.
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM organization_keys WHERE organization_id = $1")
            .bind(organization_id)
            .fetch_one(&mut *tx)
            .await?;
    if exists > 0 {
        return Err(AppError::BadRequest(
            "Org master key already bootstrapped. Use /key-holders to add a new owner instead."
                .into(),
        ));
    }

    sqlx::query("INSERT INTO organization_keys (organization_id, public_key) VALUES ($1, $2)")
        .bind(organization_id)
        .bind(&body.public_key)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO organization_wrapped_keys
            (organization_id, wrap_method, holder_user_id, iv, ct, pbkdf2_iterations, pbkdf2_salt)
         VALUES ($1, 'mnemonic', NULL, $2, $3, $4, $5)",
    )
    .bind(organization_id)
    .bind(&body.wrapped_mnemonic.iv)
    .bind(&body.wrapped_mnemonic.ct)
    .bind(body.wrapped_mnemonic.pbkdf2_iterations)
    .bind(&body.wrapped_mnemonic.pbkdf2_salt)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO organization_wrapped_keys
            (organization_id, wrap_method, holder_user_id, iv, ct)
         VALUES ($1, 'user_pubkey', $2, $3, $4)",
    )
    .bind(organization_id)
    .bind(ctx.user_id)
    .bind(&body.wrapped_user.iv)
    .bind(&body.wrapped_user.ct)
    .execute(&mut *tx)
    .await?;

    // Audit row inside the transaction so a rollback also drops the
    // audit entry — never log a bootstrap that didn't happen.
    sqlx::query(
        "INSERT INTO org_key_audit_log
            (organization_id, actor_user_id, actor_role, action, ip, user_agent)
         VALUES ($1, $2, $3, 'bootstrap', $4, $5)",
    )
    .bind(organization_id)
    .bind(ctx.user_id)
    .bind(ctx.role.as_str())
    .bind(client_ip(&req))
    .bind(user_agent(&req))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    info!(
        target: "auth",
        organization_id,
        founder_user_id = ctx.user_id,
        "org master key bootstrapped"
    );

    Ok(HttpResponse::Created().json(serde_json::json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/keys   —   fetch pubkey + caller's wraps
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/keys")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_keys(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    query: web::Query<IncludeMnemonicQuery>,
) -> AppResult {
    let organization_id = path.into_inner();
    // Any org member can read the pubkey (members need it at provisioning
    // to escrow their keys, key-holders need it to wrap for new
    // key-holders). The org-membership check happens implicitly: the
    // caller's resolved RoleContext.organization_id must match.
    let ctx = require_permission(&req, pool.get_ref(), Permission::AppsUse)
        .await
        .map_err(|_| AppError::Unauthorized)?;

    let allowed = match ctx.scope {
        Scope::Platform => true,
        Scope::Organization => ctx.organization_id == Some(organization_id),
        Scope::Personal => false,
    };
    if !allowed {
        return Err(AppError::Forbidden);
    }

    let pub_row =
        sqlx::query("SELECT public_key FROM organization_keys WHERE organization_id = $1")
            .bind(organization_id)
            .fetch_optional(pool.get_ref())
            .await?;
    let Some(pub_row) = pub_row else {
        return Err(AppError::NotFound("organization_keys"));
    };
    let public_key: String = pub_row.try_get("public_key").unwrap_or_default();

    // Caller's own user_pubkey wrap, if any.
    let user_row = sqlx::query(
        "SELECT iv, ct FROM organization_wrapped_keys
         WHERE organization_id = $1
           AND wrap_method = 'user_pubkey'
           AND holder_user_id = $2",
    )
    .bind(organization_id)
    .bind(ctx.user_id)
    .fetch_optional(pool.get_ref())
    .await?;
    let wrapped_user = user_row.map(|row| UserPubkeyWrap {
        iv: row.try_get("iv").unwrap_or_default(),
        ct: row.try_get("ct").unwrap_or_default(),
    });

    // Mnemonic envelope: only returned to owners on explicit request.
    let wrapped_mnemonic = if query.include_mnemonic && ctx.has(Permission::OrgKeysBootstrap) {
        let row = sqlx::query(
            "SELECT iv, ct, pbkdf2_salt, pbkdf2_iterations
             FROM organization_wrapped_keys
             WHERE organization_id = $1 AND wrap_method = 'mnemonic'",
        )
        .bind(organization_id)
        .fetch_optional(pool.get_ref())
        .await?;
        row.map(|r| MnemonicWrap {
            iv: r.try_get("iv").unwrap_or_default(),
            ct: r.try_get("ct").unwrap_or_default(),
            pbkdf2_salt: r.try_get("pbkdf2_salt").unwrap_or_default(),
            pbkdf2_iterations: r.try_get("pbkdf2_iterations").unwrap_or(600_000),
        })
    } else {
        None
    };

    Ok(HttpResponse::Ok().json(GetKeysResponse {
        public_key,
        wrapped_user,
        wrapped_mnemonic,
    }))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/members/{user_id}/escrow
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/members/{user_id}/escrow")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_member_escrow(
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

    ensure_member_of(pool.get_ref(), organization_id, target_user_id).await?;

    let row = sqlx::query(
        "SELECT ct FROM member_wrapped_keys
         WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(organization_id)
    .bind(target_user_id)
    .fetch_optional(pool.get_ref())
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound("member_escrow"));
    };
    let envelope: String = row.try_get("ct").unwrap_or_default();

    // Audit OUTSIDE a transaction — we want the row to land even if the
    // body write below somehow fails partway, so reviewers see attempts.
    if let Err(e) = write_audit_row(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "fetch_member_escrow",
        Some(target_user_id),
        &req,
    )
    .await
    {
        warn!(target: "auth", error = ?e, "audit log write failed for fetch_member_escrow");
    }

    Ok(HttpResponse::Ok().json(MemberEscrowResponse { envelope }))
}

// ---------------------------------------------------------------------------
//   POST /api/organizations/{org_id}/key-holders
// ---------------------------------------------------------------------------

#[post("/organizations/{org_id}/key-holders")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn add_key_holder_wrap(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<AddKeyHolderRequest>,
) -> AppResult {
    let organization_id = path.into_inner();
    // OrgKeysBootstrap is owner-only — promoting a key-holder is a
    // role-structure change and stays with the trust root.
    let ctx = match require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysBootstrap,
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };

    // The new holder must already exist in organization_members AND
    // currently hold a role that's allowed to hold the org master key
    // (owner / super_admin / admin). The role-update endpoint runs
    // separately; this handler only adds the cryptographic wrap.
    let new_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM organization_members
         WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(organization_id)
    .bind(body.user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .flatten();
    let Some(role) = new_role else {
        return Err(AppError::NotFound("member"));
    };
    let role_enum = Role::from_str(&role);
    if !matches!(role_enum, Role::Owner | Role::SuperAdmin | Role::Admin) {
        return Err(AppError::BadRequest(format!(
            "role '{}' is not a key-holder role; promote the member first",
            role
        )));
    }

    // Idempotent on (org, holder): UPSERT so calling this twice with a
    // re-wrap (e.g., the holder rotated their personal RSA key) just
    // refreshes the row.
    sqlx::query(
        "INSERT INTO organization_wrapped_keys
            (organization_id, wrap_method, holder_user_id, iv, ct)
         VALUES ($1, 'user_pubkey', $2, $3, $4)
         ON CONFLICT (organization_id, holder_user_id)
         DO UPDATE SET iv = EXCLUDED.iv, ct = EXCLUDED.ct, created_at = NOW()",
    )
    .bind(organization_id)
    .bind(body.user_id)
    .bind(&body.wrapped_user.iv)
    .bind(&body.wrapped_user.ct)
    .execute(pool.get_ref())
    .await?;

    if let Err(e) = write_audit_row(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "add_key_holder",
        Some(body.user_id),
        &req,
    )
    .await
    {
        warn!(target: "auth", error = ?e, "audit log write failed for add_key_holder");
    }

    Ok(HttpResponse::Created().json(serde_json::json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/audit/key-access
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/audit/key-access")]
#[instrument(target = "http", skip(req, pool))]
pub async fn read_audit_log(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let organization_id = path.into_inner();
    if let Err(resp) = require_org_access(
        &req,
        pool.get_ref(),
        organization_id,
        Permission::OrgKeysUseMaster,
    )
    .await
    {
        return Ok(resp);
    }

    let rows = sqlx::query(
        "SELECT id, actor_user_id, actor_role, action, target_user_id, ip, user_agent, created_at
         FROM org_key_audit_log
         WHERE organization_id = $1
         ORDER BY created_at DESC
         LIMIT 500",
    )
    .bind(organization_id)
    .fetch_all(pool.get_ref())
    .await?;

    let entries: Vec<AuditLogEntry> = rows
        .into_iter()
        .map(|row| AuditLogEntry {
            id: row.try_get("id").unwrap_or_default(),
            actor_user_id: row.try_get("actor_user_id").ok().flatten(),
            actor_role: row.try_get("actor_role").ok().flatten(),
            action: row.try_get("action").unwrap_or_default(),
            target_user_id: row.try_get("target_user_id").ok().flatten(),
            ip: row.try_get("ip").ok().flatten(),
            user_agent: row.try_get("user_agent").ok().flatten(),
            created_at: row
                .try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                .unwrap_or_else(|_| chrono::Utc::now()),
        })
        .collect();

    Ok(HttpResponse::Ok().json(entries))
}

// ---------------------------------------------------------------------------
//   POST /api/organizations/{org_id}/members/{user_id}/reset-password
// ---------------------------------------------------------------------------

#[post("/organizations/{org_id}/members/{user_id}/reset-password")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn reset_member_password(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<(i32, i32)>,
    body: web::Json<ResetPasswordRequest>,
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

    // Refuse to reset another key-holder's password via this path — the
    // org-key-rewrap implications are significant (the new password would
    // de-facto rotate their access). Owner removal/demotion is a separate
    // workflow that handles the wrap-table cleanup explicitly.
    let target_role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM organization_members
         WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(organization_id)
    .bind(target_user_id)
    .fetch_optional(pool.get_ref())
    .await?
    .flatten();
    let Some(role) = target_role else {
        return Err(AppError::NotFound("member"));
    };
    let role_enum = Role::from_str(&role);
    if matches!(role_enum, Role::Owner | Role::SuperAdmin | Role::Admin) {
        return Err(AppError::BadRequest(
            "Cannot reset password for another key-holder via this endpoint. \
             Remove their role first, or have them perform a password change."
                .into(),
        ));
    }

    if body.new_password.len() < 8 {
        return Err(AppError::BadRequest(
            "New password must be at least 8 characters.".into(),
        ));
    }

    let hashed = hash_password(&body.new_password).await?;

    let mut tx = pool.get_ref().begin().await?;
    sqlx::query("UPDATE users SET password = $1 WHERE id = $2")
        .bind(&hashed)
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO member_login_wrapped_keys (user_id, iv, ct, salt, iterations)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE
         SET iv = EXCLUDED.iv,
             ct = EXCLUDED.ct,
             salt = EXCLUDED.salt,
             iterations = EXCLUDED.iterations,
             updated_at = NOW()",
    )
    .bind(target_user_id)
    .bind(&body.new_login_wrap.iv)
    .bind(&body.new_login_wrap.ct)
    .bind(&body.new_login_wrap.salt)
    .bind(body.new_login_wrap.iterations)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // Reset the actor's cached role context — not strictly necessary
    // here (role didn't change), but it ensures any cached login state
    // for the TARGET sees a fresh resolution next request.
    wayve_security::rbac::invalidate_role_context(target_user_id).await;

    if let Err(e) = write_audit_row(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "reset_password",
        Some(target_user_id),
        &req,
    )
    .await
    {
        warn!(target: "auth", error = ?e, "audit log write failed for reset_password");
    }

    info!(
        target: "auth",
        organization_id,
        actor = ctx.user_id,
        target = target_user_id,
        "org admin reset member password"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------------
//   GET /api/organizations/{org_id}/members/{user_id}/notes
//   ---------------------------------------------------------------------------
//   Owner / admin reads ALL of a member's notes — returned as the same
//   encrypted envelopes the member's own /api/notes returns. Caller
//   decrypts them client-side using the member's private key recovered
//   via the org master key (see organization/keys.rs:get_member_escrow).
//
//   No new "as-member" auth machinery — this endpoint just runs the same
//   "user_id = $1" query against `notes`, but with the target user_id
//   chosen by an OrgKeysUseMaster-holding caller. The audit row logs
//   who read what, so a later review can see if an admin pulled member
//   data without a legitimate trigger.
// ---------------------------------------------------------------------------

#[get("/organizations/{org_id}/members/{user_id}/notes")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_member_notes(
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

    ensure_member_of(pool.get_ref(), organization_id, target_user_id).await?;

    let rows = sqlx::query(
        "SELECT id, title, content, created_at, updated_at
         FROM notes
         WHERE user_id = $1
         ORDER BY updated_at DESC",
    )
    .bind(target_user_id)
    .fetch_all(pool.get_ref())
    .await?;

    if let Err(e) = write_audit_row(
        pool.get_ref(),
        organization_id,
        ctx.user_id,
        ctx.role,
        "list_member_notes",
        Some(target_user_id),
        &req,
    )
    .await
    {
        warn!(target: "auth", error = ?e, "audit log write failed for list_member_notes");
    }

    let notes: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or_default(),
                "title": row.try_get::<Option<String>, _>("title").ok().flatten(),
                "content": row.try_get::<Option<String>, _>("content").ok().flatten(),
                "created_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at").ok().flatten(),
                "updated_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("updated_at").ok().flatten(),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(notes))
}

// ---------------------------------------------------------------------------
//   Helpers for other modules (login response, member provisioning)
// ---------------------------------------------------------------------------

/// Fetch the password-wrapped private-key envelope for a user, if one
/// exists. Returned to the client at login so org members can unwrap
/// their PKCS8 with PBKDF2(password). `None` for personal users (who
/// don't have a `member_login_wrapped_keys` row — they use the mnemonic
/// recovery path instead).
pub async fn fetch_login_wrap(
    pool: &PgPool,
    user_id: i32,
) -> Result<Option<NewLoginWrap>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT iv, ct, salt, iterations FROM member_login_wrapped_keys
         WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| NewLoginWrap {
        iv: r.try_get("iv").unwrap_or_default(),
        ct: r.try_get("ct").unwrap_or_default(),
        salt: r.try_get("salt").unwrap_or_default(),
        iterations: r.try_get("iterations").unwrap_or(600_000),
    }))
}

/// Fetch an org's public key (SPKI bytes as a JSON-array string) for
/// the server-side keypair-provisioning path in `routes/user.rs`'s
/// admin/users handler. Returns `None` if the org has no bootstrapped
/// key — admin/users will fail provisioning in that case so the owner
/// is forced to bootstrap before adding members.
pub async fn fetch_org_public_key(
    pool: &PgPool,
    organization_id: i32,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT public_key FROM organization_keys WHERE organization_id = $1")
        .bind(organization_id)
        .fetch_optional(pool)
        .await
}

/// Helper for the member-provisioning path. Inserts the org-pubkey wrap
/// AND the password-derived login wrap atomically with the new user row.
/// Returning a transaction is awkward; callers compose this with their
/// own transaction by passing in their pool and we open a short tx here.
#[allow(clippy::too_many_arguments)]
pub async fn persist_provisioned_keys(
    pool: &PgPool,
    user_id: i32,
    organization_id: i32,
    public_key_json: &str,
    member_escrow_envelope: &str,
    login_wrap: &wayve_security::encryption::PasswordWrappedPrivateKey,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    // users.public_key already exists for personal users; overwrite for
    // the org-member case (server is the source of truth, member never
    // chose the key).
    sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
        .bind(public_key_json)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO member_wrapped_keys (organization_id, user_id, iv, ct)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, user_id) DO UPDATE
         SET iv = EXCLUDED.iv, ct = EXCLUDED.ct",
    )
    .bind(organization_id)
    .bind(user_id)
    // iv intentionally empty: the WAYVE_SECURE_V1 envelope is
    // self-describing (it contains its own IV inside the JSON body).
    // The `iv` column exists for symmetry with login_wrap; we leave it
    // empty so the wire format consumed by the frontend doesn't change.
    .bind("")
    .bind(member_escrow_envelope)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO member_login_wrapped_keys (user_id, iv, ct, salt, iterations)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE
         SET iv = EXCLUDED.iv,
             ct = EXCLUDED.ct,
             salt = EXCLUDED.salt,
             iterations = EXCLUDED.iterations,
             updated_at = NOW()",
    )
    .bind(user_id)
    .bind(&login_wrap.iv_b64)
    .bind(&login_wrap.ct_b64)
    .bind(&login_wrap.salt_b64)
    .bind(login_wrap.iterations as i32)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Use the resolve_role_context API to determine whether `user_id`
/// currently holds the org master key wrap (i.e. has a `user_pubkey`
/// row in `organization_wrapped_keys` for their org). Used by tests and
/// the frontend banner that nudges new key-holders to enter the
/// mnemonic.
#[allow(dead_code)]
pub async fn current_user_holds_key_wrap(pool: &PgPool, user_id: i32) -> Result<bool, sqlx::Error> {
    let ctx = match resolve_role_context(pool, user_id).await {
        Ok(c) => c,
        Err(e) => return Err(e),
    };
    let Some(org_id) = ctx.organization_id else {
        return Ok(false);
    };
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_wrapped_keys
         WHERE organization_id = $1 AND holder_user_id = $2 AND wrap_method = 'user_pubkey'",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}
