//! Tasks ↔ Jira sync: on-demand pull (issues → tasks) and best-effort push
//! (a linked task's summary/status → Jira on update).

use crate::models::task::Task;
use crate::prelude::*;
use tracing::warn;

use super::client::JiraClient;
use super::mapping::{map_issue_fields, wayve_status_to_jira_category};
use super::models::JiraConnection;

/// Pull issues matching `jql` into the user's tasks, upserting on
/// `(user_id, jira_issue_key)` so re-imports update in place. Returns
/// `(imported, updated)`.
pub async fn pull(
    pool: &PgPool,
    user_id: i32,
    conn: &JiraConnection,
    jql: &str,
    max_results: u32,
) -> Result<(usize, usize), AppError> {
    let client = JiraClient::new(conn);
    let issues = client.search(jql, max_results).await?;

    let mut imported = 0usize;
    let mut updated = 0usize;
    for issue in issues {
        let mapped = map_issue_fields(&issue.key, &issue.fields);

        // `(xmax::text = '0')` is true only for a fresh INSERT; an ON CONFLICT
        // UPDATE stamps xmax with the updating xid.
        let inserted: bool = sqlx::query_scalar(
            "INSERT INTO tasks
                (user_id, name, description, priority, status, jira_issue_key, jira_base)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id, jira_issue_key) WHERE jira_issue_key IS NOT NULL
             DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                priority = EXCLUDED.priority,
                status = EXCLUDED.status,
                jira_base = EXCLUDED.jira_base,
                updated_at = NOW()
             RETURNING (xmax::text = '0') AS inserted",
        )
        .bind(user_id)
        .bind(&mapped.name)
        .bind(&mapped.description)
        .bind(mapped.priority)
        .bind(mapped.status)
        .bind(&issue.key)
        .bind(&conn.base_url)
        .fetch_one(pool)
        .await?;

        if inserted {
            imported += 1;
        } else {
            updated += 1;
        }
    }
    Ok((imported, updated))
}

/// Push a task's summary + status back to its linked Jira issue. No-op unless
/// the task has a `jira_issue_key` and the user has an enabled connection.
/// **Best-effort**: any failure is logged and swallowed so a Jira outage never
/// fails a Wayve task edit.
pub async fn push_task_if_linked(pool: &PgPool, user_id: i32, task: &Task) {
    let Some(key) = task.jira_issue_key.as_deref() else {
        return;
    };
    if let Err(e) = push_inner(pool, user_id, key, task).await {
        warn!(target: "worker", error = ?e, task_id = task.id, "jira push failed");
    }
}

async fn push_inner(pool: &PgPool, user_id: i32, key: &str, task: &Task) -> Result<(), AppError> {
    let Some(conn) = super::handler::load_connection(pool, user_id).await? else {
        return Ok(());
    };
    if !conn.enabled {
        return Ok(());
    }
    let client = JiraClient::new(&conn);

    client.update_summary(key, &task.name).await?;

    // Move the issue to a status whose category matches the Wayve status. If the
    // Jira workflow allows no such transition from the current state, skip it.
    let target = wayve_status_to_jira_category(&task.status);
    let transitions = client.list_transitions(key).await?;
    if let Some(t) = transitions.iter().find(|t| {
        t.to.as_ref()
            .and_then(|s| s.status_category.as_ref())
            .map(|c| c.key.as_str())
            == Some(target)
    }) {
        client.transition_issue(key, &t.id).await?;
    }
    Ok(())
}
