//! Non-consequential activity stream: page views, UI clicks, and every
//! authenticated API request.
//!
//! Deliberately separate from `audit.rs`: this is high-volume, low-value
//! telemetry, so it gets its own `activity_events` table and is pruned by the
//! background task in `startup.rs`. Scope is enforced at read time (the User
//! Audit page is owner-gated), so there is no per-request organization lookup.
//!
//! Writes never touch the DB on the request path. `enqueue` pushes onto a
//! bounded channel, and one writer task (`spawn_writer`, started from
//! `startup::spawn_role_workers`) drains it in batches with a single multi-row
//! INSERT. So the stream holds at most one pool connection at a time however
//! busy the API is, and when the queue is full rows are dropped (and counted)
//! rather than piling up as tasks waiting on the pool. Rows still in the queue
//! at shutdown, at most about one flush interval's worth, are lost; that's fine
//! for telemetry.

use crate::prelude::*;
use chrono::{DateTime, Utc};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::warn;

/// Rows buffered between flushes. A full queue drops new rows.
const QUEUE_CAPACITY: usize = 10_000;
/// Most rows written by one INSERT.
const MAX_BATCH: usize = 500;
/// Pause after each flush so rows pile up into batches under load.
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);

static QUEUE: OnceLock<mpsc::Sender<ActivityRow>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// One `activity_events` row. `created_at` is stamped at enqueue time so a
/// batched row keeps the time the event happened, not the time it was flushed.
pub struct ActivityRow {
    pub actor_user_id: i32,
    pub kind: &'static str,
    pub label: Option<String>,
    pub method: Option<String>,
    pub path: Option<String>,
    pub status_code: Option<i32>,
    pub ip: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl ActivityRow {
    pub fn new(actor_user_id: i32, kind: &'static str) -> Self {
        Self {
            actor_user_id,
            kind,
            label: None,
            method: None,
            path: None,
            status_code: None,
            ip: None,
            created_at: Utc::now(),
        }
    }
}

/// Queue one activity row. Never blocks and never touches the DB. It's a
/// no-op when the writer isn't running (worker-only roles, unit tests).
pub fn enqueue(row: ActivityRow) {
    let Some(tx) = QUEUE.get() else {
        return;
    };
    if tx.try_send(row).is_err() {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}

/// Start the single batching writer. Call once per process; later calls are
/// ignored so a second writer can never start.
pub fn spawn_writer(pool: PgPool) {
    let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
    if QUEUE.set(tx).is_err() {
        return;
    }
    tokio::spawn(run_writer(pool, rx));
}

async fn run_writer(pool: PgPool, mut rx: mpsc::Receiver<ActivityRow>) {
    let mut batch = Vec::with_capacity(MAX_BATCH);
    // `recv_many` waits for at least one row; 0 means every sender is gone.
    while rx.recv_many(&mut batch, MAX_BATCH).await > 0 {
        if let Err(err) = insert_batch(&pool, &batch).await {
            warn!(target: "activity", error = ?err, rows = batch.len(), "activity_events batch insert failed");
        }
        batch.clear();

        let dropped = DROPPED.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            warn!(target: "activity", dropped, "activity queue full; rows dropped");
        }
        tokio::time::sleep(FLUSH_INTERVAL).await;
    }
}

/// One INSERT for the whole batch: each column goes in as an array and
/// `UNNEST` zips them back into rows.
async fn insert_batch(pool: &PgPool, rows: &[ActivityRow]) -> sqlx::Result<()> {
    let mut actor_ids = Vec::with_capacity(rows.len());
    let mut kinds = Vec::with_capacity(rows.len());
    let mut labels = Vec::with_capacity(rows.len());
    let mut methods = Vec::with_capacity(rows.len());
    let mut paths = Vec::with_capacity(rows.len());
    let mut status_codes = Vec::with_capacity(rows.len());
    let mut ips = Vec::with_capacity(rows.len());
    let mut created_ats = Vec::with_capacity(rows.len());
    for row in rows {
        actor_ids.push(row.actor_user_id);
        kinds.push(row.kind);
        labels.push(row.label.as_deref());
        methods.push(row.method.as_deref());
        paths.push(row.path.as_deref());
        status_codes.push(row.status_code);
        ips.push(row.ip.as_deref());
        created_ats.push(row.created_at);
    }

    sqlx::query(
        r#"
        INSERT INTO activity_events
            (actor_user_id, kind, label, method, path, status_code, ip, created_at)
        SELECT * FROM UNNEST(
            $1::int4[], $2::text[], $3::text[], $4::text[],
            $5::text[], $6::int4[], $7::text[], $8::timestamptz[]
        )
        "#,
    )
    .bind(&actor_ids)
    .bind(&kinds)
    .bind(&labels)
    .bind(&methods)
    .bind(&paths)
    .bind(&status_codes)
    .bind(&ips)
    .bind(&created_ats)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[actix_web::test]
    async fn insert_batch_writes_every_row_with_its_fields() {
        let pool = crate::test_support::test_pool().await;
        let user_id = crate::test_support::insert_local_user(
            &pool,
            &crate::test_support::random_email(),
            "pw",
        )
        .await;

        let mut api = ActivityRow::new(user_id, "api_request");
        api.method = Some("GET".into());
        api.path = Some("/api/me".into());
        api.status_code = Some(200);
        api.ip = Some("203.0.113.7".into());
        let mut click = ActivityRow::new(user_id, "click");
        click.label = Some("Save".into());

        insert_batch(&pool, &[api, click])
            .await
            .unwrap_or_else(|err| panic!("batch insert failed: {err}"));

        let rows: Vec<Stored> = sqlx::query_as(
            "SELECT kind, label, method, path, status_code, ip FROM activity_events \
             WHERE actor_user_id = $1 ORDER BY kind",
        )
        .bind(user_id)
        .fetch_all(&pool)
        .await
        .unwrap_or_else(|err| panic!("select failed: {err}"));

        assert_eq!(
            rows,
            vec![
                Stored {
                    kind: "api_request".into(),
                    label: None,
                    method: Some("GET".into()),
                    path: Some("/api/me".into()),
                    status_code: Some(200),
                    ip: Some("203.0.113.7".into()),
                },
                Stored {
                    kind: "click".into(),
                    label: Some("Save".into()),
                    method: None,
                    path: None,
                    status_code: None,
                    ip: None,
                },
            ]
        );
    }

    #[derive(Debug, PartialEq, FromRow)]
    struct Stored {
        kind: String,
        label: Option<String>,
        method: Option<String>,
        path: Option<String>,
        status_code: Option<i32>,
        ip: Option<String>,
    }
}
