//! The assistant's view of the workspace boards: user stories and tickets.
//!
//! Listing runs immediately. A status change never writes here: the tool only
//! resolves which item and which status the user meant and returns a
//! [`PendingAction::SetStatus`], which the chat shows as a card. The browser
//! makes the change through the board's own update endpoint once the user
//! confirms, so the status history, audit log and permission checks are the
//! ones every other edit goes through.
//!
//! Everything is scoped to the caller's owner ([`statuses::owner_for_user`]),
//! exactly as the boards are: an organization member works on the
//! organization's shared list, everyone else on their own.

use super::agent::PendingAction;
use crate::prelude::*;
use crate::tasks::statuses::{self, StatusOwner, TaskStatus};
use sqlx::Row;
use tracing::warn;

/// Most items one listing returns. A board past this is filtered by status.
const LIST_LIMIT: usize = 100;

/// How many near matches an "which one did you mean?" error names.
const CANDIDATE_LIMIT: usize = 8;

/// Which board a tool works on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Board {
    UserStories,
    Tickets,
}

impl Board {
    fn table(self) -> &'static str {
        match self {
            Board::UserStories => "user_stories",
            Board::Tickets => "workspace_tickets",
        }
    }

    fn number_col(self) -> &'static str {
        match self {
            Board::UserStories => "story_number",
            Board::Tickets => "ticket_number",
        }
    }

    /// Bug tickets mirrored from support reports belong to the platform's
    /// queue, not the owner's board, so the assistant leaves them alone.
    fn extra_filter(self) -> &'static str {
        match self {
            Board::UserStories => "",
            Board::Tickets => " AND t.support_ticket_id IS NULL",
        }
    }

    /// The value of the pending action's `kind`, and the key the listing uses.
    fn kind(self) -> &'static str {
        match self {
            Board::UserStories => "user_story",
            Board::Tickets => "ticket",
        }
    }

    fn plural(self) -> &'static str {
        match self {
            Board::UserStories => "user stories",
            Board::Tickets => "tickets",
        }
    }

    /// The argument naming the item in the set-status tool.
    fn item_arg(self) -> &'static str {
        match self {
            Board::UserStories => "story",
            Board::Tickets => "ticket",
        }
    }
}

/// One board row, as much of it as the assistant needs.
struct Item {
    id: i32,
    number: Option<i32>,
    name: String,
    status: String,
    priority: i16,
    assignee: String,
    project: Option<String>,
}

/// The first three letters or digits of a project's name, or "" without any.
fn project_prefix(project: Option<&str>) -> String {
    project
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(3)
        .collect()
}

/// The key the board shows for an item, so the assistant and the user name
/// things the same way. Mirrors the frontend: a story is `SAM004` (or `NON004`
/// with no project, see `userstories/storyKey.ts`); a ticket is `sam4`, or
/// `#4` with no project (`taskKey` in `tasks/Tasks.tsx`).
pub(crate) fn display_key(board: Board, number: i32, project: Option<&str>) -> String {
    let prefix = project_prefix(project);
    match board {
        Board::UserStories => {
            let prefix = if prefix.is_empty() {
                "NON".to_string()
            } else {
                prefix.to_ascii_uppercase()
            };
            format!("{prefix}{number:03}")
        }
        Board::Tickets if prefix.is_empty() => format!("#{number}"),
        Board::Tickets => format!("{}{number}", prefix.to_ascii_lowercase()),
    }
}

fn key_of(board: Board, item: &Item) -> Option<String> {
    item.number
        .map(|n| display_key(board, n, item.project.as_deref()))
}

fn tool_error(message: impl Into<String>) -> Value {
    serde_json::json!({ "isError": true, "error": message.into() })
}

async fn load_items(
    pool: &PgPool,
    owner: StatusOwner,
    board: Board,
) -> Result<Vec<Item>, AppError> {
    let (org_id, uid) = match owner {
        StatusOwner::Organization(id) => (Some(id), None),
        StatusOwner::User(id) => (None, Some(id)),
    };
    let rows = sqlx::query(&format!(
        "SELECT t.id, t.{number} AS number, t.name, t.status, t.priority, t.assignee,
                p.name AS project
           FROM {table} t
           LEFT JOIN projects p ON p.id = t.project_id
          WHERE (($1::INTEGER IS NOT NULL AND t.organization_id = $1)
              OR ($2::INTEGER IS NOT NULL AND t.user_id = $2)){extra}
          ORDER BY t.priority ASC, t.created_at ASC, t.id ASC",
        number = board.number_col(),
        table = board.table(),
        extra = board.extra_filter(),
    ))
    .bind(org_id)
    .bind(uid)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| Item {
            id: row.get("id"),
            number: row.try_get("number").ok().flatten(),
            name: row.get("name"),
            status: row.get("status"),
            priority: row.get("priority"),
            assignee: row.try_get("assignee").unwrap_or_default(),
            project: row.try_get("project").ok().flatten(),
        })
        .collect())
}

/// The owner's board and its statuses, or the tool error to return instead.
async fn load_board(
    pool: &PgPool,
    user_id: i32,
    board: Board,
) -> Result<(Vec<Item>, Vec<TaskStatus>), Value> {
    let loaded = async {
        let owner = statuses::owner_for_user(pool, user_id).await?;
        let available = statuses::load(pool, owner).await?;
        let items = load_items(pool, owner, board).await?;
        Ok::<_, AppError>((items, available))
    }
    .await;
    loaded.map_err(|e| {
        warn!(target: "ai", error = ?e, board = ?board, "workspace tool could not load the board");
        tool_error(format!("Could not load {}", board.plural()))
    })
}

/// A status by its name or slug, ignoring case and surrounding space.
fn find_status<'a>(available: &'a [TaskStatus], wanted: &str) -> Option<&'a TaskStatus> {
    let wanted = wanted.trim();
    available
        .iter()
        .find(|s| s.slug.eq_ignore_ascii_case(wanted) || s.name.eq_ignore_ascii_case(wanted))
}

fn status_name(available: &[TaskStatus], slug: &str) -> String {
    available
        .iter()
        .find(|s| s.slug == slug)
        .map_or_else(|| slug.to_string(), |s| s.name.clone())
}

fn status_names(available: &[TaskStatus]) -> Vec<&str> {
    available.iter().map(|s| s.name.as_str()).collect()
}

fn unknown_status(available: &[TaskStatus], wanted: &str) -> Value {
    tool_error(format!(
        "There is no status '{wanted}'. The statuses are: {}.",
        status_names(available).join(", ")
    ))
}

fn item_json(board: Board, item: &Item, available: &[TaskStatus]) -> Value {
    serde_json::json!({
        "key": key_of(board, item),
        "name": item.name,
        "status": status_name(available, &item.status),
        "priority": item.priority,
        "assignee": item.assignee,
        "project": item.project,
    })
}

/// `wayve_list_user_stories` / `wayve_list_tickets`: the board's items, with an
/// optional status filter, plus the statuses an item can be moved to.
pub(crate) async fn list(pool: &PgPool, user_id: i32, board: Board, args: &Value) -> Value {
    let (items, available) = match load_board(pool, user_id, board).await {
        Ok(loaded) => loaded,
        Err(error) => return error,
    };

    let wanted = args
        .get("status")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let slug = match wanted {
        Some(w) => match find_status(&available, w) {
            Some(s) => Some(s.slug.as_str()),
            None => return unknown_status(&available, w),
        },
        None => None,
    };

    let matching: Vec<&Item> = items
        .iter()
        .filter(|i| slug.is_none_or(|s| i.status == s))
        .collect();
    let listed: Vec<Value> = matching
        .iter()
        .take(LIST_LIMIT)
        .map(|i| item_json(board, i, &available))
        .collect();

    serde_json::json!({
        "statuses": status_names(&available),
        "total": matching.len(),
        "truncated": matching.len() > LIST_LIMIT,
        "items": listed,
    })
}

/// What a lookup by the user's words came to.
enum Found<'a> {
    One(&'a Item),
    None,
    Several(Vec<&'a Item>),
}

/// Finds the item the user named: by its key, then its number, then its exact
/// name, then a name containing the words. Each step only counts when it is
/// unambiguous, so "login" matching two stories asks which rather than guessing.
fn find_item<'a>(board: Board, items: &'a [Item], wanted: &str) -> Found<'a> {
    let wanted = wanted.trim();
    let one_or = |matches: Vec<&'a Item>| match matches.len() {
        0 => None,
        1 => matches.first().copied().map(Found::One),
        _ => Some(Found::Several(matches)),
    };

    let by_key: Vec<&Item> = items
        .iter()
        .filter(|i| key_of(board, i).is_some_and(|k| k.eq_ignore_ascii_case(wanted)))
        .collect();
    if let Some(found) = one_or(by_key) {
        return found;
    }

    if let Ok(number) = wanted.trim_start_matches('#').parse::<i32>() {
        let by_number: Vec<&Item> = items.iter().filter(|i| i.number == Some(number)).collect();
        if let Some(found) = one_or(by_number) {
            return found;
        }
    }

    let lower = wanted.to_lowercase();
    let by_name: Vec<&Item> = items
        .iter()
        .filter(|i| i.name.trim().to_lowercase() == lower)
        .collect();
    if let Some(found) = one_or(by_name) {
        return found;
    }

    let containing: Vec<&Item> = items
        .iter()
        .filter(|i| i.name.to_lowercase().contains(&lower))
        .collect();
    one_or(containing).unwrap_or(Found::None)
}

/// `wayve_set_user_story_status` / `wayve_set_ticket_status`. Proposes the
/// change; it must never write (see the module docs).
pub(crate) async fn propose_status(
    pool: &PgPool,
    user_id: i32,
    board: Board,
    args: &Value,
) -> (Value, Option<PendingAction>) {
    let str_arg = |key: &str| {
        args.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let wanted_item = str_arg(board.item_arg());
    let wanted_status = str_arg("status");
    if wanted_item.is_empty() || wanted_status.is_empty() {
        return (
            tool_error(format!("`{}` and `status` are required", board.item_arg())),
            None,
        );
    }

    let (items, available) = match load_board(pool, user_id, board).await {
        Ok(loaded) => loaded,
        Err(error) => return (error, None),
    };
    let Some(target) = find_status(&available, &wanted_status) else {
        return (unknown_status(&available, &wanted_status), None);
    };

    let item = match find_item(board, &items, &wanted_item) {
        Found::One(item) => item,
        Found::None => {
            return (
                tool_error(format!(
                    "No {} matches '{wanted_item}'. List them to find the right one.",
                    board.item_arg()
                )),
                None,
            );
        }
        Found::Several(matches) => {
            let candidates: Vec<Value> = matches
                .iter()
                .take(CANDIDATE_LIMIT)
                .map(|i| item_json(board, i, &available))
                .collect();
            return (
                serde_json::json!({
                    "isError": true,
                    "error": format!(
                        "More than one {} matches '{wanted_item}'. Ask the user which one, \
                         then call again with its key.",
                        board.item_arg()
                    ),
                    "candidates": candidates,
                }),
                None,
            );
        }
    };

    let key = key_of(board, item);
    if item.status == target.slug {
        return (
            serde_json::json!({
                "status": "unchanged",
                "note": format!("It is already in '{}'. Nothing to do.", target.name),
                "key": key,
                "name": item.name,
            }),
            None,
        );
    }

    (
        serde_json::json!({
            "status": "awaiting_confirmation",
            "note": "The change is shown to the user for confirmation. It has NOT been made \
                     yet — say it is waiting for their confirmation, not that it is done.",
            "key": key,
            "name": item.name,
            "from": status_name(&available, &item.status),
            "to": target.name,
        }),
        Some(PendingAction::SetStatus {
            kind: board.kind().to_string(),
            id: item.id,
            key,
            name: item.name.clone(),
            from_status: status_name(&available, &item.status),
            to_status: target.slug.clone(),
            to_status_name: target.name.clone(),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: i32, number: i32, name: &str, project: Option<&str>) -> Item {
        Item {
            id,
            number: Some(number),
            name: name.to_string(),
            status: "todo".to_string(),
            priority: 3,
            assignee: String::new(),
            project: project.map(str::to_string),
        }
    }

    fn found_id(found: Found<'_>) -> Option<i32> {
        match found {
            Found::One(i) => Some(i.id),
            _ => None,
        }
    }

    #[test]
    fn story_keys_match_the_board() {
        assert_eq!(
            display_key(Board::UserStories, 4, Some("Sample One")),
            "SAM004"
        );
        assert_eq!(display_key(Board::UserStories, 3, None), "NON003");
        assert_eq!(display_key(Board::UserStories, 7, Some("a-b c!")), "ABC007");
        assert_eq!(display_key(Board::UserStories, 5, Some("QA")), "QA005");
        assert_eq!(
            display_key(Board::UserStories, 1000, Some("Sample")),
            "SAM1000"
        );
    }

    #[test]
    fn ticket_keys_match_the_board() {
        assert_eq!(display_key(Board::Tickets, 12, Some("Wayve")), "way12");
        assert_eq!(display_key(Board::Tickets, 12, None), "#12");
    }

    #[test]
    fn finds_a_story_by_key_number_or_name() {
        let items = vec![
            item(10, 1, "Login page", Some("Apollo")),
            item(11, 3, "Checkout flow", None),
        ];
        let find = |w: &str| found_id(find_item(Board::UserStories, &items, w));
        assert_eq!(find("APO001"), Some(10));
        assert_eq!(find("apo001"), Some(10));
        assert_eq!(find("NON003"), Some(11));
        assert_eq!(find("#3"), Some(11));
        assert_eq!(find("3"), Some(11));
        assert_eq!(find("checkout flow"), Some(11));
        assert_eq!(find("login"), Some(10));
        assert_eq!(find("nothing like it"), None);
    }

    #[test]
    fn an_ambiguous_name_is_not_guessed() {
        let items = vec![
            item(10, 1, "Login page", None),
            item(11, 2, "Login errors", None),
        ];
        assert!(matches!(
            find_item(Board::UserStories, &items, "login"),
            Found::Several(m) if m.len() == 2
        ));
        // The exact name still wins over the looser match.
        assert_eq!(
            found_id(find_item(Board::UserStories, &items, "Login page")),
            Some(10)
        );
    }
}
