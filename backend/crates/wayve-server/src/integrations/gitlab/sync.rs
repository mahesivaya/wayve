//! Tasks ← GitLab sync: on-demand pull of assigned issues into tasks.

use crate::prelude::*;

use super::client::GitlabClient;
use super::mapping::map_issue;
use super::models::GitlabConnection;
use crate::tasks::statuses;

/// Pull issues assigned to the connected user into their tasks, upserting on
/// `(user_id, gitlab_project_id, gitlab_issue_iid)` so re-imports update in place.
pub async fn pull(
    pool: &PgPool,
    user_id: i32,
    conn: &GitlabConnection,
    state: &str,
    max_results: u32,
) -> Result<(usize, usize), AppError> {
    let client = GitlabClient::new(conn);
    let issues = client.list_assigned_issues(state, max_results).await?;

    if issues.is_empty() {
        return Ok((0, 0));
    }

    // Statuses are user-configurable, so the importer can't hardcode a slug. Load
    // this user's set once here rather than per issue, since the upsert below
    // builds its rows inside a synchronous closure.
    let owner = statuses::owner_for_user(pool, user_id).await?;
    let resolver = statuses::category_resolver(pool, owner).await?;

    // One multi-row upsert, not a round-trip per issue. `(xmax::text = '0')` is
    // true only for a fresh INSERT, because an ON CONFLICT UPDATE stamps xmax with
    // the updating xid, so the per-row flag separates imported from updated. Issues
    // are unique by (project_id, iid), so no row conflicts twice in the batch.
    let mut qb: sqlx::QueryBuilder<sqlx::Postgres> = sqlx::QueryBuilder::new(
        "INSERT INTO tasks \
            (user_id, name, description, priority, status, \
             gitlab_issue_iid, gitlab_project_id, gitlab_web_url) ",
    );
    qb.push_values(issues.iter(), |mut b, issue| {
        let mapped = map_issue(issue);
        b.push_bind(user_id)
            .push_bind(mapped.name)
            .push_bind(mapped.description)
            .push_bind(mapped.priority)
            .push_bind(resolver.slug_for(mapped.category))
            .push_bind(issue.iid)
            .push_bind(issue.project_id)
            .push_bind(issue.web_url.clone());
    });
    qb.push(
        " ON CONFLICT (user_id, gitlab_project_id, gitlab_issue_iid) \
            WHERE gitlab_issue_iid IS NOT NULL \
          DO UPDATE SET \
            name = EXCLUDED.name, \
            description = EXCLUDED.description, \
            priority = EXCLUDED.priority, \
            status = EXCLUDED.status, \
            gitlab_web_url = EXCLUDED.gitlab_web_url, \
            updated_at = NOW() \
          RETURNING (xmax::text = '0') AS inserted",
    );
    let flags: Vec<bool> = qb.build_query_scalar().fetch_all(pool).await?;
    let imported = flags.iter().filter(|&&b| b).count();
    let updated = flags.len() - imported;
    Ok((imported, updated))
}
