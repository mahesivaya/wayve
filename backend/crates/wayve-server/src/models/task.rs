use crate::prelude::*;

#[derive(Serialize, FromRow)]
pub struct Task {
    pub id: i32,
    pub name: String,
    pub description: String,
    pub priority: i16,
    pub status: String,
    pub assigned_by: String,
    pub assignee: String,
    /// Real assigned user (FK `users`). The free-text `assignee` above is kept
    /// for display / reference names that don't map to a Wayve account; this is
    /// the authoritative link set when a suggested member is chosen.
    pub assignee_id: Option<i32>,
    /// Project the task belongs to (FK `projects`) — resolves to a GitHub repo
    /// and drives the assignee-suggestion feature.
    pub project_id: Option<i32>,
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
    /// Linked Jira issue key (e.g. "WAY-12"), set only by the Jira importer;
    /// None for tasks with no Jira link. `jira_base` is the site root so the UI
    /// can deep-link to the issue.
    pub jira_issue_key: Option<String>,
    pub jira_base: Option<String>,
    /// Linked GitLab issue iid + direct web URL, set only by the GitLab
    /// importer; None for tasks with no GitLab link.
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
    /// Chosen assigned user (from a suggestion or the assignable-users list).
    pub assignee_id: Option<i32>,
    /// Project the task is created on — set from the create-form dropdown.
    pub project_id: Option<i32>,
}
