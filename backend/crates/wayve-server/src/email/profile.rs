use crate::prelude::*;

use crate::cache::TtlCache;
use crate::routes::user::{
    current_plan_for_user, display_organization_name, effective_access_for_user,
};
use wayve_security::jwt::get_user_id_from_request;
use actix_web::{HttpResponse, get};
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};

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
        SELECT u.id, u.email, u.account_type, u.organization_id, u.recovery_mode,
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
