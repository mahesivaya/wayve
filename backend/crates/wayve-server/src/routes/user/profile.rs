//! Profile + user-directory endpoints: `/profile`, `/profile/password`,
//! `/users`, `/users/all`.

use super::shared::{
    PROFILE_CACHE, current_plan_for_user, display_organization_name, effective_access_for_user,
    fallback_access, invalidate_profile_cache,
};
use crate::billing::{entitlements::effective_entitlements, resolve_owner};
use crate::email::profile::invalidate_me_cache;
use crate::models::auth::ChangePasswordInput;
use crate::models::email_request::UserResponse;
use crate::prelude::*;
use actix_web::put;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::password::{hash_password, verify_password};
use wayve_security::rbac;

#[derive(Deserialize)]
pub struct UserLookupQuery {
    pub email: String,
}

#[get("/users")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn get_user_by_email(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<UserLookupQuery>,
) -> AppResult {
    // Require a valid JWT — this endpoint exposes user ids and public keys,
    // so it must not be reachable anonymously.
    if get_user_id_from_request(&req).is_none() {
        return Ok(HttpResponse::Unauthorized().finish());
    }

    let email = query.email.trim();
    if email.is_empty() {
        return Ok(HttpResponse::BadRequest().body("Email required"));
    }

    let user = sqlx::query_as::<_, UserResponse>(
        "SELECT id, email, public_key FROM users WHERE email = $1",
    )
    .bind(email)
    .fetch_optional(pool.get_ref())
    .await?;

    match user {
        Some(user) => {
            let parsed_key = user
                .public_key
                .and_then(|k| serde_json::from_str::<Vec<u8>>(&k).ok());

            Ok(HttpResponse::Ok().json(serde_json::json!({
                "id": user.id,
                "email": user.email,
                "public_key": parsed_key
            })))
        }
        None => Ok(HttpResponse::Ok().json(serde_json::json!(null))),
    }
}

#[derive(Deserialize)]
pub struct ProfileUpdate {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

#[get("/profile")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_profile(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    if let Some(cached) = PROFILE_CACHE.get(&user_id).await {
        return Ok(HttpResponse::Ok().json(cached));
    }

    let result = sqlx::query(
        r#"
        SELECT
            u.id, u.email, u.first_name, u.last_name, u.auth_provider, u.account_type, u.organization_id, u.username, u.recovery_mode,
            o.name as organization_name,
            (SELECT COUNT(*)::BIGINT FROM emails e JOIN email_accounts ea ON e.account_id = ea.id WHERE ea.user_id = u.id) as total_emails,
            (SELECT COALESCE(SUM(octet_length(body_encrypted)), 0)::BIGINT FROM emails e JOIN email_accounts ea ON e.account_id = ea.id WHERE ea.user_id = u.id) as email_storage_bytes,
            (SELECT COALESCE(SUM(size), 0)::BIGINT FROM drive_files f WHERE f.user_id = u.id) as drive_storage_bytes,
            (SELECT COALESCE(SUM(octet_length(content_encrypted)), 0)::BIGINT FROM messages m WHERE m.sender_id = u.id) as chat_storage_bytes,
            (SELECT COALESCE(SUM(octet_length(coalesce(content_encrypted, content, ''))), 0)::BIGINT FROM notes n WHERE n.user_id = u.id) as notes_storage_bytes,
            (SELECT COALESCE(SUM(octet_length(name) + octet_length(coalesce(description, ''))), 0)::BIGINT FROM tasks t WHERE t.user_id = u.id) as tasks_storage_bytes
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await;

    match result {
        Ok(Some(row)) => {
            let id: i32 = row.get("id");
            let email: String = row.get("email");
            let first_name: Option<String> = row.try_get("first_name").ok();
            let last_name: Option<String> = row.try_get("last_name").ok();
            let auth_provider: String = row
                .try_get("auth_provider")
                .unwrap_or_else(|_| "local".to_string());
            let account_type: String = row
                .try_get("account_type")
                .unwrap_or_else(|_| "personal".to_string());
            let total_emails: i64 = row.get("total_emails");
            let email_storage_bytes: i64 = row.get("email_storage_bytes");
            let drive_storage_bytes: i64 = row.get("drive_storage_bytes");
            let chat_storage_bytes: i64 = row.get("chat_storage_bytes");
            let notes_storage_bytes: i64 = row.get("notes_storage_bytes");
            let tasks_storage_bytes: i64 = row.get("tasks_storage_bytes");
            let username: Option<String> = row.try_get("username").ok();
            let recovery_mode: String = row
                .try_get("recovery_mode")
                .unwrap_or_else(|_| "full".to_string());
            let total_used = email_storage_bytes
                + drive_storage_bytes
                + chat_storage_bytes
                + notes_storage_bytes
                + tasks_storage_bytes;

            let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();
            let organization_name = display_organization_name(
                &account_type,
                &email,
                row.try_get("organization_name").ok().flatten(),
            );
            let access = match effective_access_for_user(pool.get_ref(), id).await {
                Ok(value) => value,
                Err(e) => {
                    error!(target: "db", user_id = id, error = ?e, "effective access lookup failed");
                    fallback_access(&account_type)
                }
            };

            // Same lookup as /api/me — falls back to basic_user when no
            // subscription exists. /api/profile is heavier than /api/me but
            // both pages want the tier badge, so we include it in both.
            let current_plan =
                match current_plan_for_user(pool.get_ref(), id, organization_id).await {
                    Ok(plan) => Some(plan),
                    Err(e) => {
                        warn!(target: "db", user_id = id, error = ?e, "current_plan lookup failed");
                        None
                    }
                };

            // Real plan storage limit from entitlements (1 GiB free, 10 GiB
            // advance, -1 = unlimited for org/enterprise) instead of a hardcoded
            // value. On a transient owner-resolution error, fall back to -1
            // (the client treats <= 0 as unlimited) so a DB hiccup never shows a
            // false "storage full" alert.
            let memory_limit_bytes = match resolve_owner(pool.get_ref(), id).await {
                Ok(owner) => {
                    effective_entitlements(pool.get_ref(), owner)
                        .await
                        .storage_limit_bytes
                }
                Err(e) => {
                    warn!(target: "db", user_id = id, error = ?e, "owner resolve failed for storage limit");
                    -1
                }
            };

            let response = serde_json::json!({
                "id": id,
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
                "auth_provider": auth_provider,
                "account_type": account_type,
                "effective_role": access.role,
                "role_label": access.role_label,
                "scope": access.scope,
                "permissions": access.permissions,
                "organization_id": organization_id,
                "organization_name": organization_name,
                "current_plan": current_plan,
                "username": username,
                "total_emails": total_emails,
                "email_storage_bytes": email_storage_bytes,
                "drive_storage_bytes": drive_storage_bytes,
                "other_storage_bytes": chat_storage_bytes + notes_storage_bytes + tasks_storage_bytes,
                "memory_used_bytes": total_used,
                "memory_limit_bytes": memory_limit_bytes,
                "recovery_mode": recovery_mode,
            });

            PROFILE_CACHE.insert(user_id, response.clone()).await;
            Ok(HttpResponse::Ok().json(response))
        }
        Ok(None) => Ok(HttpResponse::NotFound().finish()),
        Err(e) => Err(AppError::Db(e)),
    }
}

#[post("/profile/password")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn change_password(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ChangePasswordInput>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    if data.new_password.len() < 6 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "New password must be at least 6 characters" })));
    }

    let row = sqlx::query("SELECT password, auth_provider FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await;

    let (stored, auth_provider): (Option<String>, String) = match row {
        Ok(Some(r)) => (
            r.try_get("password").ok().flatten(),
            r.try_get("auth_provider")
                .unwrap_or_else(|_| "local".to_string()),
        ),
        _ => return Ok(HttpResponse::Unauthorized().finish()),
    };

    if let Some(stored) = stored {
        let current_password = data.current_password.as_deref().unwrap_or("");
        let valid = verify_password(current_password, &stored)
            .await
            .unwrap_or(false);
        if !valid {
            warn!(target: "auth", user_id, "change-password: wrong current password");
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Current password is incorrect" })));
        }
    } else if auth_provider != "google" {
        warn!(target: "auth", user_id, "change-password rejected: missing password");
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "This account has no password to change" })));
    }

    // Org members have a server-stored member_login_wrapped_keys row
    // keyed by PBKDF2(old_password). If we update the bcrypt hash but
    // leave that row alone, the member is locked out at next login —
    // their browser will try to unwrap their PKCS8 with the new password
    // and AES-GCM auth-tag-fail. Require the frontend to send the
    // pre-computed new wrap whenever such a row exists.
    let needs_wrap_rotation: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)::BIGINT FROM member_login_wrapped_keys WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await
    .unwrap_or(0)
        > 0;
    if needs_wrap_rotation && data.new_login_wrap.is_none() {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Organization accounts must include the re-wrapped login envelope on password change."
        })));
    }

    let hashed = hash_password(&data.new_password).await?;

    let mut tx = pool.get_ref().begin().await?;
    sqlx::query("UPDATE users SET password = $1 WHERE id = $2")
        .bind(&hashed)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    if let Some(wrap) = &data.new_login_wrap {
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
        .bind(&wrap.iv)
        .bind(&wrap.ct)
        .bind(&wrap.salt)
        .bind(wrap.iterations)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    info!(target: "auth", user_id, had_password = data.current_password.is_some(), wrap_rotated = data.new_login_wrap.is_some(), "password updated");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "message": "Password updated" })))
}

#[put("/profile")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn update_profile(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ProfileUpdate>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    let result = sqlx::query(
        "UPDATE users
         SET first_name = COALESCE($1, first_name),
             last_name = COALESCE($2, last_name)
         WHERE id = $3
         RETURNING id, email, first_name, last_name",
    )
    .bind(data.first_name.as_deref())
    .bind(data.last_name.as_deref())
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await;

    match result {
        Ok(Some(row)) => {
            invalidate_me_cache(user_id).await;
            invalidate_profile_cache(user_id).await;
            let id: i32 = row.get("id");
            let email: String = row.get("email");
            let first_name: Option<String> = row.try_get("first_name").ok();
            let last_name: Option<String> = row.try_get("last_name").ok();

            info!(target: "http", user_id, "profile updated");
            Ok(HttpResponse::Ok().json(serde_json::json!({
                "id": id,
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
            })))
        }
        Ok(None) => Ok(HttpResponse::NotFound().finish()),
        Err(e) => Err(AppError::Db(e)),
    }
}

#[get("/users/all")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_all_users(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    // Require a valid JWT — this endpoint enumerates accounts.
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    // Scope the directory to the caller's own world so the chat people-picker
    // never leaks accounts across tenants: a platform account sees only
    // platform accounts, an organization account sees only same-org accounts,
    // and a personal account sees only other personal accounts.
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id).await?;

    let rows = sqlx::query(
        r#"
        SELECT id, email, public_key
        FROM users u
        WHERE (
            ($1 = 'personal'     AND u.account_type = 'personal')
         OR ($1 = 'platform'     AND u.account_type = 'platform_admin')
         OR ($1 = 'organization' AND u.account_type IN ('organization', 'organization_admin')
                                  AND u.organization_id = $2)
        )
        "#,
    )
    .bind(ctx.scope.as_str())
    .bind(ctx.organization_id)
    .fetch_all(pool.get_ref())
    .await?;

    let users: Vec<_> = rows
        .into_iter()
        .map(|r| {
            let id: i32 = r.get("id");
            let email: String = r.get("email");
            let public_key: Option<String> = r.get("public_key");
            let public_key = public_key.and_then(|k| serde_json::from_str::<Vec<u8>>(&k).ok());

            serde_json::json!({
                "id": id,
                "email": email,
                "public_key": public_key
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(users))
}
