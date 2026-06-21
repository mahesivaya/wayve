//! Pure Jira ↔ Wayve field mappings. No DB or network, so they are unit-tested
//! in place. Jira workflows are customizable, so these are best-effort
//! heuristics isolated here for easy tuning.

use super::models::JiraFields;
use crate::prelude::*;

/// A Jira issue's fields mapped onto the Wayve `tasks` columns. The single
/// source of truth for Jira→task field translation, shared by the on-demand
/// import (`sync::pull`) and the inbound webhook (`webhook`).
pub struct MappedFields {
    /// Task name: the issue summary, or the issue key when the summary is blank.
    pub name: String,
    pub description: String,
    pub status: &'static str,
    pub priority: i16,
}

/// Map a Jira issue's `key` + `fields` to the Wayve task columns.
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
    let status = jira_status_to_wayve(category, status_name);
    let priority = jira_priority_to_wayve(fields.priority.as_ref().map(|p| p.name.as_str()));
    MappedFields {
        name,
        description,
        status,
        priority,
    }
}

/// Map a Jira status (its `statusCategory.key` + display name) to a Wayve task
/// status. Jira's category key is one of `new` / `indeterminate` / `done`;
/// `indeterminate` is split into `in_progress` vs `in_review` by the name.
pub fn jira_status_to_wayve(category_key: &str, status_name: &str) -> &'static str {
    match category_key {
        "new" => "to_do",
        "done" => "done",
        "indeterminate" => {
            if status_name.to_lowercase().contains("review") {
                "in_review"
            } else {
                "in_progress"
            }
        }
        _ => "to_do",
    }
}

/// Map a Jira priority name to Wayve's 1..=5 scale (5 = highest). Unknown or
/// missing falls back to 3 (Medium).
pub fn jira_priority_to_wayve(name: Option<&str>) -> i16 {
    match name.map(|n| n.trim().to_lowercase()).as_deref() {
        Some("highest") => 5,
        Some("high") => 4,
        Some("low") => 2,
        Some("lowest") => 1,
        _ => 3,
    }
}

/// The Jira status-category a Wayve status should land in when pushing back —
/// used to pick a transition whose target `statusCategory.key` matches.
pub fn wayve_status_to_jira_category(status: &str) -> &'static str {
    match status {
        "done" => "done",
        "in_progress" | "in_review" => "indeterminate",
        _ => "new",
    }
}

/// Flatten an Atlassian Document Format (ADF) `description` value to plain text.
/// Jira Cloud v3 returns ADF JSON (nested `content[].text`); tolerate a plain
/// string or null too.
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
        assert_eq!(jira_status_to_wayve("new", "To Do"), "to_do");
        assert_eq!(
            jira_status_to_wayve("indeterminate", "In Progress"),
            "in_progress"
        );
        assert_eq!(
            jira_status_to_wayve("indeterminate", "In Review"),
            "in_review"
        );
        assert_eq!(
            jira_status_to_wayve("indeterminate", "Code Review"),
            "in_review"
        );
        assert_eq!(jira_status_to_wayve("done", "Done"), "done");
        assert_eq!(jira_status_to_wayve("weird", "Whatever"), "to_do");
    }

    #[test]
    fn priority_mapping() {
        assert_eq!(jira_priority_to_wayve(Some("Highest")), 5);
        assert_eq!(jira_priority_to_wayve(Some("high")), 4);
        assert_eq!(jira_priority_to_wayve(Some("Medium")), 3);
        assert_eq!(jira_priority_to_wayve(Some("Low")), 2);
        assert_eq!(jira_priority_to_wayve(Some("LOWEST")), 1);
        assert_eq!(jira_priority_to_wayve(None), 3);
        assert_eq!(jira_priority_to_wayve(Some("Critical")), 3);
    }

    #[test]
    fn wayve_status_to_category() {
        assert_eq!(wayve_status_to_jira_category("to_do"), "new");
        assert_eq!(
            wayve_status_to_jira_category("in_progress"),
            "indeterminate"
        );
        assert_eq!(wayve_status_to_jira_category("in_review"), "indeterminate");
        assert_eq!(wayve_status_to_jira_category("done"), "done");
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
