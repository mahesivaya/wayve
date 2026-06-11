use crate::prelude::*;

use crate::cache::TtlCache;
use crate::routes::user::{
    current_plan_for_user, display_organization_name, effective_access_for_user,
};
use actix_web::{HttpResponse, get, put};
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

const ME_CACHE_TTL_SECS: u64 = 60;
const ME_CACHE_MAX_CAPACITY: u64 = 10_000;

static ME_CACHE: Lazy<TtlCache<i32, Value>> =
    Lazy::new(|| TtlCache::new(ME_CACHE_MAX_CAPACITY, ME_CACHE_TTL_SECS));

pub async fn invalidate_me_cache(user_id: i32) {
    ME_CACHE.invalidate(&user_id).await;
}

#[get("/me")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_me(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "error": "Missing or invalid token" })));
        }
    };

    if let Some(cached) = ME_CACHE.get(&user_id).await {
        return Ok(HttpResponse::Ok().json(cached));
    }

    let row = sqlx::query(
        r#"
        SELECT u.id, u.email, u.account_type, u.organization_id, u.recovery_mode, u.theme_json,
               u.avatar_path,
               o.slug AS organization_slug, o.name AS organization_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let row = match row {
        Some(row) => row,
        None => {
            return Ok(
                HttpResponse::Unauthorized().json(serde_json::json!({ "error": "User not found" }))
            );
        }
    };

    let id: i32 = row.get("id");
    let email: String = row.get("email");
    let account_type: String = row.get("account_type");
    let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();
    let organization_slug: Option<String> = row.try_get("organization_slug").ok().flatten();
    // Legacy rows (created before recovery_mode existed) shouldn't happen
    // — the column has a NOT NULL default — but treat any unknown value
    // as "full" to keep the safer-default semantics.
    let recovery_mode: String = row
        .try_get::<String, _>("recovery_mode")
        .unwrap_or_else(|_| "full".to_string());
    let theme_json: Option<String> = row.try_get("theme_json").ok().flatten();
    // Uploaded profile image. The stored value is a disk path; the client only
    // needs the stable serve URL (it 404s/falls back to the initial when unset).
    let avatar_path: Option<String> = row.try_get("avatar_path").ok().flatten();
    let avatar_url = avatar_path.map(|_| format!("/api/users/{id}/avatar"));

    let organization_name = display_organization_name(
        &account_type,
        &email,
        row.try_get("organization_name").ok().flatten(),
    );
    let access = match effective_access_for_user(pool.get_ref(), id).await {
        Ok(value) => value,
        Err(e) => {
            error!(target: "db", user_id = id, error = ?e, "effective access lookup failed");
            crate::routes::user::fallback_access(&account_type)
        }
    };

    // Look up the user's current tier so the frontend can show a tier badge
    // and the "Upgrade" affordance. Falls back to the basic_user plan when
    // the user has no active subscription — that's the default state for
    // every new registration.
    let current_plan = match current_plan_for_user(pool.get_ref(), id, organization_id).await {
        Ok(plan) => Some(plan),
        Err(e) => {
            warn!(target: "db", user_id = id, error = ?e, "current_plan lookup failed");
            None
        }
    };

    let response = serde_json::json!({
        "id": id,
        "email": email,
        "account_type": account_type,
        "effective_role": access.role,
        "role_label": access.role_label,
        "scope": access.scope,
        "permissions": access.permissions,
        "organization_id": organization_id,
        "organization_slug": organization_slug,
        "organization_name": organization_name,
        "current_plan": current_plan,
        "recovery_mode": recovery_mode,
        "theme_json": theme_json,
        "avatar_url": avatar_url,
    });

    ME_CACHE.insert(user_id, response.clone()).await;
    Ok(HttpResponse::Ok().json(response))
}

#[post("/save-public-key")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn save_public_key(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<serde_json::Value>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().body("Invalid token")),
    };

    let public_key = body["public_key"].to_string();

    sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
        .bind(public_key)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    info!(target: "auth", user_id, "public key saved");
    Ok(HttpResponse::Ok().body("Saved"))
}

// PUT /api/me/theme — persist the user's theme choice. Body: { theme: <json>|null }
// where <json> is the serialized ThemeChoice from the frontend customizer
// ({ kind: "preset"|"custom"|"default", ... }). NULL clears the saved
// preference and reverts the user to the stylesheet default on next load.
//
// The column is treated as opaque to the backend: we don't validate the
// schema. The frontend owns the format and is permissive on parse errors.
#[put("/me/theme")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_theme(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<serde_json::Value>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "error": "Missing or invalid token" })));
        }
    };

    let theme: Option<String> = match body.get("theme") {
        Some(serde_json::Value::Null) | None => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        // Allow callers to send the object directly instead of a string —
        // we serialize it back. Keeps the API forgiving.
        Some(value) => Some(value.to_string()),
    };

    sqlx::query("UPDATE users SET theme_json = $1 WHERE id = $2")
        .bind(theme.as_deref())
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    invalidate_me_cache(user_id).await;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "theme": theme })))
}
