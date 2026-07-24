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
    /// The ticket's type, shown in the board's "Type" column, or None when it has
    /// no type. One of `bug`/`feature`/`billing`/`account`/`other`: the category
    /// of the linked report for tickets materialised from a reported bug, else
    /// the type a user picked. Always None on tasks and user stories.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge_kind: Option<String>,
    /// AI relationship labels for tickets (see `tickets/relate.rs`): `related_to`
    /// is the group's canonical ticket id, `relation_kind` is `duplicate` or
    /// `similar`. None on tasks, user stories, and unrelated tickets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_to: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relation_kind: Option<String>,
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
    /// User-set ticket type for the workspace-tickets board's "Type" column
    /// (`bug`/`feature`/`other`, …). Ignored by the tasks and user-stories
    /// handlers, which never store it.
    pub badge_kind: Option<String>,
}
