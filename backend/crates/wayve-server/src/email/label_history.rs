//! Keeps stored Gmail labels in step with Gmail through its change history.
//!
//! Sync re-reads a message's labels only while it is under an hour old, so
//! archiving or labelling older mail in Gmail never reached Fluxze: archived
//! mail stayed in the Inbox, and mail re-marked unread stayed read. Each tick
//! now asks Gmail what changed since the last one (`users.history.list`, label
//! changes only) and applies those changes to the stored rows.
//!
//! The position is `email_accounts.label_history_id`, kept apart from
//! `gmail_history_id`, which the push watch overwrites with a newer value
//! whenever it is renewed and would make this skip changes.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use serde_json::Value;
use tracing::{debug, instrument, warn};

/// One label change to stored rows, in the order Gmail made it.
#[derive(Debug, PartialEq)]
pub(crate) struct LabelChange {
    pub gmail_id: String,
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

/// Applies the label changes made in Gmail since the last call. The first call
/// only records where Gmail's history stands. When the position is too old for
/// Gmail to answer (it keeps about a week), it starts again from the current
/// one: the changes in between are lost, as before this existed.
#[instrument(target = "worker", skip(pool, token), fields(account_id))]
pub async fn sync_label_changes(pool: &PgPool, account_id: i32, token: &str) -> Result<()> {
    let since: Option<i64> =
        sqlx::query_scalar("SELECT label_history_id FROM email_accounts WHERE id = $1")
            .bind(account_id)
            .fetch_one(pool)
            .await?;
    let Some(since) = since else {
        let now = current_history_id(token).await?;
        return save_position(pool, account_id, now).await;
    };

    let base = crate::external::gmail_api_base();
    let mut page_token: Option<String> = None;
    let mut latest = since;
    loop {
        let mut query = vec![
            ("startHistoryId", since.to_string()),
            ("historyTypes", "labelAdded".to_string()),
            ("historyTypes", "labelRemoved".to_string()),
            ("maxResults", "500".to_string()),
        ];
        if let Some(t) = &page_token {
            query.push(("pageToken", t.clone()));
        }
        let resp = HTTP_CLIENT
            .get(format!("{base}/gmail/v1/users/me/history"))
            .query(&query)
            .bearer_auth(token)
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            warn!(target: "worker", account_id, since, "gmail history position expired; starting over");
            let now = current_history_id(token).await?;
            return save_position(pool, account_id, now).await;
        }
        let page: Value = resp.error_for_status()?.json().await?;
        let changes = parse_label_changes(&page);
        debug!(target: "worker", account_id, count = changes.len(), "gmail label changes");
        apply(pool, account_id, &changes).await?;
        if let Some(id) = history_id(&page["historyId"]) {
            latest = latest.max(id);
        }
        page_token = page["nextPageToken"].as_str().map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }
    save_position(pool, account_id, latest).await
}

/// The label changes in one `history.list` page, oldest first.
pub(crate) fn parse_label_changes(page: &Value) -> Vec<LabelChange> {
    let mut changes = Vec::new();
    for record in page["history"].as_array().into_iter().flatten() {
        for (key, is_added) in [("labelsAdded", true), ("labelsRemoved", false)] {
            for change in record[key].as_array().into_iter().flatten() {
                let Some(gmail_id) = change["message"]["id"].as_str() else {
                    continue;
                };
                let labels: Vec<String> = change["labelIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|l| l.as_str().map(str::to_string))
                    .collect();
                let (added, removed) = if is_added {
                    (labels, Vec::new())
                } else {
                    (Vec::new(), labels)
                };
                changes.push(LabelChange {
                    gmail_id: gmail_id.to_string(),
                    added,
                    removed,
                });
            }
        }
    }
    changes
}

/// Applies each change as a delta, so labels Fluxze adds itself (such as
/// WAYVE_GITHUB_PR) survive. Read state follows UNREAD both ways. Messages that
/// aren't stored are skipped.
async fn apply(pool: &PgPool, account_id: i32, changes: &[LabelChange]) -> Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for change in changes {
        sqlx::query(
            "UPDATE emails SET \
               labels = ARRAY(SELECT DISTINCT l FROM unnest(labels || $3::text[]) l \
                              WHERE l <> ALL($4::text[])), \
               is_read = CASE WHEN 'UNREAD' = ANY($3::text[]) THEN FALSE \
                              WHEN 'UNREAD' = ANY($4::text[]) THEN TRUE \
                              ELSE is_read END \
             WHERE account_id = $1 AND gmail_id = $2",
        )
        .bind(account_id)
        .bind(&change.gmail_id)
        .bind(&change.added)
        .bind(&change.removed)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn current_history_id(token: &str) -> Result<i64> {
    let profile: Value = HTTP_CLIENT
        .get(format!(
            "{}/gmail/v1/users/me/profile",
            crate::external::gmail_api_base()
        ))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    history_id(&profile["historyId"])
        .ok_or_else(|| anyhow::anyhow!("gmail profile has no historyId"))
}

async fn save_position(pool: &PgPool, account_id: i32, history_id: i64) -> Result<()> {
    sqlx::query("UPDATE email_accounts SET label_history_id = $1 WHERE id = $2")
        .bind(history_id)
        .bind(account_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Gmail sends history ids as decimal strings.
fn history_id(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| value.as_i64())
}
