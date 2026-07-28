//! Pure GitLab and Wayve field mappings. No DB or network, so they are unit-tested
//! in place. GitLab issues have no built-in status workflow or priority, so these
//! are best-effort heuristics over state and common label conventions, isolated
//! here for easy tuning.

use super::models::GitlabIssue;

/// A GitLab issue's fields mapped onto the Wayve `tasks` columns.
pub struct MappedFields {
    pub name: String,
    pub description: String,
    /// A Wayve status *category*, resolved to a real slug by the caller via
    /// `tasks::statuses::CategoryResolver`.
    pub category: &'static str,
    pub priority: i16,
}

pub fn map_issue(issue: &GitlabIssue) -> MappedFields {
    let title = issue.title.trim();
    let name = if title.is_empty() {
        format!("#{}", issue.iid)
    } else {
        title.to_string()
    };
    MappedFields {
        name,
        description: issue.description.clone().unwrap_or_default(),
        category: gitlab_state_to_category(&issue.state, &issue.labels),
        priority: gitlab_priority_from_labels(&issue.labels),
    }
}

/// A closed issue is completed; an open one is refined by common workflow labels.
///
/// Returns a Wayve *category*, not a status slug — slugs are user-configurable,
/// so an importer can't know one exists.
pub fn gitlab_state_to_category(state: &str, labels: &[String]) -> &'static str {
    if state.eq_ignore_ascii_case("closed") {
        return "completed";
    }
    let has = |needle: &str| labels.iter().any(|l| l.to_lowercase().contains(needle));
    if has("review") || has("progress") || has("doing") {
        "in_progress"
    } else {
        "backlog"
    }
}

/// GitLab has no native priority field, so this sniffs common label conventions
/// onto Wayve's 1..=5 scale (1 highest) and defaults to 3, Medium.
pub fn gitlab_priority_from_labels(labels: &[String]) -> i16 {
    let has = |needle: &str| labels.iter().any(|l| l.to_lowercase().contains(needle));
    if has("critical") || has("highest") || has("urgent") {
        1
    } else if has("high") {
        2
    } else if has("low") {
        4
    } else {
        3
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(state: &str, labels: &[&str], title: &str, iid: i32) -> GitlabIssue {
        GitlabIssue {
            iid,
            project_id: 1,
            title: title.to_string(),
            description: Some("body".to_string()),
            state: state.to_string(),
            labels: labels.iter().map(|s| s.to_string()).collect(),
            web_url: "https://gitlab.com/x/y/-/issues/1".to_string(),
        }
    }

    #[test]
    fn status_mapping() {
        assert_eq!(gitlab_state_to_category("closed", &[]), "completed");
        assert_eq!(gitlab_state_to_category("opened", &[]), "backlog");
        assert_eq!(
            gitlab_state_to_category("opened", &["In Progress".into()]),
            "in_progress"
        );
        // Review labels share the in_progress category; which concrete status
        // an issue lands on is the resolver's call, not this mapping's.
        assert_eq!(
            gitlab_state_to_category("opened", &["needs review".into()]),
            "in_progress"
        );
    }

    #[test]
    fn priority_mapping() {
        assert_eq!(gitlab_priority_from_labels(&["critical".into()]), 1);
        assert_eq!(gitlab_priority_from_labels(&["priority::high".into()]), 2);
        assert_eq!(gitlab_priority_from_labels(&["low".into()]), 4);
        assert_eq!(gitlab_priority_from_labels(&["bug".into()]), 3);
        assert_eq!(gitlab_priority_from_labels(&[]), 3);
    }

    #[test]
    fn map_issue_uses_iid_when_title_blank() {
        let mapped = map_issue(&issue("opened", &[], "  ", 42));
        assert_eq!(mapped.name, "#42");
        assert_eq!(mapped.category, "backlog");
        assert_eq!(mapped.priority, 3);
        assert_eq!(mapped.description, "body");
    }
}
