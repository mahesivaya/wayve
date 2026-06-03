// Access requests for locked resources (the Test Access page is the first one).
//
// A user clicks "Request access"; the request is routed to a support team by
// the requester's scope: personal/platform users → the platform support team,
// an organization member → that organization's support team. Staff with the
// `tickets:manage` permission (the `support` role, plus owner/admin/super_admin)
// review the queue and approve or deny. Once approved, the locked `data` is
// returned to the requester. Both sides attach free-text explanations
// (`request_note` from the requester, `decision_note` from support).

use crate::prelude::*;
use actix_web::patch;
use chrono::{DateTime, Utc};
use tracing::{info, instrument};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope};

const DEFAULT_RESOURCE: &str = "test_access";
const ALLOWED_DECISIONS: &[&str] = &["approved", "denied"];

// Sample payload revealed once a request for `test_access` is approved. A real
// resource would fetch the actual protected content here.
const TEST_ACCESS_SECRET: &str =
    "🔓 Unlocked: this is the protected sample dataset for the Test Access page. \
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

// POST /access-requests — create a pending request routed by the caller's
// scope, or (if an active request already exists) update its explanation.
#[post("/access-requests")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn create_access_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<CreateAccessRequestBody>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let ctx = rbac::resolve_role_context(pool.get_ref(), user_id)
        .await
        .map_err(|_| AppError::internal("role resolution failed"))?;

    let resource = clean_resource(&body.resource);
    let note = clean_note(&body.note);

    // Personal and platform users are handled by the platform support team;
    // organization members by their own organization's support team.
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

    Ok(HttpResponse::Ok().json(row))
}

// GET /access-requests/me?resource=test_access — the caller's current status
// for a resource, plus the unlocked `data` only when approved.
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

// GET /access-requests/admin?status= — the support queue for the caller's
// team. Platform staff see platform-targeted requests; an org staffer sees
// only their own organization's requests.
#[get("/access-requests/admin")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn admin_list_access_requests(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<AdminListQuery>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::TicketsManage).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };

    let status_filter = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // Personal scope has no support queue (even though an owner technically
    // holds the permission) — return an empty list rather than leaking rows.
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

// PATCH /access-requests/admin/{id} — approve or deny a request in the
// caller's queue, attaching a decision note.
#[patch("/access-requests/admin/{id}")]
#[instrument(target = "http", skip(req, pool, path, body))]
pub async fn admin_decide_access_request(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<DecisionBody>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::TicketsManage).await {
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

    let updated: Option<i32> = sqlx::query_scalar(
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
        RETURNING id
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

    updated.ok_or(AppError::NotFound("access request"))?;

    info!(
        target: "http",
        user_id, request_id, status,
        "access request decided"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": request_id,
        "status": status,
    })))
}
