//! Access requests for locked resources. A request is routed to a support team
//! by the requester's scope: personal and platform users to the platform support
//! team, an organization member to their own organization's team. Staff holding
//! `tickets:manage` review the queue and approve or deny; approval returns the
//! locked `data` to the requester.

use crate::prelude::*;
use actix_web::patch;
use chrono::{DateTime, Utc};
use tokio::io::AsyncWriteExt;
use tracing::{info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope};

const DEFAULT_RESOURCE: &str = "test_access";
const ALLOWED_DECISIONS: &[&str] = &["approved", "denied"];

// Append-only audit log of every access-request event, one JSON object per line
// so `/history` can read it back and scope each line to the caller's support
// team. The path is relative to the backend's WORKDIR, where `logs/` is
// bind-mounted to the repo-root `logs/`.
const ACCESS_LOG_DIR: &str = "logs";
const ACCESS_LOG_PATH: &str = "logs/access_requests.log";

/// Best-effort: a deleted user logs as null rather than failing the request.
async fn email_of(pool: &PgPool, user_id: i32) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// Best-effort: logging must never break the request, so failures are swallowed.
async fn append_event(event: serde_json::Value) {
    let line = match serde_json::to_string(&event) {
        Ok(s) => s,
        Err(err) => {
            warn!(target: "http", error = ?err, "access-request log serialize failed");
            return;
        }
    };
    let _ = tokio::fs::create_dir_all(ACCESS_LOG_DIR).await;
    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ACCESS_LOG_PATH)
        .await
    {
        Ok(mut file) => {
            if let Err(err) = file.write_all(format!("{line}\n").as_bytes()).await {
                warn!(target: "http", error = ?err, "access-request log write failed");
            }
        }
        Err(err) => warn!(target: "http", error = ?err, "access-request log open failed"),
    }
}

// Sample payload revealed once a `test_access` request is approved. A real
// resource would fetch the actual protected content here.
const TEST_ACCESS_SECRET: &str = "🔓 Unlocked: this is the protected sample dataset for the Test Access page. \
     Quarterly figures, internal notes, and the confidential roadmap would live here.";

#[derive(Serialize, FromRow)]
pub struct AccessRequest {
    pub id: i32,
    pub user_id: i32,
    pub resource: String,
    pub target_scope: String,
    pub organization_id: Option<i32>,
    pub status: String,
    pub request_note: Option<String>,
    pub decision_note: Option<String>,
    pub decided_by: Option<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, FromRow)]
pub struct AccessRequestView {
    pub id: i32,
    pub user_id: i32,
    pub user_email: Option<String>,
    pub resource: String,
    pub target_scope: String,
    pub organization_id: Option<i32>,
    pub organization_name: Option<String>,
    pub status: String,
    pub request_note: Option<String>,
    pub decision_note: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct CreateAccessRequestBody {
    pub resource: Option<String>,
    pub note: Option<String>,
}

#[derive(Deserialize)]
pub struct DecisionBody {
    pub status: String,
    pub note: Option<String>,
}

#[derive(Deserialize)]
pub struct ResourceQuery {
    pub resource: Option<String>,
}

#[derive(Deserialize)]
pub struct AdminListQuery {
    pub status: Option<String>,
}

fn clean_resource(value: &Option<String>) -> String {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_RESOURCE)
        .to_string()
}

fn clean_note(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Create a pending request routed by the caller's scope, or update the
/// explanation on an already-active request.
#[post("/access-requests")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn create_access_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<CreateAccessRequestBody>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let ctx = rbac::resolve_role_context_moded(&req, pool.get_ref(), user_id)
        .await
        .map_err(|_| AppError::internal("role resolution failed"))?;

    let resource = clean_resource(&body.resource);
    let note = clean_note(&body.note);

    let (target_scope, organization_id) = match ctx.scope {
        Scope::Organization => ("organization", ctx.organization_id),
        _ => ("platform", None),
    };

    let row = sqlx::query_as::<_, AccessRequest>(
        r#"
        INSERT INTO access_requests
            (user_id, resource, target_scope, organization_id, request_note)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, resource) WHERE status IN ('pending', 'approved')
        DO UPDATE SET request_note = EXCLUDED.request_note, updated_at = NOW()
        RETURNING id, user_id, resource, target_scope, organization_id, status,
                  request_note, decision_note, decided_by,
                  created_at, updated_at, decided_at
        "#,
    )
    .bind(user_id)
    .bind(&resource)
    .bind(target_scope)
    .bind(organization_id)
    .bind(note.as_deref())
    .fetch_one(pool.get_ref())
    .await?;

    info!(
        target: "http",
        user_id, request_id = row.id, target_scope, resource = %resource,
        "access request submitted"
    );

    // A fresh insert has created_at == updated_at; an upsert bumped updated_at,
    // so it is an explanation edit.
    let event = if row.created_at == row.updated_at {
        "requested"
    } else {
        "updated"
    };
    append_event(serde_json::json!({
        "ts": Utc::now().to_rfc3339(),
        "event": event,
        "request_id": row.id,
        "actor_email": email_of(pool.get_ref(), user_id).await,
        "requester_email": email_of(pool.get_ref(), row.user_id).await,
        "resource": row.resource,
        "target_scope": row.target_scope,
        "organization_id": row.organization_id,
        "status": row.status,
        "note": row.request_note,
    }))
    .await;

    Ok(HttpResponse::Ok().json(row))
}

/// The caller's current status for a resource. The unlocked `data` is present
/// only once the request is approved.
#[get("/access-requests/me")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn my_access_status(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<ResourceQuery>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let resource = clean_resource(&query.resource);

    let row = sqlx::query_as::<_, AccessRequest>(
        r#"
        SELECT id, user_id, resource, target_scope, organization_id, status,
               request_note, decision_note, decided_by,
               created_at, updated_at, decided_at
        FROM access_requests
        WHERE user_id = $1 AND resource = $2
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .bind(&resource)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(row) = row else {
        return Ok(HttpResponse::Ok().json(serde_json::json!({
            "status": "none",
            "target": serde_json::Value::Null,
            "request_note": serde_json::Value::Null,
            "decision_note": serde_json::Value::Null,
        })));
    };

    let data = if row.status == "approved" && row.resource == DEFAULT_RESOURCE {
        Some(TEST_ACCESS_SECRET)
    } else {
        None
    };

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "status": row.status,
        "target": row.target_scope,
        "request_note": row.request_note,
        "decision_note": row.decision_note,
        "data": data,
    })))
}

/// The support queue for the caller's own team: platform staff see
/// platform-targeted requests, an org staffer only their own organization's.
#[get("/access-requests/admin")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn admin_list_access_requests(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<AdminListQuery>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::TicketsManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let status_filter = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // A personal owner technically holds the permission but has no support queue,
    // so return an empty list rather than leaking rows.
    let (scope_str, org_id) = match ctx.scope {
        Scope::Platform => ("platform", None),
        Scope::Organization => ("organization", ctx.organization_id),
        Scope::Personal => return Ok(HttpResponse::Ok().json(Vec::<AccessRequestView>::new())),
    };

    let rows = sqlx::query_as::<_, AccessRequestView>(
        r#"
        SELECT a.id, a.user_id, u.email AS user_email,
               a.resource, a.target_scope, a.organization_id,
               o.name AS organization_name,
               a.status, a.request_note, a.decision_note,
               a.created_at, a.updated_at, a.decided_at
        FROM access_requests a
        LEFT JOIN users u ON u.id = a.user_id
        LEFT JOIN organizations o ON o.id = a.organization_id
        WHERE (
                ($1 = 'platform' AND a.target_scope = 'platform')
                OR ($1 = 'organization' AND a.organization_id = $2)
            )
            AND ($3::TEXT IS NULL OR a.status = $3)
        ORDER BY
            CASE a.status
                WHEN 'pending' THEN 0
                WHEN 'approved' THEN 1
                WHEN 'denied' THEN 2
                ELSE 3
            END,
            a.created_at DESC
        LIMIT 500
        "#,
    )
    .bind(scope_str)
    .bind(org_id)
    .bind(status_filter)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows))
}

/// Approve or deny a request. The UPDATE's scope clause confines the caller to
/// their own queue, and a request outside it 404s rather than 403s.
#[patch("/access-requests/admin/{id}")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn admin_decide_access_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<DecisionBody>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::TicketsManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let user_id = ctx.user_id;
    let request_id = path.into_inner();

    let status = body.status.trim();
    if !ALLOWED_DECISIONS.contains(&status) {
        return Err(AppError::BadRequest(format!("invalid status '{status}'")));
    }
    let note = clean_note(&body.note);

    let (scope_str, org_id) = match ctx.scope {
        Scope::Platform => ("platform", None),
        Scope::Organization => ("organization", ctx.organization_id),
        Scope::Personal => return Err(AppError::NotFound("access request")),
    };

    let updated: Option<(i32, Option<i32>, String, String)> = sqlx::query_as(
        r#"
        UPDATE access_requests
        SET status = $2,
            decision_note = $3,
            decided_by = $4,
            decided_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND (
                ($5 = 'platform' AND target_scope = 'platform')
                OR ($5 = 'organization' AND organization_id = $6)
          )
        RETURNING user_id, organization_id, target_scope, resource
        "#,
    )
    .bind(request_id)
    .bind(status)
    .bind(note.as_deref())
    .bind(user_id)
    .bind(scope_str)
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let (requester_id, req_org_id, req_target_scope, req_resource) =
        updated.ok_or(AppError::NotFound("access request"))?;

    info!(
        target: "http",
        user_id, request_id, status,
        "access request decided"
    );

    append_event(serde_json::json!({
        "ts": Utc::now().to_rfc3339(),
        "event": status,
        "request_id": request_id,
        "actor_email": email_of(pool.get_ref(), user_id).await,
        "requester_email": email_of(pool.get_ref(), requester_id).await,
        "resource": req_resource,
        "target_scope": req_target_scope,
        "organization_id": req_org_id,
        "status": status,
        "note": note,
    }))
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": request_id,
        "status": status,
    })))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<usize>,
}

/// The support team's audit history, read back from the JSON-lines log and
/// scoped to the caller's own team. Most recent first.
#[get("/access-requests/history")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn access_request_history(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<HistoryQuery>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::TicketsManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let limit = query.limit.unwrap_or(200).min(1000);

    // A personal owner holds the permission but has no team.
    let (scope_str, org_id) = match ctx.scope {
        Scope::Platform => ("platform", None),
        Scope::Organization => ("organization", ctx.organization_id),
        Scope::Personal => return Ok(HttpResponse::Ok().json(Vec::<Value>::new())),
    };

    // A missing file means no events yet, not an error.
    let contents = tokio::fs::read_to_string(ACCESS_LOG_PATH)
        .await
        .unwrap_or_default();

    let mut entries: Vec<Value> = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| match scope_str {
            "platform" => entry.get("target_scope").and_then(Value::as_str) == Some("platform"),
            _ => entry.get("organization_id").and_then(Value::as_i64) == org_id.map(i64::from),
        })
        .collect();

    entries.reverse();
    entries.truncate(limit);

    Ok(HttpResponse::Ok().json(entries))
}

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(create_access_request)
        .service(my_access_status)
        .service(admin_list_access_requests)
        .service(admin_decide_access_request)
        .service(access_request_history);
}
