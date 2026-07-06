//! Wayve-native tools exposed to the AI assistant, alongside any external MCP
//! tools. Unlike MCP tools, these operate on Wayve's own data:
//!
//!   * **Read tools** (`list_email_accounts`, `list_recent_emails`,
//!     `list_meetings`) execute immediately and return data to the model.
//!   * **Action tools** (`compose_email`) are DEFERRED — they never perform the
//!     outward action. They record a `PendingAction` that the browser confirms
//!     and executes through the existing authenticated endpoint. This keeps
//!     irreversible/outward actions behind an explicit human click and out of a
//!     prompt-injectable agent loop.
//!
//! Native tool names carry a reserved prefix (`wayve_`) so they can never
//! collide with the MCP `c{idx}_` namespacing used in `agent::load_mcp_tools`.

use super::agent::{NeutralTool, PendingAction, ToolUsed};
use super::provider::DataAccess;
use crate::prelude::*;
use sqlx::Row;
use tracing::warn;
use wayve_security::encryption::decrypt;

/// Reserved namespace for native tools. `dispatch` short-circuits on it.
const PREFIX: &str = "wayve_";

const COMPOSE_EMAIL: &str = "wayve_compose_email";
const LIST_EMAIL_ACCOUNTS: &str = "wayve_list_email_accounts";
const LIST_RECENT_EMAILS: &str = "wayve_list_recent_emails";
const LIST_MEETINGS: &str = "wayve_list_meetings";

/// How many rows the read tools return.
const READ_LIMIT: usize = 10;

/// Whether a native tool's data category is allowed by `access`. Tools not tied
/// to a gated category are always allowed.
fn tool_allowed(name: &str, access: DataAccess) -> bool {
    match name {
        COMPOSE_EMAIL | LIST_EMAIL_ACCOUNTS | LIST_RECENT_EMAILS => access.email,
        LIST_MEETINGS => access.calendar,
        _ => true,
    }
}

/// The native tools declared to the model on a chat, filtered to the data
/// categories `access` allows. A disabled category's tools are never advertised
/// to the model (and `dispatch` refuses them too, as defense in depth).
pub(crate) fn declarations(access: DataAccess) -> Vec<NeutralTool> {
    let all = vec![
        NeutralTool {
            ns_name: COMPOSE_EMAIL.to_string(),
            description: Some(
                "Draft an email FROM one of the user's connected accounts. This does NOT send the \
                 email — it shows the draft to the user, who reviews and confirms it before \
                 anything is sent. Call wayve_list_email_accounts first if you need an account_id; \
                 omit account_id to let the user pick the sending account."
                    .to_string(),
            ),
            input_schema: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Recipient email address" },
                    "subject": { "type": "string", "description": "Email subject line" },
                    "body": { "type": "string", "description": "Email body, plain text" },
                    "account_id": {
                        "type": "integer",
                        "description": "Optional id of the sending account (from wayve_list_email_accounts)"
                    }
                },
                "required": ["to", "subject", "body"]
            })),
        },
        NeutralTool {
            ns_name: LIST_EMAIL_ACCOUNTS.to_string(),
            description: Some(
                "List the email accounts the user has connected, with their id, address and unread \
                 count. Use an account's id as account_id when composing an email."
                    .to_string(),
            ),
            input_schema: Some(serde_json::json!({ "type": "object", "properties": {} })),
        },
        NeutralTool {
            ns_name: LIST_RECENT_EMAILS.to_string(),
            description: Some(
                "List the user's most recent emails (subject, sender, read state, date)."
                    .to_string(),
            ),
            input_schema: Some(serde_json::json!({ "type": "object", "properties": {} })),
        },
        NeutralTool {
            ns_name: LIST_MEETINGS.to_string(),
            description: Some(
                "List the user's upcoming meetings (title, date, start and end time).".to_string(),
            ),
            input_schema: Some(serde_json::json!({ "type": "object", "properties": {} })),
        },
    ];
    all.into_iter()
        .filter(|t| tool_allowed(&t.ns_name, access))
        .collect()
}

/// Dispatch a native tool. Returns `None` when `name` is not a native tool, so
/// the caller falls through to the MCP path. The returned tuple matches
/// `agent::dispatch_tool`'s shape: `(ToolUsed, result value, pending action)`.
pub(crate) async fn dispatch(
    pool: &PgPool,
    user_id: i32,
    name: &str,
    args: &Value,
    access: DataAccess,
) -> Option<(Option<ToolUsed>, Value, Option<PendingAction>)> {
    if !name.starts_with(PREFIX) {
        return None;
    }
    // Defense in depth: a disabled category's tools aren't declared to the model,
    // but refuse them here too in case one is called regardless.
    if !tool_allowed(name, access) {
        return Some((
            None,
            serde_json::json!({
                "isError": true,
                "error": "This data category is disabled for the AI assistant."
            }),
            None,
        ));
    }
    let used = ToolUsed {
        name: name.to_string(),
        connection_label: "Wayve".to_string(),
    };
    let (value, pending) = match name {
        COMPOSE_EMAIL => compose_email(args),
        LIST_EMAIL_ACCOUNTS => (list_email_accounts(pool, user_id).await, None),
        LIST_RECENT_EMAILS => (list_recent_emails(pool, user_id).await, None),
        LIST_MEETINGS => (list_meetings(pool, user_id).await, None),
        _ => (
            serde_json::json!({ "isError": true, "error": "unknown tool" }),
            None,
        ),
    };
    Some((Some(used), value, pending))
}

/// Deferred action: validate the draft and emit a `PendingAction`. Never sends —
/// the browser performs the send through `POST /api/email/send` after the user
/// confirms.
fn compose_email(args: &Value) -> (Value, Option<PendingAction>) {
    let to = str_arg(args, "to");
    let subject = str_arg(args, "subject");
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let account_id = args
        .get("account_id")
        .and_then(|v| v.as_i64())
        .map(|n| n as i32);

    if to.is_empty() || subject.is_empty() {
        return (
            serde_json::json!({ "isError": true, "error": "`to` and `subject` are required" }),
            None,
        );
    }

    (
        serde_json::json!({
            "status": "draft_created",
            "note": "The draft is shown to the user for confirmation. Do NOT attempt to send it \
                     yourself — the user will review and send it."
        }),
        Some(PendingAction::Email {
            to,
            subject,
            body,
            account_id,
        }),
    )
}

async fn list_email_accounts(pool: &PgPool, user_id: i32) -> Value {
    match crate::email::account::load_account_summaries_for_user(pool, user_id).await {
        Ok(accounts) => serde_json::json!({
            "accounts": serde_json::to_value(&accounts).unwrap_or(Value::Null)
        }),
        Err(e) => {
            warn!(target: "ai", error = ?e, "native list_email_accounts failed");
            serde_json::json!({ "isError": true, "error": "Could not load email accounts" })
        }
    }
}

async fn list_recent_emails(pool: &PgPool, user_id: i32) -> Value {
    let filters = crate::email::repo::EmailListFilters {
        user_id,
        account_id: None,
        folder: None,
        inbox_status: None,
        search: None,
        before: None,
        page_size: READ_LIMIT,
    };
    match crate::email::repo::list(pool, filters).await {
        Ok(rows) => {
            let emails: Vec<Value> = rows
                .into_iter()
                .take(READ_LIMIT)
                .map(|r| {
                    serde_json::json!({
                        "id": r.id,
                        "subject": r.subject,
                        "from": r.sender,
                        "is_read": r.is_read,
                        "date": r.created_at.map(|d| d.to_string()),
                    })
                })
                .collect();
            serde_json::json!({ "emails": emails })
        }
        Err(e) => {
            warn!(target: "ai", error = ?e, "native list_recent_emails failed");
            serde_json::json!({ "isError": true, "error": "Could not load recent emails" })
        }
    }
}

async fn list_meetings(pool: &PgPool, user_id: i32) -> Value {
    let rows = sqlx::query(
        "SELECT title, title_encrypted, title_iv, date, start_time, end_time
         FROM meetings
         WHERE user_id = $1 AND date >= CURRENT_DATE
         ORDER BY date ASC, start_time ASC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(READ_LIMIT as i64)
    .fetch_all(pool)
    .await;

    match rows {
        Ok(rows) => {
            let meetings: Vec<Value> = rows
                .iter()
                .map(|row| {
                    let title = decrypt_field(row, "title_encrypted", "title_iv")
                        .or_else(|| row.try_get::<Option<String>, _>("title").ok().flatten())
                        .unwrap_or_default();
                    let date: Option<chrono::NaiveDate> = row.try_get("date").ok();
                    let start: Option<chrono::NaiveTime> = row.try_get("start_time").ok();
                    let end: Option<chrono::NaiveTime> = row.try_get("end_time").ok();
                    serde_json::json!({
                        "title": title,
                        "date": date.map(|d| d.to_string()),
                        "start_time": start.map(|t| t.to_string()),
                        "end_time": end.map(|t| t.to_string()),
                    })
                })
                .collect();
            serde_json::json!({ "meetings": meetings })
        }
        Err(e) => {
            warn!(target: "ai", error = ?e, "native list_meetings failed");
            serde_json::json!({ "isError": true, "error": "Could not load meetings" })
        }
    }
}

/// Trim a string argument, defaulting to empty when absent or non-string.
fn str_arg(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Decrypt a `(*_encrypted, *_iv)` column pair (AES-256-GCM at rest); `None` when
/// either half is missing/empty or decryption fails.
fn decrypt_field(row: &sqlx::postgres::PgRow, enc_col: &str, iv_col: &str) -> Option<String> {
    let enc: Option<String> = row.try_get(enc_col).ok().flatten();
    let iv: Option<String> = row.try_get(iv_col).ok().flatten();
    match (enc, iv) {
        (Some(e), Some(i)) if !e.is_empty() && !i.is_empty() => decrypt(&i, &e).ok(),
        _ => None,
    }
}
