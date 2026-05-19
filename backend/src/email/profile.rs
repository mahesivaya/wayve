use crate::prelude::*;

use crate::routes::user::effective_access_for_user;
use crate::security::jwt::get_user_id_from_request;
use actix_web::{HttpResponse, Responder, get};
use moka::future::Cache as MokaCache;
use sqlx::PgPool;
use std::time::Duration;
use tracing::{error, info, instrument};

const ME_CACHE_TTL_SECS: u64 = 60;
const ME_CACHE_MAX_CAPACITY: u64 = 10_000;

static ME_CACHE: Lazy<MokaCache<i32, Value>> = Lazy::new(|| {
    MokaCache::builder()
        .max_capacity(ME_CACHE_MAX_CAPACITY)
        .time_to_live(Duration::from_secs(ME_CACHE_TTL_SECS))
        .build()
});

pub async fn invalidate_me_cache(user_id: i32) {
    ME_CACHE.invalidate(&user_id).await;
}

#[get("/me")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_me(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return HttpResponse::Unauthorized()
                .json(serde_json::json!({ "error": "Missing or invalid token" }));
        }
    };

    if let Some(cached) = ME_CACHE.get(&user_id).await {
        return HttpResponse::Ok().json(cached);
    }

    let result = sqlx::query(
        r#"
        SELECT u.id, u.email, u.account_type, u.organization_id,
               o.slug AS organization_slug, o.name AS organization_name
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
            let account_type: String = row.get("account_type");
            let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();
            let organization_slug: Option<String> = row.try_get("organization_slug").ok().flatten();

            // Requirement: For personal accounts, organization name is the email address.
            let organization_name: Option<String> = if account_type == "personal" {
                Some(email.clone())
            } else {
                row.try_get("organization_name").ok().flatten()
            };
            let access = match effective_access_for_user(pool.get_ref(), id).await {
                Ok(value) => value,
                Err(e) => {
                    error!(target: "db", user_id = id, error = ?e, "effective access lookup failed");
                    crate::routes::user::fallback_access(&account_type)
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
                "organization_name": organization_name
            });

            ME_CACHE.insert(user_id, response.clone()).await;
            HttpResponse::Ok().json(response)
        }
        Ok(None) => {
            HttpResponse::Unauthorized().json(serde_json::json!({ "error": "User not found" }))
        }
        Err(e) => {
            error!(target: "db", error = %e, "get_me lookup failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}

#[post("/save-public-key")]
#[instrument(target = "auth", skip(req, pool, body))]
pub async fn save_public_key(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<serde_json::Value>,
) -> HttpResponse {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return HttpResponse::Unauthorized().body("Invalid token"),
    };

    let public_key = body["public_key"].to_string();

    let res = sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
        .bind(public_key)
        .bind(user_id)
        .execute(pool.get_ref())
        .await;

    match res {
        Ok(_) => {
            info!(target: "auth", user_id, "public key saved");
            HttpResponse::Ok().body("Saved")
        }
        Err(e) => {
            error!(target: "db", user_id, error = ?e, "save_public_key failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}
