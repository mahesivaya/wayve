//! Tasks ↔ Jira sync: on-demand pull (issues → tasks) and best-effort push
//! (a linked task's summary/status → Jira on update).

use crate::models::task::Task;
use crate::prelude::*;
use tracing::warn;

use super::client::JiraClient;
use super::mapping::{map_issue_fields, wayve_status_to_jira_category};
use super::models::JiraConnection;

/// Pull issues matching `jql` into the user's tasks, upserting on
/// `(user_id, jira_issue_key)` so re-imports update in place.
pub async fn pull(
    pool: &PgPool,
    user_id: i32,
    conn: &JiraConnection,
    jql: &str,
    max_results: u32,
) -> Result<(usize, usize), AppError> {
    let client = JiraClient::new(conn);
    let issues = client.search(jql, max_results).await?;

    if issues.is_empty() {
        return Ok((0, 0));
    }

    // One multi-row upsert, not a round-trip per issue. `(xmax::text = '0')` is
    // true only for a fresh INSERT, because an ON CONFLICT UPDATE stamps xmax with
    // the updating xid, so the per-row flag separates imported from updated.
    // Search results are unique by key, so no row conflicts twice in the batch.
    let mut qb: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
        "INSERT INTO tasks \
            (user_id, name, description, priority, status, jira_issue_key, jira_base) ",
    );
    qb.push_values(issues.iter(), |mut b, issue| {
        let mapped = map_issue_fields(&issue.key, &issue.fields);
        b.push_bind(user_id)
            .push_bind(mapped.name)
            .push_bind(mapped.description)
            .push_bind(mapped.priority)
            .push_bind(mapped.status)
            .push_bind(issue.key.clone())
            .push_bind(conn.base_url.clone());
    });
    qb.push(
        " ON CONFLICT (user_id, jira_issue_key) WHERE jira_issue_key IS NOT NULL \
          DO UPDATE SET \
            name = EXCLUDED.name, \
            description = EXCLUDED.description, \
            priority = EXCLUDED.priority, \
            status = EXCLUDED.status, \
            jira_base = EXCLUDED.jira_base, \
            updated_at = NOW() \
          RETURNING (xmax::text = '0') AS inserted",
    );
    let flags: Vec<bool> = qb.build_query_scalar().fetch_all(pool).await?;
    let imported = flags.iter().filter(|&&b| b).count();
    let updated = flags.len() - imported;
    Ok((imported, updated))
}

/// Best-effort: any failure is logged and swallowed, so a Jira outage never fails
/// a Wayve task edit.
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

    // If the Jira workflow allows no transition to a matching status category from
    // the current state, skip the move rather than fail.
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
