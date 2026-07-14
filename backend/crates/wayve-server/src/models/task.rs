use crate::prelude::*;

#[derive(Serialize, FromRow)]
pub struct Task {
    pub id: i32,
    /// Per-user task number assigned at creation. None for imported tasks, which
    /// carry their external Jira or GitLab key instead.
    pub task_number: Option<i32>,
    pub name: String,
    pub description: String,
    pub priority: i16,
    pub status: String,
    pub assigned_by: String,
    pub assignee: String,
    /// The authoritative link to a `users` row. The free-text `assignee` above
    /// remains for names that map to no Wayve account.
    pub assignee_id: Option<i32>,
    /// FK to `projects`, which resolves to a GitHub repo and drives the
    /// assignee-suggestion feature.
    pub project_id: Option<i32>,
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
    /// Set only by the Jira importer. `jira_base` is the site root, so the UI can
    /// deep-link to the issue.
    pub jira_issue_key: Option<String>,
    pub jira_base: Option<String>,
    /// Set only by the GitLab importer.
    pub gitlab_issue_iid: Option<i32>,
    pub gitlab_web_url: Option<String>,
}

#[derive(Deserialize)]
pub struct TaskInput {
    pub name: String,
    pub description: Option<String>,
    pub priority: Option<i16>,
    pub status: Option<String>,
    pub assigned_by: Option<String>,
    pub assignee: Option<String>,
    pub assignee_id: Option<i32>,
    pub project_id: Option<i32>,
}
