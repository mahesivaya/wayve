//! Organization-scoped projects and teams shown in the app sidebar.
//!
//! Listing is available to any member of an organization (a personal or
//! platform account with no home org sees an empty list). Creation is locked
//! to the organization OWNER via [`rbac::require_owner`] — matching the
//! product rule "only an org owner can create new projects and teams".

use crate::prelude::*;
use actix_web::patch;
use sqlx::Row;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Scope};

#[derive(Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
}

#[derive(Deserialize)]
pub struct UpdateProjectInput {
    pub name: String,
}

#[derive(Deserialize)]
pub struct CreateTeamInput {
    pub name: String,
    pub tagline: Option<String>,
    pub description: Option<String>,
}

const NAME_MAX: usize = 120;
const TAGLINE_MAX: usize = 200;
const DESCRIPTION_MAX: usize = 2000;

/// Lowercase, ASCII-alphanumeric slug — mirrors the org slug rule in init.sql.
fn slugify(name: &str) -> String {
    let slug: String = name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else {
                None
            }
        })
        .collect();
    if slug.is_empty() {
        "team".to_string()
    } else {
        slug
    }
}

/// First slug of the form `base`, `base-2`, `base-3`, … not already present in
/// `taken`. Keeps team slugs unique within an org without relying on a retry
/// loop against the unique constraint.
fn pick_free_slug(base: &str, taken: &[String]) -> String {
    if !taken.contains(&base.to_string()) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The caller's home organization id, or `None` for personal / platform
/// accounts that don't belong to one.
async fn caller_org_id(req: &HttpRequest, pool: &PgPool) -> Result<Option<i32>, AppError> {
    let Some(user_id) = get_user_id_from_request(req) else {
        return Err(AppError::Unauthorized);
    };
    let ctx = rbac::resolve_role_context(pool, user_id)
        .await
        .map_err(AppError::Db)?;
    Ok(ctx.organization_id)
}

// GET /api/projects — projects for the caller's org, newest first.
#[get("/projects")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_projects(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let Some(org_id) = caller_org_id(&req, pool.get_ref()).await? else {
        return Ok(HttpResponse::Ok().json(serde_json::json!([])));
    };

    let rows = sqlx::query(
        "SELECT id, name, created_at
         FROM projects
         WHERE organization_id = $1
         ORDER BY created_at DESC, id DESC",
    )
    .bind(org_id)
    .fetch_all(pool.get_ref())
    .await?;

    let projects: Vec<_> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.get::<i32, _>("id"),
                "name": row.get::<String, _>("name"),
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(projects))
}

// POST /api/projects — create a project (org owner only).
#[post("/projects")]
#[instrument(target = "http", skip(req, pool, input))]
pub async fn create_project(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    input: web::Json<CreateProjectInput>,
) -> AppResult {
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Organization {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only an organization owner can create projects"
        })));
    }
    let Some(org_id) = ctx.organization_id else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "No organization in context" })));
    };

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Project name is required" })));
    }
    if name.len() > NAME_MAX {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Project name is too long" })));
    }

    let row = sqlx::query(
        "INSERT INTO projects (organization_id, name, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, name",
    )
    .bind(org_id)
    .bind(name)
    .bind(ctx.user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
    })))
}

// PATCH /api/projects/{id} — rename a project (org owner only).
#[patch("/projects/{id}")]
#[instrument(target = "http", skip(req, pool, path, input))]
pub async fn update_project(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    input: web::Json<UpdateProjectInput>,
) -> AppResult {
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Organization {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only an organization owner can rename projects"
        })));
    }
    let Some(org_id) = ctx.organization_id else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "No organization in context" })));
    };

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Project name is required" })));
    }
    if name.len() > NAME_MAX {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Project name is too long" })));
    }

    // Org-scoped UPDATE — a project from another org won't match, so we 404
    // rather than leak that the id exists.
    let row = sqlx::query(
        "UPDATE projects SET name = $1
         WHERE id = $2 AND organization_id = $3
         RETURNING id, name",
    )
    .bind(name)
    .bind(path.into_inner())
    .bind(org_id)
    .fetch_optional(pool.get_ref())
    .await?;

    match row {
        Some(row) => Ok(HttpResponse::Ok().json(serde_json::json!({
            "id": row.get::<i32, _>("id"),
            "name": row.get::<String, _>("name"),
        }))),
        None => Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Project not found" }))),
    }
}

// GET /api/teams — teams for the caller's org, newest first.
#[get("/teams")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_teams(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let Some(org_id) = caller_org_id(&req, pool.get_ref()).await? else {
        return Ok(HttpResponse::Ok().json(serde_json::json!([])));
    };

    let rows = sqlx::query(
        "SELECT id, name, slug, tagline, description, created_at
         FROM teams
         WHERE organization_id = $1
         ORDER BY created_at DESC, id DESC",
    )
    .bind(org_id)
    .fetch_all(pool.get_ref())
    .await?;

    let teams: Vec<_> = rows.into_iter().map(team_summary_json).collect();
    Ok(HttpResponse::Ok().json(teams))
}

// GET /api/teams/{slug} — one team in the caller's org (for the detail page).
#[get("/teams/{slug}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn get_team(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<String>,
) -> AppResult {
    let slug = path.into_inner();
    let Some(org_id) = caller_org_id(&req, pool.get_ref()).await? else {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "Team not found" })));
    };

    let row = sqlx::query(
        "SELECT id, name, slug, tagline, description, created_at
         FROM teams
         WHERE organization_id = $1 AND slug = $2",
    )
    .bind(org_id)
    .bind(&slug)
    .fetch_optional(pool.get_ref())
    .await?;

    match row {
        Some(row) => Ok(HttpResponse::Ok().json(team_summary_json(row))),
        None => {
            Ok(HttpResponse::NotFound().json(serde_json::json!({ "message": "Team not found" })))
        }
    }
}

// POST /api/teams — create a team (org owner only).
#[post("/teams")]
#[instrument(target = "http", skip(req, pool, input))]
pub async fn create_team(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    input: web::Json<CreateTeamInput>,
) -> AppResult {
    let ctx = match rbac::require_owner(&req, pool.get_ref()).await {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Organization {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only an organization owner can create teams"
        })));
    }
    let Some(org_id) = ctx.organization_id else {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "No organization in context" })));
    };

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Team name is required" })));
    }
    if name.len() > NAME_MAX {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Team name is too long" })));
    }
    let tagline = clean_optional(input.tagline.as_deref(), TAGLINE_MAX);
    let description = clean_optional(input.description.as_deref(), DESCRIPTION_MAX);

    // Choose a slug unique within the org before inserting.
    let base = slugify(name);
    let taken: Vec<String> = sqlx::query_scalar(
        "SELECT slug FROM teams WHERE organization_id = $1 AND (slug = $2 OR slug LIKE $2 || '-%')",
    )
    .bind(org_id)
    .bind(&base)
    .fetch_all(pool.get_ref())
    .await?;
    let slug = pick_free_slug(&base, &taken);

    let row = sqlx::query(
        "INSERT INTO teams (organization_id, name, slug, tagline, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, slug, tagline, description, created_at",
    )
    .bind(org_id)
    .bind(name)
    .bind(&slug)
    .bind(tagline.as_deref())
    .bind(description.as_deref())
    .bind(ctx.user_id)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Created().json(team_summary_json(row)))
}

fn clean_optional(value: Option<&str>, max: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(max).collect())
}

fn team_summary_json(row: sqlx::postgres::PgRow) -> serde_json::Value {
    serde_json::json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "slug": row.get::<String, _>("slug"),
        "tagline": row.get::<Option<String>, _>("tagline"),
        "description": row.get::<Option<String>, _>("description"),
    })
}
