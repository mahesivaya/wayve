//! User-configurable task statuses.
//!
//! A status carries two independent things: presentation the user owns (`name`,
//! `description`, `color`, `position`) and a fixed `category` the product owns.
//! Only `category` may drive behaviour — `TERMINAL_CATEGORIES`, the
//! active/completed split, and the Jira/GitLab importers all key off it — so renaming "Done" to
//! "Shipped" stays a cosmetic change. See the `task_statuses` block in
//! `infra/postgres/init.sql`.
//!
//! Statuses are polymorphic-owned like `projects`: an organization member reads
//! and writes their org's shared set; personal and platform accounts get their
//! own. `tasks.status` stores the `slug`, which is why the seeded defaults reuse
//! the four legacy slugs verbatim — existing rows stay valid with no backfill.

use crate::prelude::*;
use actix_web::{delete, put};
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::rbac::{self, Permission, Scope, resolve_role_context};

/// The fixed semantic axis. Order is the board's left-to-right column order and
/// the grouping order on the settings page.
pub const CATEGORIES: [&str; 5] = ["backlog", "planned", "in_progress", "completed", "canceled"];

/// Categories whose tasks are finished and drop off the active list. Everything
/// that used to be `status == "done"` is now expressed against these.
pub const TERMINAL_CATEGORIES: [&str; 2] = ["completed", "canceled"];

const NAME_MAX: usize = 60;
const DESCRIPTION_MAX: usize = 200;
const SLUG_MAX: usize = 40;

/// The four statuses every owner starts with. Slugs match the values that were
/// hardcoded in the old `tasks_status_check`, so seeding is not a migration.
const DEFAULTS: [(&str, &str, &str, &str); 4] = [
    ("to_do", "To Do", "backlog", "#6b7280"),
    ("in_progress", "In Progress", "in_progress", "#4c9aff"),
    ("in_review", "In Review", "in_progress", "#f5a623"),
    ("done", "Done", "completed", "#36b37e"),
];

#[derive(Serialize, FromRow)]
pub struct TaskStatus {
    pub id: i32,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub color: String,
    pub category: String,
    pub position: i32,
    /// How many tasks currently sit on this status, across the whole owning
    /// scope. Drives the "N tasks" line on the settings page and lets the UI warn
    /// before a delete that would need reassignment. Not persisted.
    #[sqlx(default)]
    pub task_count: i64,
}

#[derive(Deserialize)]
pub struct StatusInput {
    pub name: String,
    pub category: String,
    pub description: Option<String>,
    pub color: Option<String>,
}

#[derive(Deserialize)]
pub struct ReorderInput {
    /// Status ids in their new order. Ids the caller doesn't own are ignored.
    pub ids: Vec<i32>,
}

/// Which set of statuses a user reads and writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusOwner {
    Organization(i32),
    User(i32),
}

impl StatusOwner {
    fn org_id(self) -> Option<i32> {
        match self {
            StatusOwner::Organization(id) => Some(id),
            StatusOwner::User(_) => None,
        }
    }

    fn user_id(self) -> Option<i32> {
        match self {
            StatusOwner::Organization(_) => None,
            StatusOwner::User(id) => Some(id),
        }
    }
}

/// Org members share one set; everyone else (personal, platform, and the
/// degenerate org-with-no-id case) gets a per-user set.
pub fn owner_for(scope: Scope, organization_id: Option<i32>, user_id: i32) -> StatusOwner {
    match (scope, organization_id) {
        (Scope::Organization, Some(org_id)) => StatusOwner::Organization(org_id),
        _ => StatusOwner::User(user_id),
    }
}

pub async fn owner_for_user(pool: &PgPool, user_id: i32) -> Result<StatusOwner, AppError> {
    let ctx = resolve_role_context(pool, user_id).await?;
    Ok(owner_for(ctx.scope, ctx.organization_id, user_id))
}

/// Reads the owner's statuses, seeding the defaults on first access.
///
/// Seeding lazily rather than at signup means orgs and users that predate this
/// feature get a workflow the first time anyone opens the board, with no
/// backfill job. The INSERT is `ON CONFLICT DO NOTHING` against the per-owner
/// unique slug index, so two concurrent first-readers can't double-seed.
pub async fn load(pool: &PgPool, owner: StatusOwner) -> Result<Vec<TaskStatus>, AppError> {
    let existing = fetch(pool, owner).await?;
    if !existing.is_empty() {
        return Ok(existing);
    }

    for (position, (slug, name, category, color)) in DEFAULTS.iter().enumerate() {
        sqlx::query(
            "INSERT INTO task_statuses (organization_id, user_id, slug, name, category, color, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT DO NOTHING",
        )
        .bind(owner.org_id())
        .bind(owner.user_id())
        .bind(slug)
        .bind(name)
        .bind(category)
        .bind(color)
        .bind(position as i32)
        .execute(pool)
        .await?;
    }

    fetch(pool, owner).await
}

async fn fetch(pool: &PgPool, owner: StatusOwner) -> Result<Vec<TaskStatus>, AppError> {
    // The count is a correlated subquery rather than a JOIN + GROUP BY so a
    // status with no tasks still comes back (as 0) instead of dropping out.
    let rows = sqlx::query_as::<_, TaskStatus>(
        "SELECT s.id, s.slug, s.name, s.description, s.color, s.category, s.position,
                (SELECT COUNT(*) FROM tasks t
                  WHERE t.status = s.slug
                    AND ($1::INTEGER IS NULL
                         OR t.user_id IN (SELECT id FROM users WHERE organization_id = $1))
                    AND ($2::INTEGER IS NULL OR t.user_id = $2)
                ) AS task_count
         FROM task_statuses s
         WHERE ($1::INTEGER IS NOT NULL AND s.organization_id = $1)
            OR ($2::INTEGER IS NOT NULL AND s.user_id = $2)
         ORDER BY s.position ASC, s.id ASC",
    )
    .bind(owner.org_id())
    .bind(owner.user_id())
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// `category` for a slug within the owner's set, or None if the slug is unknown.
pub async fn category_of(
    pool: &PgPool,
    owner: StatusOwner,
    slug: &str,
) -> Result<Option<String>, AppError> {
    Ok(load(pool, owner)
        .await?
        .into_iter()
        .find(|s| s.slug == slug)
        .map(|s| s.category))
}

/// A snapshot of an owner's category → slug mapping.
///
/// The importers upsert issues in one multi-row statement, so they need to
/// resolve every issue's status inside a synchronous closure. Loading the set
/// once up front and handing that closure a plain lookup keeps the batch a
/// single round-trip instead of one query per issue.
pub struct CategoryResolver {
    /// First status per category, in board order.
    by_category: Vec<(String, String)>,
    /// (category, lowercased name, slug) for every status, for hint matching.
    named: Vec<(String, String, String)>,
    fallback: String,
}

impl CategoryResolver {
    /// The slug an external issue in `category` should land on. Falls back to
    /// the first status in board order when the owner has configured no status
    /// in that category at all — an import must never invent a slug, since the
    /// task would then render as a blank chip nothing can filter.
    pub fn slug_for(&self, category: &str) -> String {
        self.by_category
            .iter()
            .find(|(c, _)| c == category)
            .map(|(_, slug)| slug.clone())
            .unwrap_or_else(|| self.fallback.clone())
    }

    /// Like [`slug_for`], but first tries to match a status in `category` whose
    /// name contains `hint`.
    ///
    /// This preserves a nuance the old hardcoded mapping had for free: Jira's
    /// `indeterminate` category covers both "In Progress" and "In Review", and
    /// the importer used to split them by display name. Categories alone can't
    /// express that, so the foreign status name is passed through as a hint —
    /// an org that kept a review status still gets its issues routed there,
    /// while one that deleted it falls back to the category's first status
    /// instead of importing onto a slug that no longer exists.
    pub fn slug_for_hinted(&self, category: &str, hint: &str) -> String {
        let hint = hint.trim().to_lowercase();
        if !hint.is_empty()
            && let Some(slug) = self
                .named
                .iter()
                .find(|(c, name, _)| c == category && hint.contains(name.as_str()))
                .map(|(_, _, slug)| slug.clone())
        {
            return slug;
        }
        self.slug_for(category)
    }
}

pub async fn category_resolver(
    pool: &PgPool,
    owner: StatusOwner,
) -> Result<CategoryResolver, AppError> {
    let all = load(pool, owner).await?;
    let fallback = all
        .first()
        .map(|s| s.slug.clone())
        .ok_or_else(|| AppError::internal("no task statuses configured for owner"))?;

    let mut by_category: Vec<(String, String)> = Vec::new();
    let mut named: Vec<(String, String, String)> = Vec::new();
    for status in all {
        if !by_category.iter().any(|(c, _)| *c == status.category) {
            by_category.push((status.category.clone(), status.slug.clone()));
        }
        named.push((
            status.category.clone(),
            status.name.to_lowercase(),
            status.slug.clone(),
        ));
    }
    Ok(CategoryResolver {
        by_category,
        named,
        fallback,
    })
}

fn validate_category(raw: &str) -> Result<&str, AppError> {
    CATEGORIES
        .iter()
        .find(|c| **c == raw)
        .copied()
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "Unknown category '{raw}'. Expected one of: {}.",
                CATEGORIES.join(", ")
            ))
        })
}

/// `#rrggbb`, lowercased. Mirrors the CHECK on the column — the value is
/// rendered as an inline style, so it is never taken on trust.
fn validate_color(raw: Option<&str>) -> Result<String, AppError> {
    let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok("#6b7280".to_string());
    };
    let color = value.to_ascii_lowercase();
    let valid = color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(AppError::bad_request(
            "Color must be a hex value like #4c9aff.",
        ));
    }
    Ok(color)
}

fn validate_name(raw: &str) -> Result<&str, AppError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::bad_request("Status name is required."));
    }
    if name.chars().count() > NAME_MAX {
        return Err(AppError::bad_request(format!(
            "Status name must be {NAME_MAX} characters or fewer."
        )));
    }
    Ok(name)
}

fn validate_description(raw: Option<&str>) -> Result<&str, AppError> {
    let description = raw.unwrap_or("").trim();
    if description.chars().count() > DESCRIPTION_MAX {
        return Err(AppError::bad_request(format!(
            "Description must be {DESCRIPTION_MAX} characters or fewer."
        )));
    }
    Ok(description)
}

/// A stable, URL-safe slug derived from the name. `tasks.status` stores this, so
/// it must stay unique per owner; a numeric suffix resolves collisions rather
/// than rejecting the name, since two statuses may legitimately read alike
/// ("In Review" in two different categories).
async fn unique_slug(pool: &PgPool, owner: StatusOwner, name: &str) -> Result<String, AppError> {
    let base: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(SLUG_MAX)
        .collect();
    let base = if base.is_empty() {
        "status".to_string()
    } else {
        base
    };

    let taken: Vec<String> = load(pool, owner)
        .await?
        .into_iter()
        .map(|s| s.slug)
        .collect();
    if !taken.contains(&base) {
        return Ok(base);
    }
    for suffix in 2..1000 {
        let candidate = format!("{base}_{suffix}");
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(AppError::bad_request(
        "Too many statuses share that name. Pick a different one.",
    ))
}

/// Read access is open to everyone in the scope: the task board can't render
/// without the status list, so gating it behind `task_statuses:manage` would
/// leave ordinary members with a blank board.
#[get("/task-statuses")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_statuses(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = owner_for_user(pool.get_ref(), user_id).await?;
    Ok(HttpResponse::Ok().json(load(pool.get_ref(), owner).await?))
}

/// Write access requires `task_statuses:manage`, since an org's statuses are
/// shared state — one member's edit reshapes every other member's board.
async fn require_manage(req: &HttpRequest, pool: &PgPool) -> Result<StatusOwner, AppError> {
    let ctx = rbac::require_permission(req, pool, Permission::TaskStatusesManage)
        .await
        .map_err(|_| AppError::Forbidden)?;
    Ok(owner_for(ctx.scope, ctx.organization_id, ctx.user_id))
}

#[post("/task-statuses")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_status(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<StatusInput>,
) -> AppResult {
    let owner = require_manage(&req, pool.get_ref()).await?;

    let name = validate_name(&data.name)?;
    let category = validate_category(data.category.trim())?;
    let description = validate_description(data.description.as_deref())?;
    let color = validate_color(data.color.as_deref())?;
    let slug = unique_slug(pool.get_ref(), owner, name).await?;

    // Land the new status at the end of its category rather than the end of the
    // list, so it appears under the heading the user created it from.
    let position = load(pool.get_ref(), owner)
        .await?
        .iter()
        .filter(|s| s.category == category)
        .map(|s| s.position)
        .max()
        .map(|p| p + 1)
        .unwrap_or(0);

    sqlx::query(
        "INSERT INTO task_statuses
             (organization_id, user_id, slug, name, description, color, category, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(owner.org_id())
    .bind(owner.user_id())
    .bind(&slug)
    .bind(name)
    .bind(description)
    .bind(&color)
    .bind(category)
    .bind(position)
    .execute(pool.get_ref())
    .await?;

    // Re-read rather than RETURNING, so the response carries the computed
    // `task_count` that only the list query knows how to derive.
    let row = load(pool.get_ref(), owner)
        .await?
        .into_iter()
        .find(|s| s.slug == slug)
        .ok_or(AppError::NotFound("Status"))?;

    Ok(HttpResponse::Ok().json(row))
}

/// Updates presentation only. `slug` is deliberately immutable — `tasks.status`
/// stores it, so letting it change would orphan every task on that status.
/// `category` stays editable because it carries no stored reference.
#[put("/task-statuses/{id}")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn update_status(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<StatusInput>,
) -> AppResult {
    let owner = require_manage(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let name = validate_name(&data.name)?;
    let category = validate_category(data.category.trim())?;
    let description = validate_description(data.description.as_deref())?;
    let color = validate_color(data.color.as_deref())?;

    let updated = sqlx::query(
        "UPDATE task_statuses
            SET name = $1, description = $2, color = $3, category = $4, updated_at = NOW()
          WHERE id = $5
            AND (($6::INTEGER IS NOT NULL AND organization_id = $6)
              OR ($7::INTEGER IS NOT NULL AND user_id = $7))",
    )
    .bind(name)
    .bind(description)
    .bind(&color)
    .bind(category)
    .bind(id)
    .bind(owner.org_id())
    .bind(owner.user_id())
    .execute(pool.get_ref())
    .await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound("Status"));
    }

    // Re-read rather than RETURNING, so the response carries `task_count`.
    let row = load(pool.get_ref(), owner)
        .await?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or(AppError::NotFound("Status"))?;

    Ok(HttpResponse::Ok().json(row))
}

/// Persists drag-reorder. Positions are rewritten from the array index, so the
/// stored values stay dense no matter what the client sends.
#[put("/task-statuses/reorder")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn reorder_statuses(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<ReorderInput>,
) -> AppResult {
    let owner = require_manage(&req, pool.get_ref()).await?;

    let mut tx = pool.get_ref().begin().await.map_err(AppError::Db)?;
    for (position, id) in data.ids.iter().enumerate() {
        sqlx::query(
            "UPDATE task_statuses SET position = $1, updated_at = NOW()
              WHERE id = $2
                AND (($3::INTEGER IS NOT NULL AND organization_id = $3)
                  OR ($4::INTEGER IS NOT NULL AND user_id = $4))",
        )
        .bind(position as i32)
        .bind(id)
        .bind(owner.org_id())
        .bind(owner.user_id())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await.map_err(AppError::Db)?;

    Ok(HttpResponse::Ok().json(load(pool.get_ref(), owner).await?))
}

/// Deleting a status that tasks still reference would strand them on a slug with
/// no row, which renders as a blank chip and can never be filtered. So: refuse,
/// and report the count, unless the caller names a `reassign_to` status to move
/// those tasks onto first. The last remaining status can't go either — an empty
/// set would make the board unusable and re-trigger default seeding.
#[delete("/task-statuses/{id}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn delete_status(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> AppResult {
    let owner = require_manage(&req, pool.get_ref()).await?;
    let id = path.into_inner();

    let all = load(pool.get_ref(), owner).await?;
    if all.len() <= 1 {
        return Err(AppError::bad_request(
            "You need at least one status. Create another before deleting this one.",
        ));
    }
    let target = all
        .iter()
        .find(|s| s.id == id)
        .ok_or(AppError::NotFound("Status"))?;

    let in_use: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM tasks WHERE status = $1
          AND ($2::INTEGER IS NULL OR user_id IN (SELECT id FROM users WHERE organization_id = $2))
          AND ($3::INTEGER IS NULL OR user_id = $3)",
    )
    .bind(&target.slug)
    .bind(owner.org_id())
    .bind(owner.user_id())
    .fetch_one(pool.get_ref())
    .await?;

    if in_use > 0 {
        let reassign_to = query.get("reassign_to").map(String::as_str);
        let Some(destination) = reassign_to else {
            return Err(AppError::bad_request(format!(
                "{in_use} task(s) still use '{}'. Choose a status to move them to first.",
                target.name
            )));
        };
        if destination == target.slug || !all.iter().any(|s| s.slug == destination) {
            return Err(AppError::bad_request(
                "Pick a different, existing status to move those tasks to.",
            ));
        }
        sqlx::query(
            "UPDATE tasks SET status = $1, updated_at = NOW()
              WHERE status = $2
                AND ($3::INTEGER IS NULL
                     OR user_id IN (SELECT id FROM users WHERE organization_id = $3))
                AND ($4::INTEGER IS NULL OR user_id = $4)",
        )
        .bind(destination)
        .bind(&target.slug)
        .bind(owner.org_id())
        .bind(owner.user_id())
        .execute(pool.get_ref())
        .await?;
    }

    sqlx::query(
        "DELETE FROM task_statuses WHERE id = $1
          AND (($2::INTEGER IS NOT NULL AND organization_id = $2)
            OR ($3::INTEGER IS NOT NULL AND user_id = $3))",
    )
    .bind(id)
    .bind(owner.org_id())
    .bind(owner.user_id())
    .execute(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": id, "reassigned": in_use })))
}
