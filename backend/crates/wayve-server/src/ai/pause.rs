//! Pausing AI for an organization or for single members of it.
//!
//! Three switches, any of which stops a user's AI:
//! - `organizations.ai_paused_by_platform`: set by the platform owner for any
//!   organization. The organization's owner cannot lift it.
//! - `organizations.ai_paused`: set by the organization's owner for everyone
//!   in it, the owner included.
//! - `users.ai_paused`: set by the organization's owner for one member.
//!
//! Enforcement is in `provider::resolve_ai_for_user`, which resolves nothing
//! for a paused user, so every feature that asks for the user's AI is covered
//! without knowing about pausing. The chat and email-assist endpoints ask
//! `pause_reason` first so they can say why instead of "not configured".
//!
//! Platform automations that run on the platform's own AI regardless of the
//! user (ticket triage and the like) are not user AI and are not paused.

use crate::ai::config_handler::{AiOwner, require_ai_owner};
use crate::prelude::*;
use actix_web::put;
use sqlx::Row;
use tracing::{info, instrument};
use wayve_security::jwt::get_user_id_from_request;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_pause)
        .service(put_org_pause)
        .service(put_member_pause)
        .service(put_platform_org_pause);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseReason {
    /// The platform paused the user's organization.
    Platform,
    /// The organization's owner paused the whole organization.
    Organization,
    /// The organization's owner paused this member.
    Member,
}

impl PauseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            PauseReason::Platform => "platform",
            PauseReason::Organization => "organization",
            PauseReason::Member => "member",
        }
    }

    /// What the paused user is told.
    pub fn message(self) -> &'static str {
        match self {
            PauseReason::Platform => {
                "AI is paused for your organization by the platform. Contact support to have it \
                 switched back on."
            }
            PauseReason::Organization => {
                "AI is paused for your organization. Ask your organization's owner to switch it \
                 back on."
            }
            PauseReason::Member => {
                "AI is paused for your account. Ask your organization's owner to switch it back \
                 on."
            }
        }
    }

    pub fn response(self) -> HttpResponse {
        HttpResponse::Forbidden().json(serde_json::json!({
            "error": self.message(),
            "ai_paused": self.as_str(),
        }))
    }
}

/// Why this user's AI is paused, or `None` when it is not. The widest pause is
/// reported, since that is the one that has to be lifted first. A member's own
/// pause only counts while they belong to an organization.
pub async fn pause_reason(pool: &PgPool, user_id: i32) -> sqlx::Result<Option<PauseReason>> {
    let row: Option<(bool, bool, bool)> = sqlx::query_as(
        "SELECT COALESCE(o.ai_paused_by_platform, FALSE),
                COALESCE(o.ai_paused, FALSE),
                (u.ai_paused AND u.organization_id IS NOT NULL)
           FROM users u
           LEFT JOIN organizations o ON o.id = u.organization_id
          WHERE u.id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(match row {
        Some((true, _, _)) => Some(PauseReason::Platform),
        Some((_, true, _)) => Some(PauseReason::Organization),
        Some((_, _, true)) => Some(PauseReason::Member),
        _ => None,
    })
}

#[derive(Deserialize)]
pub struct PauseBody {
    pub paused: bool,
}

#[derive(Deserialize)]
pub struct OrgSearch {
    /// Narrows the platform owner's organization list by name.
    pub q: Option<String>,
}

/// How many organizations the platform owner's list returns at once. Paused
/// ones come first, so they are never pushed off the end; the search finds
/// the rest.
const ORG_LIST_LIMIT: i64 = 50;

/// The owner's view of the switches: an organization's owner gets its own
/// organization and members, the platform owner gets the organizations.
#[get("/ai/pause")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn get_pause(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<OrgSearch>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = require_ai_owner(&req, pool.get_ref(), user_id).await?;

    match owner {
        AiOwner::Org(org_id) => {
            let (paused, paused_by_platform): (bool, bool) = sqlx::query_as(
                "SELECT ai_paused, ai_paused_by_platform FROM organizations WHERE id = $1",
            )
            .bind(org_id)
            .fetch_one(pool.get_ref())
            .await?;
            let members: Vec<Value> = sqlx::query(
                "SELECT u.id,
                        COALESCE(
                            NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
                            u.username, u.email
                        ) AS name,
                        COALESCE(NULLIF(TRIM(u.username), ''), u.email) AS username,
                        u.ai_paused
                   FROM users u
                  WHERE u.organization_id = $1
                  ORDER BY u.ai_paused DESC, name
                  LIMIT 500",
            )
            .bind(org_id)
            .fetch_all(pool.get_ref())
            .await?
            .iter()
            .map(|r| {
                serde_json::json!({
                    "user_id": r.get::<i32, _>("id"),
                    "name": r.get::<Option<String>, _>("name").unwrap_or_default(),
                    "username": r.get::<Option<String>, _>("username").unwrap_or_default(),
                    "paused": r.get::<bool, _>("ai_paused"),
                })
            })
            .collect();
            Ok(HttpResponse::Ok().json(serde_json::json!({
                "scope": "organization",
                "paused": paused,
                "paused_by_platform": paused_by_platform,
                "members": members,
            })))
        }
        AiOwner::Platform => {
            let q = query.q.as_deref().map(str::trim).unwrap_or("");
            // Escaped so a typed % or _ matches itself.
            let pattern = format!(
                "%{}%",
                q.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            );
            let organizations: Vec<Value> = sqlx::query(
                "SELECT o.id, o.name, o.ai_paused, o.ai_paused_by_platform,
                        (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id)::bigint
                            AS members
                   FROM organizations o
                  WHERE o.name ILIKE $1
                  ORDER BY o.ai_paused_by_platform DESC, o.name
                  LIMIT $2",
            )
            .bind(&pattern)
            .bind(ORG_LIST_LIMIT)
            .fetch_all(pool.get_ref())
            .await?
            .iter()
            .map(|r| {
                serde_json::json!({
                    "id": r.get::<i32, _>("id"),
                    "name": r.get::<String, _>("name"),
                    "members": r.get::<i64, _>("members"),
                    "paused": r.get::<bool, _>("ai_paused_by_platform"),
                    "paused_by_owner": r.get::<bool, _>("ai_paused"),
                })
            })
            .collect();
            Ok(HttpResponse::Ok().json(serde_json::json!({
                "scope": "platform",
                "organizations": organizations,
                "limit": ORG_LIST_LIMIT,
            })))
        }
    }
}

/// `target` is the audited resource: its type and its id.
async fn audit(
    pool: &PgPool,
    req: &HttpRequest,
    actor_user_id: i32,
    target: (&'static str, i32),
    paused: bool,
) {
    crate::audit::record_action(
        pool,
        req,
        crate::audit::AuditEvent {
            actor_user_id,
            action: if paused { "ai.pause" } else { "ai.resume" },
            resource_type: target.0,
            resource_id: Some(target.1.to_string()),
            metadata: None,
        },
    )
    .await;
}

/// An organization's owner pauses or resumes AI for the whole organization.
#[put("/ai/pause")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_org_pause(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<PauseBody>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let AiOwner::Org(org_id) = require_ai_owner(&req, pool.get_ref(), user_id).await? else {
        // The platform owner pauses organizations by id, not "its own".
        return Err(AppError::Forbidden);
    };

    sqlx::query("UPDATE organizations SET ai_paused = $1 WHERE id = $2")
        .bind(body.paused)
        .bind(org_id)
        .execute(pool.get_ref())
        .await?;
    audit(
        pool.get_ref(),
        &req,
        user_id,
        ("organization", org_id),
        body.paused,
    )
    .await;
    info!(target: "worker", user_id, org_id, paused = body.paused, "organization ai pause set");
    Ok(HttpResponse::Ok().json(serde_json::json!({ "paused": body.paused })))
}

/// An organization's owner pauses or resumes AI for one of its members.
#[put("/ai/pause/members/{user_id}")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_member_pause(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<PauseBody>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let AiOwner::Org(org_id) = require_ai_owner(&req, pool.get_ref(), user_id).await? else {
        return Err(AppError::Forbidden);
    };
    let member_id = path.into_inner();

    // The organization is part of the predicate, so an owner can only ever
    // reach its own members; anyone else is simply not found.
    let updated =
        sqlx::query("UPDATE users SET ai_paused = $1 WHERE id = $2 AND organization_id = $3")
            .bind(body.paused)
            .bind(member_id)
            .bind(org_id)
            .execute(pool.get_ref())
            .await?
            .rows_affected();
    if updated == 0 {
        return Err(AppError::NotFound("member"));
    }
    audit(
        pool.get_ref(),
        &req,
        user_id,
        ("user", member_id),
        body.paused,
    )
    .await;
    info!(target: "worker", user_id, org_id, member_id, paused = body.paused, "member ai pause set");
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "user_id": member_id,
        "paused": body.paused,
    })))
}

/// The platform owner pauses or resumes AI for any organization.
#[put("/ai/pause/organizations/{org_id}")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn put_platform_org_pause(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<PauseBody>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let AiOwner::Platform = require_ai_owner(&req, pool.get_ref(), user_id).await? else {
        return Err(AppError::Forbidden);
    };
    let org_id = path.into_inner();

    let updated = sqlx::query("UPDATE organizations SET ai_paused_by_platform = $1 WHERE id = $2")
        .bind(body.paused)
        .bind(org_id)
        .execute(pool.get_ref())
        .await?
        .rows_affected();
    if updated == 0 {
        return Err(AppError::NotFound("organization"));
    }
    audit(
        pool.get_ref(),
        &req,
        user_id,
        ("organization", org_id),
        body.paused,
    )
    .await;
    info!(target: "worker", user_id, org_id, paused = body.paused, "platform ai pause set for organization");
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": org_id,
        "paused": body.paused,
    })))
}
