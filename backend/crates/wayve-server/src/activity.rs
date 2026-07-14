//! Non-consequential activity stream: page views, UI clicks, and every
//! authenticated API request.
//!
//! Deliberately separate from `audit.rs`: this is high-volume, low-value
//! telemetry, so it gets its own `activity_events` table, is written
//! fire-and-forget so it never blocks a request, and is pruned by the background
//! task in `startup.rs`. Scope is enforced at read time (the User Audit page is
//! owner-gated), so there is no per-request organization lookup here.

use crate::prelude::*;
use tracing::warn;

/// Insert one activity row. Best-effort — failures are logged and swallowed.
#[allow(clippy::too_many_arguments)]
pub async fn record(
    pool: &PgPool,
    actor_user_id: i32,
    kind: &str,
    label: Option<String>,
    method: Option<String>,
    path: Option<String>,
    status_code: Option<i32>,
    ip: Option<String>,
) {
    if let Err(err) = sqlx::query(
        r#"
        INSERT INTO activity_events
            (actor_user_id, kind, label, method, path, status_code, ip)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(actor_user_id)
    .bind(kind)
    .bind(label.as_deref())
    .bind(method.as_deref())
    .bind(path.as_deref())
    .bind(status_code)
    .bind(ip.as_deref())
    .execute(pool)
    .await
    {
        warn!(target: "activity", error = ?err, kind, "activity_events insert failed");
    }
}

/// Spawns the insert so the calling handler or middleware never awaits the write.
#[allow(clippy::too_many_arguments)]
pub fn spawn_record(
    pool: PgPool,
    actor_user_id: i32,
    kind: &'static str,
    label: Option<String>,
    method: Option<String>,
    path: Option<String>,
    status_code: Option<i32>,
    ip: Option<String>,
) {
    tokio::spawn(async move {
        record(
            &pool,
            actor_user_id,
            kind,
            label,
            method,
            path,
            status_code,
            ip,
        )
        .await;
    });
}
