//! Tasks ← GitLab sync: on-demand pull of assigned issues into tasks.

use crate::prelude::*;

use super::client::GitlabClient;
use super::mapping::map_issue;
use super::models::GitlabConnection;

/// Pull issues assigned to the connected user into their tasks, upserting on
/// `(user_id, gitlab_project_id, gitlab_issue_iid)` so re-imports update in
/// place. Returns `(imported, updated)`.
pub async fn pull(
    pool: &PgPool,
    user_id: i32,
    conn: &GitlabConnection,
    state: &str,
    max_results: u32,
) -> Result<(usize, usize), AppError> {
    let client = GitlabClient::new(conn);
    let issues = client.list_assigned_issues(state, max_results).await?;

    let mut imported = 0usize;
    let mut updated = 0usize;
    for issue in issues {
        let mapped = map_issue(&issue);

        // `(xmax::text = '0')` is true only for a fresh INSERT; an ON CONFLICT
        // UPDATE stamps xmax with the updating xid.
        let inserted: bool = sqlx::query_scalar(
            "INSERT INTO tasks
                (user_id, name, description, priority, status,
                 gitlab_issue_iid, gitlab_project_id, gitlab_web_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, gitlab_project_id, gitlab_issue_iid)
                WHERE gitlab_issue_iid IS NOT NULL
             DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                priority = EXCLUDED.priority,
                status = EXCLUDED.status,
                gitlab_web_url = EXCLUDED.gitlab_web_url,
                updated_at = NOW()
             RETURNING (xmax::text = '0') AS inserted",
        )
        .bind(user_id)
        .bind(&mapped.name)
        .bind(&mapped.description)
        .bind(mapped.priority)
        .bind(mapped.status)
        .bind(issue.iid)
        .bind(issue.project_id)
        .bind(&issue.web_url)
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
