use crate::prelude::*;
use chrono::{DateTime, Utc};
use sqlx::Row;
use tracing::instrument;
use wayve_security::rbac::{Permission, RoleContext, Scope, require_permission};

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(developer_summary)
        .service(support_summary)
        .service(users_summary)
        .service(platform_users);
}

async fn gate(
    req: &HttpRequest,
    pool: &PgPool,
    perm: Permission,
) -> std::result::Result<RoleContext, HttpResponse> {
    let ctx = require_permission(req, pool, perm).await?;
    if ctx.scope != Scope::Platform {
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Platform scope required"
        })));
    }
    Ok(ctx)
}

// ──────────────────────────────────────────────────────────────────────
// Developer
// ──────────────────────────────────────────────────────────────────────

#[get("/platform-team/developer-summary")]
#[instrument(target = "http", skip(req, pool))]
pub async fn developer_summary(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::LogsReadLimited).await {
        return Ok(resp);
    }

    let counts = sqlx::query(
        r#"
        SELECT
          (SELECT COUNT(*) FROM api_keys)::BIGINT AS keys_total,
          (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL)::BIGINT AS keys_active,
          (SELECT COUNT(*) FROM api_keys
             WHERE revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > NOW()))::BIGINT AS keys_usable,
          (SELECT COUNT(*) FROM api_keys
             WHERE expires_at IS NOT NULL
               AND expires_at < NOW())::BIGINT AS keys_expired,
          (SELECT COUNT(*) FROM api_key_audit_log
             WHERE created_at >= NOW() - INTERVAL '24 hours')::BIGINT AS audit_24h,
          (SELECT COUNT(*) FROM api_key_audit_log
             WHERE created_at >= NOW() - INTERVAL '7 days')::BIGINT AS audit_7d,
          (SELECT COUNT(*) FROM api_key_audit_log
             WHERE created_at >= NOW() - INTERVAL '24 hours'
               AND status_code >= 400)::BIGINT AS audit_failures_24h,
          (SELECT COUNT(*) FROM api_key_audit_log
             WHERE created_at >= NOW() - INTERVAL '24 hours'
               AND outcome = 'rate_limited')::BIGINT AS rate_limited_24h,
          (SELECT COUNT(*) FROM webhook_events
             WHERE processed_at >= NOW() - INTERVAL '7 days')::BIGINT AS webhooks_7d,
          (SELECT COUNT(*) FROM org_sso_configs)::BIGINT AS sso_integrations
        "#,
    )
    .fetch_one(pool.get_ref())
    .await?;

    let top_keys = sqlx::query(
        r#"
        SELECT k.id, k.name, k.key_preview, k.key_type, k.scopes, k.last_used_at,
               COALESCE(o.name, 'Personal') AS owner_name,
               COUNT(a.id)::BIGINT AS calls_24h
          FROM api_keys k
          LEFT JOIN organizations o ON o.id = k.organization_id
          LEFT JOIN api_key_audit_log a
                 ON a.api_key_id = k.id
                AND a.created_at >= NOW() - INTERVAL '24 hours'
         WHERE k.revoked_at IS NULL
         GROUP BY k.id, o.name
         ORDER BY calls_24h DESC, k.created_at DESC
         LIMIT 10
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let recent_audit = sqlx::query(
        r#"
        SELECT a.id, a.method, a.path, a.status_code, a.outcome, a.ip, a.created_at,
               k.name AS key_name, k.key_preview
          FROM api_key_audit_log a
          LEFT JOIN api_keys k ON k.id = a.api_key_id
         ORDER BY a.created_at DESC
         LIMIT 20
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let top_endpoints = sqlx::query(
        r#"
        SELECT path, COUNT(*)::BIGINT AS calls,
               SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END)::BIGINT AS errors
          FROM api_key_audit_log
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY path
         ORDER BY calls DESC
         LIMIT 10
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let top_keys_json: Vec<_> = top_keys
        .into_iter()
        .map(|row| {
            let last_used: Option<DateTime<Utc>> = row.try_get("last_used_at").ok().flatten();
            let scopes: Vec<String> = row.try_get("scopes").unwrap_or_default();
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or(0),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "key_preview": row.try_get::<String, _>("key_preview").unwrap_or_default(),
                "key_type": row.try_get::<String, _>("key_type").unwrap_or_default(),
                "scopes": scopes,
                "owner_name": row.try_get::<String, _>("owner_name").unwrap_or_default(),
                "calls_24h": row.try_get::<i64, _>("calls_24h").unwrap_or(0),
                "last_used_at": last_used,
            })
        })
        .collect();

    let audit_json: Vec<_> = recent_audit
        .into_iter()
        .map(|row| {
            let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
            serde_json::json!({
                "id": row.try_get::<i64, _>("id").unwrap_or(0),
                "method": row.try_get::<String, _>("method").unwrap_or_default(),
                "path": row.try_get::<String, _>("path").unwrap_or_default(),
                "status_code": row.try_get::<i32, _>("status_code").unwrap_or(0),
                "outcome": row.try_get::<String, _>("outcome").unwrap_or_default(),
                "ip": row.try_get::<Option<String>, _>("ip").ok().flatten(),
                "key_name": row.try_get::<Option<String>, _>("key_name").ok().flatten(),
                "key_preview": row.try_get::<Option<String>, _>("key_preview").ok().flatten(),
                "created_at": created_at,
            })
        })
        .collect();

    let endpoints_json: Vec<_> = top_endpoints
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "path": row.try_get::<String, _>("path").unwrap_or_default(),
                "calls": row.try_get::<i64, _>("calls").unwrap_or(0),
                "errors": row.try_get::<i64, _>("errors").unwrap_or(0),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "keys_total": counts.try_get::<i64, _>("keys_total").unwrap_or(0),
        "keys_active": counts.try_get::<i64, _>("keys_active").unwrap_or(0),
        "keys_usable": counts.try_get::<i64, _>("keys_usable").unwrap_or(0),
        "keys_expired": counts.try_get::<i64, _>("keys_expired").unwrap_or(0),
        "audit_24h": counts.try_get::<i64, _>("audit_24h").unwrap_or(0),
        "audit_7d": counts.try_get::<i64, _>("audit_7d").unwrap_or(0),
        "audit_failures_24h": counts.try_get::<i64, _>("audit_failures_24h").unwrap_or(0),
        "rate_limited_24h": counts.try_get::<i64, _>("rate_limited_24h").unwrap_or(0),
        "webhooks_7d": counts.try_get::<i64, _>("webhooks_7d").unwrap_or(0),
        "sso_integrations": counts.try_get::<i64, _>("sso_integrations").unwrap_or(0),
        "top_keys": top_keys_json,
        "recent_audit": audit_json,
        "top_endpoints": endpoints_json,
    })))
}

// ──────────────────────────────────────────────────────────────────────
// Support
// ──────────────────────────────────────────────────────────────────────

#[get("/platform-team/support-summary")]
#[instrument(target = "http", skip(req, pool))]
pub async fn support_summary(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::MembersRead).await {
        return Ok(resp);
    }

    let counts = sqlx::query(
        r#"
        SELECT
          (SELECT COUNT(*) FROM users)::BIGINT AS users_total,
          (SELECT COUNT(*) FROM users
             WHERE created_at >= NOW() - INTERVAL '7 days')::BIGINT AS users_new_7d,
          (SELECT COUNT(*) FROM users
             WHERE created_at >= NOW() - INTERVAL '24 hours')::BIGINT AS users_new_24h,
          (SELECT COUNT(*) FROM organizations)::BIGINT AS orgs_total,
          (SELECT COUNT(*) FROM subscriptions
             WHERE status IN ('active','trialing'))::BIGINT AS active_subs,
          (SELECT COUNT(*) FROM subscriptions
             WHERE status = 'past_due')::BIGINT AS past_due,
          (SELECT COUNT(*) FROM email_accounts)::BIGINT AS connected_mailboxes,
          (SELECT COUNT(*) FROM email_accounts
             WHERE COALESCE(is_shared, false) = true)::BIGINT AS shared_inboxes,
          (SELECT COUNT(*) FROM shared_inbox_email_state
             WHERE status != 'closed')::BIGINT AS open_inbox_threads,
          (SELECT COUNT(*) FROM shared_inbox_email_state
             WHERE status = 'pending')::BIGINT AS pending_inbox_threads
        "#,
    )
    .fetch_one(pool.get_ref())
    .await?;

    let top_orgs = sqlx::query(
        r#"
        SELECT o.id, o.name, o.slug,
               (SELECT COUNT(*) FROM users WHERE organization_id = o.id)::BIGINT AS member_count,
               (SELECT COUNT(*) FROM email_accounts WHERE organization_id = o.id)::BIGINT AS mailboxes,
               COALESCE(s.status, 'free') AS sub_status,
               p.name AS plan_name
          FROM organizations o
          LEFT JOIN subscriptions s
                 ON s.organization_id = o.id AND s.status IN ('active','trialing','past_due')
          LEFT JOIN plans p ON p.id = s.plan_id
         ORDER BY member_count DESC, o.id DESC
         LIMIT 10
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let recent_signups = sqlx::query(
        r#"
        SELECT id, email, username, account_type, created_at, auth_provider
          FROM users
         ORDER BY created_at DESC NULLS LAST
         LIMIT 15
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    // Subject is fetched via the email repo so encryption stays one-place.
    // We still need this query for the workflow columns (status, assignee,
    // updated_at, inbox_email) — subject is filled in below.
    let inbox_queue = sqlx::query(
        r#"
        SELECT s.email_id, s.status, s.updated_at,
               COALESCE(u.email, '—') AS assignee_email,
               ea.email AS inbox_email
          FROM shared_inbox_email_state s
          LEFT JOIN users u ON u.id = s.assignee_id
          LEFT JOIN emails e ON e.id = s.email_id
          LEFT JOIN email_accounts ea ON ea.id = e.account_id
         WHERE s.status != 'closed'
         ORDER BY s.updated_at DESC
         LIMIT 15
        "#,
    )
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();

    let inbox_subject_ids: Vec<i32> = inbox_queue
        .iter()
        .filter_map(|r| r.try_get::<i32, _>("email_id").ok())
        .collect();
    let inbox_subjects = crate::email::repo::subjects_for_ids(pool.get_ref(), &inbox_subject_ids)
        .await
        .unwrap_or_default();

    let top_orgs_json: Vec<_> = top_orgs
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or(0),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "slug": row.try_get::<Option<String>, _>("slug").ok().flatten(),
                "member_count": row.try_get::<i64, _>("member_count").unwrap_or(0),
                "mailboxes": row.try_get::<i64, _>("mailboxes").unwrap_or(0),
                "sub_status": row.try_get::<String, _>("sub_status").unwrap_or_default(),
                "plan_name": row.try_get::<Option<String>, _>("plan_name").ok().flatten(),
            })
        })
        .collect();

    let signups_json: Vec<_> = recent_signups
        .into_iter()
        .map(|row| {
            let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or(0),
                "email": row.try_get::<String, _>("email").unwrap_or_default(),
                "username": row.try_get::<Option<String>, _>("username").ok().flatten(),
                "account_type": row.try_get::<String, _>("account_type").unwrap_or_default(),
                "auth_provider": row.try_get::<Option<String>, _>("auth_provider").ok().flatten(),
                "created_at": created_at,
            })
        })
        .collect();

    let inbox_json: Vec<_> = inbox_queue
        .into_iter()
        .map(|row| {
            let updated_at: Option<DateTime<Utc>> = row.try_get("updated_at").ok();
            let email_id = row.try_get::<i32, _>("email_id").unwrap_or(0);
            let subject = inbox_subjects.get(&email_id).cloned().flatten();
            serde_json::json!({
                "email_id": email_id,
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
                "subject": subject,
                "inbox_email": row.try_get::<Option<String>, _>("inbox_email").ok().flatten(),
                "assignee_email": row.try_get::<Option<String>, _>("assignee_email").ok().flatten(),
                "updated_at": updated_at,
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "users_total": counts.try_get::<i64, _>("users_total").unwrap_or(0),
        "users_new_7d": counts.try_get::<i64, _>("users_new_7d").unwrap_or(0),
        "users_new_24h": counts.try_get::<i64, _>("users_new_24h").unwrap_or(0),
        "orgs_total": counts.try_get::<i64, _>("orgs_total").unwrap_or(0),
        "active_subs": counts.try_get::<i64, _>("active_subs").unwrap_or(0),
        "past_due": counts.try_get::<i64, _>("past_due").unwrap_or(0),
        "connected_mailboxes": counts.try_get::<i64, _>("connected_mailboxes").unwrap_or(0),
        "shared_inboxes": counts.try_get::<i64, _>("shared_inboxes").unwrap_or(0),
        "open_inbox_threads": counts.try_get::<i64, _>("open_inbox_threads").unwrap_or(0),
        "pending_inbox_threads": counts.try_get::<i64, _>("pending_inbox_threads").unwrap_or(0),
        "top_organizations": top_orgs_json,
        "recent_signups": signups_json,
        "open_inbox_queue": inbox_json,
    })))
}

// ──────────────────────────────────────────────────────────────────────
// Users
// ──────────────────────────────────────────────────────────────────────

#[get("/platform-team/users-summary")]
#[instrument(target = "http", skip(req, pool))]
pub async fn users_summary(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::MembersRead).await {
        return Ok(resp);
    }

    // Rollups scoped to PERSONAL users only (the tiles on the Users page show
    // personal-user figures). Storage mirrors the per-user breakdown in
    // routes/user/profile.rs (drive files + email bodies + chat + notes +
    // tasks), each component restricted to personal users via a join on
    // users.account_type, so the total equals the sum of what each personal
    // user sees on their own profile.
    let row = sqlx::query(
        r#"
        SELECT
          (SELECT COUNT(*) FROM users
             WHERE account_type = 'personal')::BIGINT AS users_total,
          (SELECT COUNT(*) FROM users
             WHERE account_type = 'personal'
               AND created_at >= NOW() - INTERVAL '1 month')::BIGINT AS users_new_1m,
          (SELECT COUNT(*) FROM users
             WHERE account_type = 'personal'
               AND created_at >= NOW() - INTERVAL '1 year')::BIGINT AS users_new_1y,
          (SELECT COUNT(*) FROM emails e
             JOIN email_accounts ea ON e.account_id = ea.id
             JOIN users u ON ea.user_id = u.id
            WHERE u.account_type = 'personal')::BIGINT AS emails_total,
          (
            (SELECT COALESCE(SUM(f.size), 0)::BIGINT FROM drive_files f
               JOIN users u ON f.user_id = u.id WHERE u.account_type = 'personal')
          + (SELECT COALESCE(SUM(octet_length(e.body_encrypted)), 0)::BIGINT FROM emails e
               JOIN email_accounts ea ON e.account_id = ea.id
               JOIN users u ON ea.user_id = u.id WHERE u.account_type = 'personal')
          + (SELECT COALESCE(SUM(octet_length(m.content_encrypted)), 0)::BIGINT FROM messages m
               JOIN users u ON m.sender_id = u.id WHERE u.account_type = 'personal')
          + (SELECT COALESCE(SUM(octet_length(coalesce(n.content_encrypted, n.content, ''))), 0)::BIGINT FROM notes n
               JOIN users u ON n.user_id = u.id WHERE u.account_type = 'personal')
          + (SELECT COALESCE(SUM(octet_length(t.name) + octet_length(coalesce(t.description, ''))), 0)::BIGINT FROM tasks t
               JOIN users u ON t.user_id = u.id WHERE u.account_type = 'personal')
          )::BIGINT AS storage_used_bytes
        "#,
    )
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "users_total": row.try_get::<i64, _>("users_total").unwrap_or(0),
        "users_new_1m": row.try_get::<i64, _>("users_new_1m").unwrap_or(0),
        "users_new_1y": row.try_get::<i64, _>("users_new_1y").unwrap_or(0),
        "emails_total": row.try_get::<i64, _>("emails_total").unwrap_or(0),
        "storage_used_bytes": row.try_get::<i64, _>("storage_used_bytes").unwrap_or(0),
    })))
}

#[derive(serde::Deserialize)]
pub struct PlatformUsersQuery {
    /// Which account type to list. Defaults to "personal".
    pub account_type: Option<String>,
    /// Optional case-insensitive email substring filter.
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Per-user table for the platform Users page: email + memory used, one row
/// per user of the requested `account_type` (default `personal`). `storage_bytes`
/// reuses the same per-user breakdown as routes/user/profile.rs so each row
/// matches what that user sees on their own profile. The five correlated
/// subqueries run only for the returned page (bounded by `limit`).
#[get("/platform-team/users")]
#[instrument(target = "http", skip(req, pool, query))]
pub async fn platform_users(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<PlatformUsersQuery>,
) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::MembersRead).await {
        return Ok(resp);
    }

    let account_type = query
        .account_type
        .clone()
        .unwrap_or_else(|| "personal".to_string());
    let limit = query.limit.unwrap_or(50).clamp(1, 500);
    let offset = query.offset.unwrap_or(0).max(0);
    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));

    let rows = sqlx::query(
        r#"
        SELECT
            u.id, u.email, u.username, u.created_at,
            (
              (SELECT COALESCE(SUM(octet_length(e.body_encrypted)), 0)::BIGINT FROM emails e
                 JOIN email_accounts ea ON e.account_id = ea.id WHERE ea.user_id = u.id)
            + (SELECT COALESCE(SUM(f.size), 0)::BIGINT FROM drive_files f WHERE f.user_id = u.id)
            + (SELECT COALESCE(SUM(octet_length(m.content_encrypted)), 0)::BIGINT FROM messages m WHERE m.sender_id = u.id)
            + (SELECT COALESCE(SUM(octet_length(coalesce(n.content_encrypted, n.content, ''))), 0)::BIGINT FROM notes n WHERE n.user_id = u.id)
            + (SELECT COALESCE(SUM(octet_length(t.name) + octet_length(coalesce(t.description, ''))), 0)::BIGINT FROM tasks t WHERE t.user_id = u.id)
            )::BIGINT AS storage_bytes
        FROM users u
        WHERE u.account_type = $1
          AND ($2::text IS NULL OR u.email ILIKE $2)
        ORDER BY storage_bytes DESC, u.id
        LIMIT $3 OFFSET $4
        "#,
    )
    .bind(&account_type)
    .bind(search.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(pool.get_ref())
    .await?;

    let users: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or(0),
                "email": row.try_get::<String, _>("email").unwrap_or_default(),
                "username": row.try_get::<Option<String>, _>("username").ok().flatten(),
                "created_at": created_at,
                "storage_bytes": row.try_get::<i64, _>("storage_bytes").unwrap_or(0),
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(serde_json::json!({ "users": users })))
}
