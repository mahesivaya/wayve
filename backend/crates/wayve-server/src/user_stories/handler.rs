//! Workspace user stories — an org-shared backlog that reuses the Tasks data
//! shape and the Tasks UI (`frontend/src/tasks/Tasks.tsx` via a config prop).
//!
//! Ownership is polymorphic exactly like `task_statuses`: an organization member
//! reads and writes their org's ONE shared list; platform and personal accounts
//! get their own. That owner comes from [`statuses::owner_for_user`], so a story
//! and the statuses it references always share the same owner — the board reuses
//! the owner's `task_statuses` set rather than duplicating a status table.
//!
//! Responses reuse [`Task`] (task_number carries the per-owner `story_number`;
//! the Jira/GitLab fields are always None), and requests reuse [`TaskInput`], so
//! the shared frontend component needs no new record type.

use crate::models::task::{Task, TaskInput};
use crate::prelude::*;
use crate::tasks::statuses::{self, StatusOwner};
use actix_web::{delete, put};
use sqlx::Row;
use std::collections::HashMap;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;

/// Splits the polymorphic owner into the two nullable binds every query uses.
fn owner_ids(owner: StatusOwner) -> (Option<i32>, Option<i32>) {
    match owner {
        StatusOwner::Organization(id) => (Some(id), None),
        StatusOwner::User(id) => (None, Some(id)),
    }
}

/// Appends a status-history event (the burnup trend lines replay these). Best
/// effort: a failure here must not fail the story write, so it logs and moves on.
/// The owner columns are denormalised so the history query scopes without a join.
async fn record_status_event(pool: &PgPool, owner: StatusOwner, story_id: i32, slug: &str) {
    let (org_id, uid) = owner_ids(owner);
    let category = statuses::category_of(pool, owner, slug)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "backlog".to_string());
    if let Err(e) = sqlx::query(
        "INSERT INTO user_story_status_events
             (user_story_id, organization_id, user_id, to_status, to_category)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(story_id)
    .bind(org_id)
    .bind(uid)
    .bind(slug)
    .bind(&category)
    .execute(pool)
    .await
    {
        tracing::warn!(target: "db", story_id, error = ?e, "failed to record user-story status event");
    }
}

fn story_from_row(row: sqlx::postgres::PgRow) -> Task {
    Task {
        id: row.get("id"),
        task_number: row.try_get("story_number").ok().flatten(),
        name: row.get("name"),
        description: row.get("description"),
        priority: row.get("priority"),
        status: row.get("status"),
        assigned_by: row.try_get("assigned_by").unwrap_or_default(),
        assignee: row.try_get("assignee").unwrap_or_default(),
        assignee_id: row.try_get("assignee_id").ok().flatten(),
        project_id: row.try_get("project_id").ok().flatten(),
        created_at: row.try_get("created_at").ok(),
        updated_at: row.try_get("updated_at").ok(),
        // User stories are never externally imported, so these stay unset.
        jira_issue_key: None,
        jira_base: None,
        gitlab_issue_iid: None,
        gitlab_web_url: None,
        badge_kind: None,
        related_to: None,
        relation_kind: None,
    }
}

fn normalize_priority(value: Option<i16>) -> i16 {
    value.unwrap_or(3).clamp(1, 5)
}

/// The status slug a write should store, validated against the owner's shared
/// `task_statuses` set. Mirrors `tasks::handler::resolve_status`: an unknown slug
/// is a 400 rather than a silent reset, and omitting `status` defaults to the
/// first status in board order.
async fn resolve_status(
    pool: &PgPool,
    owner: StatusOwner,
    value: Option<&str>,
) -> Result<String, AppError> {
    let available = statuses::load(pool, owner).await?;
    let Some(requested) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return available
            .first()
            .map(|s| s.slug.clone())
            .ok_or_else(|| AppError::internal("no statuses configured for owner"));
    };
    available
        .iter()
        .find(|s| s.slug == requested)
        .map(|s| s.slug.clone())
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "Unknown status '{requested}'. Configure it under Settings → Task statuses."
            ))
        })
}

const SELECT_COLS: &str = "id, story_number, name, description, priority, status, assigned_by, \
     assignee, assignee_id, project_id, created_at, updated_at";

#[get("/user-stories")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_user_stories(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    let rows = sqlx::query(&format!(
        "SELECT {SELECT_COLS}
         FROM user_stories
         WHERE ($1::INTEGER IS NOT NULL AND organization_id = $1)
            OR ($2::INTEGER IS NOT NULL AND user_id = $2)
         ORDER BY priority DESC, created_at ASC, id ASC"
    ))
    .bind(org_id)
    .bind(uid)
    .fetch_all(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(rows.into_iter().map(story_from_row).collect::<Vec<_>>()))
}

#[post("/user-stories")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_user_story(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<TaskInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    let name = data.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Story name is required".into()));
    }
    let description = data.description.as_deref().unwrap_or("").trim();
    let priority = normalize_priority(data.priority);
    let status = resolve_status(pool.get_ref(), owner, data.status.as_deref()).await?;
    let assigned_by = data.assigned_by.as_deref().unwrap_or("").trim();
    let assignee = data.assignee.as_deref().unwrap_or("").trim();

    // story_number is the next per-owner sequence value, computed inline off the
    // same owner binds so one statement assigns it.
    let row = sqlx::query(&format!(
        "INSERT INTO user_stories
             (organization_id, user_id, name, description, priority, status,
              assigned_by, assignee, assignee_id, project_id, story_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 COALESCE((SELECT MAX(story_number) FROM user_stories
                            WHERE ($1::INTEGER IS NOT NULL AND organization_id = $1)
                               OR ($2::INTEGER IS NOT NULL AND user_id = $2)), 0) + 1)
         RETURNING {SELECT_COLS}"
    ))
    .bind(org_id)
    .bind(uid)
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(&status)
    .bind(assigned_by)
    .bind(assignee)
    .bind(data.assignee_id)
    .bind(data.project_id)
    .fetch_one(pool.get_ref())
    .await?;

    let story = story_from_row(row);
    // First history event: the status the story is born in.
    record_status_event(pool.get_ref(), owner, story.id, &status).await;
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "user_story_created",
            resource_type: "user_story",
            resource_id: Some(story.id.to_string()),
            metadata: Some(serde_json::json!({
                "summary": name,
                "status": status,
                "priority": priority,
                "assignee": assignee,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(story))
}

#[put("/user-stories/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn update_user_story(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<TaskInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    let name = data.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Story name is required".into()));
    }
    let description = data.description.as_deref().unwrap_or("").trim();
    let priority = normalize_priority(data.priority);
    let status = resolve_status(pool.get_ref(), owner, data.status.as_deref()).await?;
    let assigned_by = data.assigned_by.as_deref().unwrap_or("").trim();
    let assignee = data.assignee.as_deref().unwrap_or("").trim();

    // Read the current status before the write so we only record a history event
    // when it actually changes. Owner-scoped, so it also confirms the row exists.
    let old_status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM user_stories
          WHERE id = $1
            AND (($2::INTEGER IS NOT NULL AND organization_id = $2)
              OR ($3::INTEGER IS NOT NULL AND user_id = $3))",
    )
    .bind(id)
    .bind(org_id)
    .bind(uid)
    .fetch_optional(pool.get_ref())
    .await?;

    // The owner-scoped UPDATE 404s on a row outside this owner's scope, so an id
    // belonging to another org/user never leaks.
    let row = sqlx::query(&format!(
        "UPDATE user_stories
            SET name = $1, description = $2, priority = $3, status = $4,
                assigned_by = $5, assignee = $6, assignee_id = $7, project_id = $8,
                updated_at = NOW()
          WHERE id = $9
            AND (($10::INTEGER IS NOT NULL AND organization_id = $10)
              OR ($11::INTEGER IS NOT NULL AND user_id = $11))
         RETURNING {SELECT_COLS}"
    ))
    .bind(name)
    .bind(description)
    .bind(priority)
    .bind(&status)
    .bind(assigned_by)
    .bind(assignee)
    .bind(data.assignee_id)
    .bind(data.project_id)
    .bind(id)
    .bind(org_id)
    .bind(uid)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("user story"))?;

    let story = story_from_row(row);
    // Only a real status transition adds a history event; a rename/reprioritise
    // that leaves status untouched does not.
    if old_status.as_deref() != Some(status.as_str()) {
        record_status_event(pool.get_ref(), owner, id, &status).await;
    }
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "user_story_updated",
            resource_type: "user_story",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({
                "summary": name,
                "status": status,
                "priority": priority,
                "assignee": assignee,
            })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(story))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    /// Inclusive window bounds, "YYYY-MM-DD".
    from: String,
    to: String,
}

/// Per-day, per-status story counts over `[from, to]`, for the burnup trend
/// lines. Reconstructed by replaying `user_story_status_events`: a story's
/// status on day D is the `to_status` of its latest event at end-of-day D; a
/// story with no event by then didn't exist yet and isn't counted. Response:
/// `{ "days": [{ "date": "YYYY-MM-DD", "counts": { "<slug>": n, ... } }, ...] }`.
#[get("/user-stories/status-history")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn user_story_status_history(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<HistoryQuery>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    let from = NaiveDate::parse_from_str(&query.from, "%Y-%m-%d")
        .map_err(|_| AppError::bad_request("Invalid `from` date (expected YYYY-MM-DD)"))?;
    let to = NaiveDate::parse_from_str(&query.to, "%Y-%m-%d")
        .map_err(|_| AppError::bad_request("Invalid `to` date (expected YYYY-MM-DD)"))?;
    if to < from {
        return Err(AppError::bad_request("`to` must not be before `from`"));
    }
    if (to - from).num_days() > 120 {
        return Err(AppError::bad_request("Range too large (max 120 days)"));
    }

    // All events up to end-of-`to`, oldest first per story, so each story's
    // timeline can be swept in one pass across the day range.
    let end_exclusive = to.succ_opt().unwrap_or(to);
    let rows = sqlx::query(
        "SELECT user_story_id, to_status, changed_at
           FROM user_story_status_events
          WHERE (($1::INTEGER IS NOT NULL AND organization_id = $1)
             OR ($2::INTEGER IS NOT NULL AND user_id = $2))
            AND changed_at < $3
          ORDER BY user_story_id ASC, changed_at ASC, id ASC",
    )
    .bind(org_id)
    .bind(uid)
    .bind(NaiveDateTime::new(end_exclusive, NaiveTime::MIN))
    .fetch_all(pool.get_ref())
    .await?;

    // Group each story's (changed_at, status) timeline.
    let mut by_story: HashMap<i32, Vec<(NaiveDateTime, String)>> = HashMap::new();
    for row in rows {
        let sid: i32 = row.get("user_story_id");
        let at: NaiveDateTime = row.get("changed_at");
        let slug: String = row.get("to_status");
        by_story.entry(sid).or_default().push((at, slug));
    }

    let mut days = Vec::new();
    let mut cursor = from;
    while cursor <= to {
        days.push(cursor);
        match cursor.succ_opt() {
            Some(next) => cursor = next,
            None => break,
        }
    }

    let mut counts: Vec<HashMap<String, i64>> = vec![HashMap::new(); days.len()];
    for events in by_story.values() {
        let mut j = 0;
        let mut current: Option<&str> = None;
        for (di, day) in days.iter().enumerate() {
            let day_end = NaiveDateTime::new(day.succ_opt().unwrap_or(*day), NaiveTime::MIN);
            while j < events.len() && events[j].0 < day_end {
                current = Some(events[j].1.as_str());
                j += 1;
            }
            if let Some(slug) = current {
                *counts[di].entry(slug.to_string()).or_insert(0) += 1;
            }
        }
    }

    let days_json: Vec<Value> = days
        .iter()
        .zip(counts.iter())
        .map(|(day, day_counts)| {
            serde_json::json!({
                "date": day.format("%Y-%m-%d").to_string(),
                "counts": day_counts,
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(serde_json::json!({ "days": days_json })))
}

/// Each story's own status timeline up to end-of-`to`, for the timeline card's
/// per-story bars: a bar is drawn in blocks, one per status the story passed
/// through, so its length says how long the story ran and its colours say where
/// that time went.
///
/// Events before `from` are included on purpose — the latest one before the
/// window is what the story's status *was* when the window opened, and without
/// it the first block would have no colour. The caller clips to its own window.
/// Response: `{ "stories": [{ "id": 12, "events": [{ "at": "...", "status": "todo" }] }] }`.
#[get("/user-stories/status-timeline")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn user_story_status_timeline(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<HistoryQuery>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    // `from` is accepted and validated for symmetry with the history endpoint,
    // but does not bound the query: see the note above about the opening status.
    let _from = NaiveDate::parse_from_str(&query.from, "%Y-%m-%d")
        .map_err(|_| AppError::bad_request("Invalid `from` date (expected YYYY-MM-DD)"))?;
    let to = NaiveDate::parse_from_str(&query.to, "%Y-%m-%d")
        .map_err(|_| AppError::bad_request("Invalid `to` date (expected YYYY-MM-DD)"))?;
    if to < _from {
        return Err(AppError::bad_request("`to` must not be before `from`"));
    }

    let end_exclusive = to.succ_opt().unwrap_or(to);
    let rows = sqlx::query(
        "SELECT user_story_id, to_status, changed_at
           FROM user_story_status_events
          WHERE (($1::INTEGER IS NOT NULL AND organization_id = $1)
             OR ($2::INTEGER IS NOT NULL AND user_id = $2))
            AND changed_at < $3
          ORDER BY user_story_id ASC, changed_at ASC, id ASC",
    )
    .bind(org_id)
    .bind(uid)
    .bind(NaiveDateTime::new(end_exclusive, NaiveTime::MIN))
    .fetch_all(pool.get_ref())
    .await?;

    // Rows arrive grouped and ordered by the query, so one pass builds the
    // per-story lists without sorting again.
    let mut stories: Vec<Value> = Vec::new();
    let mut current_id: Option<i32> = None;
    let mut events: Vec<Value> = Vec::new();
    for row in rows {
        let sid: i32 = row.get("user_story_id");
        if current_id != Some(sid) {
            if let Some(id) = current_id {
                stories.push(serde_json::json!({ "id": id, "events": events }));
                events = Vec::new();
            }
            current_id = Some(sid);
        }
        let at: NaiveDateTime = row.get("changed_at");
        let status: String = row.get("to_status");
        events.push(serde_json::json!({
            "at": at.format("%Y-%m-%dT%H:%M:%S").to_string(),
            "status": status,
        }));
    }
    if let Some(id) = current_id {
        stories.push(serde_json::json!({ "id": id, "events": events }));
    }

    Ok(HttpResponse::Ok().json(serde_json::json!({ "stories": stories })))
}

#[delete("/user-stories/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_user_story(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let id = path.into_inner();
    let owner = statuses::owner_for_user(pool.get_ref(), user_id).await?;
    let (org_id, uid) = owner_ids(owner);

    let removed: Option<String> = sqlx::query_scalar(
        "DELETE FROM user_stories
          WHERE id = $1
            AND (($2::INTEGER IS NOT NULL AND organization_id = $2)
              OR ($3::INTEGER IS NOT NULL AND user_id = $3))
         RETURNING name",
    )
    .bind(id)
    .bind(org_id)
    .bind(uid)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some(story_name) = removed else {
        return Err(AppError::NotFound("user story"));
    };

    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "user_story_deleted",
            resource_type: "user_story",
            resource_id: Some(id.to_string()),
            metadata: Some(serde_json::json!({ "summary": story_name })),
        },
    )
    .await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
