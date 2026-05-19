//! API key management endpoints — create / list / revoke keys and read a
//! key's audit log. All are gated by the RBAC `api_keys:manage` permission;
//! `internal` keys additionally require platform scope.

use crate::prelude::*;
use crate::security::api_key::{generate_api_key, hash_api_key, is_valid_scope};
use crate::security::rbac::{self, Permission, RoleContext, Scope};
use actix_web::{HttpRequest, HttpResponse, Responder, delete, get, post, web};
use chrono::{DateTime, Utc};
use tracing::{error, info, instrument};

const INTERNAL_RATE_DEFAULT: i32 = 6000;
const EXTERNAL_RATE_DEFAULT: i32 = 120;
const AUDIT_PAGE_LIMIT: i64 = 200;

#[derive(Deserialize)]
pub struct CreateKeyInput {
    pub name: String,
    pub key_type: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub rate_limit_per_min: Option<i32>,
    /// User the key acts as. Defaults to the caller; a different user requires
    /// `members:manage` over that user's scope.
    pub act_as_user_id: Option<i32>,
}

/// A stored key as exposed to the UI — never the raw key or its hash.
#[derive(Serialize, FromRow)]
pub struct ApiKeyView {
    pub id: i32,
    pub name: String,
    pub key_type: String,
    pub scopes: Vec<String>,
    pub key_preview: String,
    pub user_id: Option<i32>,
    pub organization_id: Option<i32>,
    pub rate_limit_per_min: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, FromRow)]
pub struct AuditView {
    pub id: i64,
    pub api_key_id: Option<i32>,
    pub method: String,
    pub path: String,
    pub status_code: i32,
    pub outcome: String,
    pub ip: Option<String>,
    pub created_at: DateTime<Utc>,
}

const KEY_COLUMNS: &str = "id, name, key_type, scopes, key_preview, user_id, \
     organization_id, rate_limit_per_min, expires_at, last_used_at, revoked_at, created_at";

/// Whether `key_id` is one the caller may see/manage: platform staff see every
/// key; an organization manager sees keys whose acting user is in their org or
/// that they created; otherwise only the caller's own keys.
async fn key_in_caller_scope(
    pool: &PgPool,
    ctx: &RoleContext,
    key_id: i32,
) -> Result<bool, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT ak.created_by, ak.user_id, u.organization_id AS owner_org
        FROM api_keys ak
        LEFT JOIN users u ON u.id = ak.user_id
        WHERE ak.id = $1
        "#,
    )
    .bind(key_id)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Ok(false);
    };
    let created_by: Option<i32> = row.try_get("created_by").ok().flatten();
    let user_id: Option<i32> = row.try_get("user_id").ok().flatten();
    let owner_org: Option<i32> = row.try_get("owner_org").ok().flatten();

    Ok(match ctx.scope {
        Scope::Platform => true,
        Scope::Organization => owner_org == ctx.organization_id || created_by == Some(ctx.user_id),
        Scope::Personal => created_by == Some(ctx.user_id) || user_id == Some(ctx.user_id),
    })
}

#[post("/keys")]
#[instrument(target = "auth", skip(req, pool, data), fields(name = %data.name))]
pub async fn create_api_key(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateKeyInput>,
) -> impl Responder {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };

    let name = data.name.trim();
    if name.is_empty() {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Key name is required" }));
    }

    let key_type = data.key_type.trim();
    if !matches!(key_type, "internal" | "external") {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "key_type must be 'internal' or 'external'" }));
    }
    // Internal keys are full-trust — only platform staff may mint them.
    if key_type == "internal" && ctx.scope != Scope::Platform {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only platform staff may create internal keys"
        }));
    }

    // Validate the requested scopes.
    for scope in &data.scopes {
        if !is_valid_scope(scope) {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": format!("Unknown scope: {scope}") }));
        }
    }
    let has_wildcard = data.scopes.iter().any(|scope| scope == "*");
    if key_type == "external" {
        if data.scopes.is_empty() {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "External keys must list explicit scopes" }));
        }
        if has_wildcard {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "message": "External keys may not hold the '*' scope"
            }));
        }
        if data.expires_at.is_none() {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "External keys require an expiry" }));
        }
    }
    if let Some(expiry) = data.expires_at
        && expiry <= Utc::now()
    {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Expiry must be in the future" }));
    }

    // Resolve the acting principal.
    let act_as = data.act_as_user_id.unwrap_or(ctx.user_id);
    let acting_org: Option<i32> = if act_as == ctx.user_id {
        ctx.organization_id
    } else {
        if !ctx.has(Permission::MembersManage) {
            return HttpResponse::Forbidden().json(serde_json::json!({
                "message": "You cannot issue a key acting as another user"
            }));
        }
        match sqlx::query_scalar::<_, Option<i32>>(
            "SELECT organization_id FROM users WHERE id = $1",
        )
        .bind(act_as)
        .fetch_optional(pool.get_ref())
        .await
        {
            Ok(Some(org)) => {
                if ctx.scope == Scope::Organization && org != ctx.organization_id {
                    return HttpResponse::Forbidden().json(serde_json::json!({
                        "message": "That user is not in your organization"
                    }));
                }
                org
            }
            Ok(None) => {
                return HttpResponse::NotFound()
                    .json(serde_json::json!({ "message": "Acting user not found" }));
            }
            Err(e) => {
                error!(target: "db", error = ?e, "act-as user lookup failed");
                return HttpResponse::InternalServerError().finish();
            }
        }
    };

    let rate_limit = data
        .rate_limit_per_min
        .unwrap_or(if key_type == "internal" {
            INTERNAL_RATE_DEFAULT
        } else {
            EXTERNAL_RATE_DEFAULT
        })
        .max(1);

    // The raw key is returned to the caller exactly once; only its hash persists.
    let raw_key = generate_api_key();
    let key_hash = hash_api_key(&raw_key);
    let key_preview = format!("{}...{}", &raw_key[..10], &raw_key[raw_key.len() - 4..]);

    let inserted = sqlx::query(
        r#"
        INSERT INTO api_keys
            (organization_id, user_id, created_by, name, key_hash, key_preview,
             key_type, scopes, expires_at, rate_limit_per_min)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, created_at
        "#,
    )
    .bind(acting_org)
    .bind(act_as)
    .bind(ctx.user_id)
    .bind(name)
    .bind(&key_hash)
    .bind(&key_preview)
    .bind(key_type)
    .bind(&data.scopes)
    .bind(data.expires_at)
    .bind(rate_limit)
    .fetch_one(pool.get_ref())
    .await;

    match inserted {
        Ok(row) => {
            let id: i32 = row.get("id");
            let created_at: DateTime<Utc> = row.get("created_at");
            info!(target: "auth", actor = ctx.user_id, key_id = id, act_as, key_type, "api key created");
            HttpResponse::Created().json(serde_json::json!({
                "id": id,
                "name": name,
                "key_type": key_type,
                "scopes": data.scopes,
                "key_preview": key_preview,
                "user_id": act_as,
                "organization_id": acting_org,
                "rate_limit_per_min": rate_limit,
                "expires_at": data.expires_at,
                "created_at": created_at,
                "api_key": raw_key,
            }))
        }
        Err(e) => {
            error!(target: "db", error = ?e, "api key insert failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}

#[get("/keys")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_api_keys(req: HttpRequest, pool: web::Data<PgPool>) -> impl Responder {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };

    let result = match ctx.scope {
        Scope::Platform => {
            sqlx::query_as::<_, ApiKeyView>(&format!(
                "SELECT {KEY_COLUMNS} FROM api_keys ORDER BY created_at DESC"
            ))
            .fetch_all(pool.get_ref())
            .await
        }
        Scope::Organization => {
            sqlx::query_as::<_, ApiKeyView>(&format!(
                "SELECT {KEY_COLUMNS} FROM api_keys
                 WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)
                    OR created_by = $2
                 ORDER BY created_at DESC"
            ))
            .bind(ctx.organization_id)
            .bind(ctx.user_id)
            .fetch_all(pool.get_ref())
            .await
        }
        Scope::Personal => {
            sqlx::query_as::<_, ApiKeyView>(&format!(
                "SELECT {KEY_COLUMNS} FROM api_keys
                 WHERE created_by = $1 OR user_id = $1
                 ORDER BY created_at DESC"
            ))
            .bind(ctx.user_id)
            .fetch_all(pool.get_ref())
            .await
        }
    };

    match result {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(e) => {
            error!(target: "db", error = ?e, "api key list failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}

#[delete("/keys/{id}")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn revoke_api_key(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> impl Responder {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let key_id = path.into_inner();

    match key_in_caller_scope(pool.get_ref(), &ctx, key_id).await {
        Ok(true) => {}
        Ok(false) => {
            return HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "Key not found" }));
        }
        Err(e) => {
            error!(target: "db", error = ?e, "api key scope check failed");
            return HttpResponse::InternalServerError().finish();
        }
    }

    match sqlx::query("UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL")
        .bind(key_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(result) if result.rows_affected() == 0 => HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Key not found or already revoked" })),
        Ok(_) => {
            info!(target: "auth", actor = ctx.user_id, key_id, "api key revoked");
            HttpResponse::Ok().json(serde_json::json!({ "revoked": true }))
        }
        Err(e) => {
            error!(target: "db", error = ?e, "api key revoke failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}

#[get("/keys/{id}/audit")]
#[instrument(target = "http", skip(req, pool))]
pub async fn api_key_audit(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> impl Responder {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let key_id = path.into_inner();

    match key_in_caller_scope(pool.get_ref(), &ctx, key_id).await {
        Ok(true) => {}
        Ok(false) => {
            return HttpResponse::NotFound()
                .json(serde_json::json!({ "message": "Key not found" }));
        }
        Err(e) => {
            error!(target: "db", error = ?e, "api key scope check failed");
            return HttpResponse::InternalServerError().finish();
        }
    }

    match sqlx::query_as::<_, AuditView>(
        r#"
        SELECT id, api_key_id, method, path, status_code, outcome, ip, created_at
        FROM api_key_audit_log
        WHERE api_key_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        "#,
    )
    .bind(key_id)
    .bind(AUDIT_PAGE_LIMIT)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(e) => {
            error!(target: "db", error = ?e, "api key audit fetch failed");
            HttpResponse::InternalServerError().finish()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::Cache;
    use crate::middleware::api_key::ApiKeyMiddleware;
    use crate::security::api_key::{AuditEntry, AuditOutcome, write_audit};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test};

    /// Mounted at `/api/notes`: succeeds only if the request authenticated —
    /// proves the middleware injected an `ApiKeyPrincipal` that
    /// `get_user_id_from_request` can read.
    async fn echo_user(req: HttpRequest) -> HttpResponse {
        match crate::security::jwt::get_user_id_from_request(&req) {
            Some(uid) => HttpResponse::Ok().json(serde_json::json!({ "user_id": uid })),
            None => HttpResponse::Unauthorized().finish(),
        }
    }

    async fn insert_test_key(
        pool: &PgPool,
        user_id: i32,
        raw: &str,
        scopes: &[&str],
        expires_at: Option<DateTime<Utc>>,
        revoked: bool,
    ) -> i32 {
        let scope_vec: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO api_keys
                 (user_id, name, key_hash, key_preview, key_type, scopes,
                  expires_at, rate_limit_per_min, revoked_at)
             VALUES ($1, 'test key', $2, 'wv_sk_..._test', 'external', $3, $4, 120,
                     CASE WHEN $5 THEN NOW() ELSE NULL END)
             RETURNING id",
        )
        .bind(user_id)
        .bind(hash_api_key(raw))
        .bind(&scope_vec)
        .bind(expires_at)
        .bind(revoked)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("insert test key: {e}"))
    }

    #[actix_web::test]
    async fn api_key_middleware_enforces_scope_revoke_and_expiry() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;

        let future = Utc::now() + chrono::Duration::hours(1);
        let past = Utc::now() - chrono::Duration::hours(1);

        let good = "wv_sk_good_scope_key_for_tests";
        let wrong = "wv_sk_wrong_scope_key_for_tests";
        let expired = "wv_sk_expired_key_for_tests";
        let revoked = "wv_sk_revoked_key_for_tests";

        insert_test_key(&pool, user_id, good, &["notes:read"], Some(future), false).await;
        insert_test_key(&pool, user_id, wrong, &["email:read"], Some(future), false).await;
        insert_test_key(&pool, user_id, expired, &["notes:read"], Some(past), false).await;
        insert_test_key(&pool, user_id, revoked, &["notes:read"], Some(future), true).await;

        let app = actix_test::init_service(
            App::new()
                .wrap(ApiKeyMiddleware)
                .app_data(web::Data::new(pool.clone()))
                .app_data(web::Data::new(None::<Cache>))
                .route("/api/notes", web::get().to(echo_user)),
        )
        .await;

        let call = |key: &str| {
            actix_test::TestRequest::get()
                .uri("/api/notes")
                .insert_header(("X-API-KEY", key))
                .to_request()
        };

        // A key with notes:read reaches the handler.
        let resp = actix_test::call_service(&app, call(good)).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // A key without notes:read is rejected by the scope check.
        let resp = actix_test::call_service(&app, call(wrong)).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Expired / revoked / unknown keys are all rejected at validation.
        let resp = actix_test::call_service(&app, call(expired)).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let resp = actix_test::call_service(&app, call(revoked)).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let resp = actix_test::call_service(&app, call("wv_sk_no_such_key")).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // No API key at all → the handler runs with no principal.
        let resp = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri("/api/notes")
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let _ = sqlx::query("DELETE FROM api_keys WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
    }

    #[actix_web::test]
    async fn write_audit_persists_a_row() {
        let pool = test_pool().await;
        let user_id = insert_local_user(&pool, &random_email(), "password123").await;
        let key_id = insert_test_key(
            &pool,
            user_id,
            "wv_sk_audit_persist_test_key",
            &["notes:read"],
            Some(Utc::now() + chrono::Duration::hours(1)),
            false,
        )
        .await;

        write_audit(
            &pool,
            &AuditEntry {
                api_key_id: Some(key_id),
                user_id: Some(user_id),
                method: "GET".to_string(),
                path: "/api/notes".to_string(),
                status_code: 200,
                outcome: AuditOutcome::Allowed,
                ip: Some("127.0.0.1".to_string()),
            },
        )
        .await;

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM api_key_audit_log \
             WHERE api_key_id = $1 AND outcome = 'allowed'",
        )
        .bind(key_id)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| panic!("audit count: {e}"));
        assert_eq!(count, 1);

        let _ = sqlx::query("DELETE FROM api_keys WHERE user_id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await;
    }
}
