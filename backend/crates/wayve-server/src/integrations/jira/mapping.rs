//! Pure Jira and Wayve field mappings. No DB or network, so they are unit-tested
//! in place. Jira workflows are customizable, so these are best-effort heuristics,
//! isolated here for easy tuning.

use super::models::JiraFields;
use crate::prelude::*;

/// The single source of truth for the Jira-to-`tasks` translation, shared by the
/// on-demand import and the webhook.
pub struct MappedFields {
    /// The issue summary, or the issue key when the summary is blank.
    pub name: String,
    pub description: String,
    /// A Wayve status *category*, resolved to a real slug by the caller via
    /// `tasks::statuses::CategoryResolver`.
    pub category: &'static str,
    /// The Jira status display name, passed to
    /// `CategoryResolver::slug_for_hinted` so an org that kept a review status
    /// still gets "In Review" issues routed there rather than to "In Progress".
    pub status_name: String,
    pub priority: i16,
}

pub fn map_issue_fields(key: &str, fields: &JiraFields) -> MappedFields {
    let summary = fields.summary.trim();
    let name = if summary.is_empty() {
        key.to_string()
    } else {
        summary.to_string()
    };
    let description = jira_description_to_text(&fields.description);
    let (category, status_name) = match &fields.status {
        Some(s) => (
            s.status_category
                .as_ref()
                .map(|c| c.key.as_str())
                .unwrap_or(""),
            s.name.as_str(),
        ),
        None => ("", ""),
    };
    let mapped_category = jira_status_to_category(category, status_name);
    let priority = jira_priority_to_wayve(fields.priority.as_ref().map(|p| p.name.as_str()));
    MappedFields {
        name,
        description,
        category: mapped_category,
        status_name: status_name.to_string(),
        priority,
    }
}

/// Jira's category key is one of `new`, `indeterminate`, or `done`.
///
/// Returns a Wayve *category*, not a status slug: slugs are user-configurable, so
/// an importer can't know one exists. `tasks::statuses::CategoryResolver` turns
/// the category into whichever slug this owner actually has there.
pub fn jira_status_to_category(category_key: &str, _status_name: &str) -> &'static str {
    match category_key {
        "done" => "completed",
        "indeterminate" => "in_progress",
        // "new" and anything unrecognised.
        _ => "backlog",
    }
}

/// Wayve's scale is 1..=5, 1 highest — the same direction Jira's own P1..P5
/// naming reads. Unknown or missing falls back to 3, Medium.
pub fn jira_priority_to_wayve(name: Option<&str>) -> i16 {
    match name.map(|n| n.trim().to_lowercase()).as_deref() {
        Some("highest") => 1,
        Some("high") => 2,
        Some("low") => 4,
        Some("lowest") => 5,
        _ => 3,
    }
}

/// The Jira status category a Wayve *category* should land in when pushing back.
/// Used to pick a transition whose target `statusCategory.key` matches.
pub fn wayve_category_to_jira_category(category: &str) -> &'static str {
    match category {
        // Canceled has no Jira equivalent; closing the issue is the closest
        // truthful mapping, and matches what a cancelled task means locally.
        "completed" | "canceled" => "done",
        "in_progress" => "indeterminate",
        _ => "new",
    }
}

/// Jira Cloud v3 returns Atlassian Document Format JSON, but a plain string or
/// null is tolerated too.
pub fn jira_description_to_text(value: &Option<Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => {
            let mut out = String::new();
            collect_adf_text(v, &mut out);
            out.trim().to_string()
        }
    }
}

fn collect_adf_text(node: &Value, out: &mut String) {
    match node {
        Value::Array(items) => {
            for item in items {
                collect_adf_text(item, out);
            }
        }
        Value::Object(map) => {
            let node_type = map.get("type").and_then(Value::as_str).unwrap_or("");
            if node_type == "text"
                && let Some(Value::String(t)) = map.get("text")
            {
                out.push_str(t);
            }
            if node_type == "hardBreak" {
                out.push('\n');
            }
            if let Some(content) = map.get("content") {
                collect_adf_text(content, out);
            }
            if node_type == "paragraph" {
                out.push('\n');
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mapping() {
        assert_eq!(jira_status_to_category("new", "To Do"), "backlog");
        assert_eq!(
            jira_status_to_category("indeterminate", "In Progress"),
            "in_progress"
        );
        // Both halves of Jira's "indeterminate" map to the same category; the
        // In Progress / In Review split is recovered from `status_name` by
        // CategoryResolver::slug_for_hinted, not here.
        assert_eq!(
            jira_status_to_category("indeterminate", "In Review"),
            "in_progress"
        );
        assert_eq!(jira_status_to_category("done", "Done"), "completed");
        assert_eq!(jira_status_to_category("weird", "Whatever"), "backlog");
    }

    #[test]
    fn priority_mapping() {
        assert_eq!(jira_priority_to_wayve(Some("Highest")), 1);
        assert_eq!(jira_priority_to_wayve(Some("high")), 2);
        assert_eq!(jira_priority_to_wayve(Some("Medium")), 3);
        assert_eq!(jira_priority_to_wayve(Some("Low")), 4);
        assert_eq!(jira_priority_to_wayve(Some("LOWEST")), 5);
        assert_eq!(jira_priority_to_wayve(None), 3);
        assert_eq!(jira_priority_to_wayve(Some("Critical")), 3);
    }

    #[test]
    fn wayve_category_to_jira() {
        assert_eq!(wayve_category_to_jira_category("backlog"), "new");
        assert_eq!(wayve_category_to_jira_category("planned"), "new");
        assert_eq!(
            wayve_category_to_jira_category("in_progress"),
            "indeterminate"
        );
        assert_eq!(wayve_category_to_jira_category("completed"), "done");
        // Jira has no "canceled"; closing the issue is the closest truthful map.
        assert_eq!(wayve_category_to_jira_category("canceled"), "done");
    }

    #[test]
    fn description_adf_flatten() {
        let adf = serde_json::json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Hello " },
                    { "type": "text", "text": "world" }
                ]},
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "second line" }
                ]}
            ]
        });
        let text = jira_description_to_text(&Some(adf));
        assert_eq!(text, "Hello world\nsecond line");
    }

    #[test]
    fn description_edge_cases() {
        assert_eq!(jira_description_to_text(&None), "");
        assert_eq!(jira_description_to_text(&Some(Value::Null)), "");
        assert_eq!(
            jira_description_to_text(&Some(Value::String("plain".into()))),
            "plain"
        );
    }
}
