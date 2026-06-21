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
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
    /// Linked Jira issue key (e.g. "WAY-12"), set only by the Jira importer;
    /// None for tasks with no Jira link. `jira_base` is the site root so the UI
    /// can deep-link to the issue.
    pub jira_issue_key: Option<String>,
    pub jira_base: Option<String>,
}

#[derive(Deserialize)]
pub struct TaskInput {
    pub name: String,
    pub description: Option<String>,
    pub priority: Option<i16>,
    pub status: Option<String>,
    pub assigned_by: Option<String>,
    pub assignee: Option<String>,
}
