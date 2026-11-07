//! Mailbox labels for the email sidebar's Labels tree.
//!
//! `emails.labels` stores only Gmail's label ids (`Label_123`), so the names come
//! from Gmail's `labels.list`, cached in `mailbox_labels` per account. Only user
//! labels are kept: system labels (INBOX, categories, …) are the sidebar's
//! fixed folders. Gmail nests labels by "/" in the name; the client builds the
//! tree from that.
//!
//! The refresh rides the sync tick but runs at most every `REFRESH_EVERY` per
//! account. The throttle is process memory, so a restart refreshes once early,
//! which is harmless.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tracing::warn;

const REFRESH_EVERY: Duration = Duration::from_secs(10 * 60);

static LAST_REFRESH: Lazy<Mutex<HashMap<i32, Instant>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Claims this account's refresh slot. False while the last refresh is recent.
fn due(account_id: i32) -> bool {
    let Ok(mut last) = LAST_REFRESH.lock() else {
        return true;
    };
    let now = Instant::now();
    match last.get(&account_id) {
        Some(at) if now.duration_since(*at) < REFRESH_EVERY => false,
        _ => {
            last.insert(account_id, now);
            true
        }
    }
}

/// One Gmail user label, as stored.
#[derive(Debug, PartialEq)]
pub struct GmailLabel {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}

/// The user labels from a `labels.list` response, leaving out system labels
/// and those the user hid from Gmail's label list.
pub fn user_labels(body: &Value) -> Vec<GmailLabel> {
    body.get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter(|l| l.get("type").and_then(Value::as_str) == Some("user"))
                .filter(|l| {
                    l.get("labelListVisibility").and_then(Value::as_str) != Some("labelHide")
                })
                .filter_map(|l| {
                    let id = l.get("id")?.as_str()?.to_string();
                    let name = l.get("name")?.as_str()?.trim().to_string();
                    (!name.is_empty()).then(|| GmailLabel {
                        id,
                        name,
                        color: l
                            .pointer("/color/backgroundColor")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Replace the account's stored labels with `labels`, in one transaction.
pub async fn store(pool: &PgPool, account_id: i32, labels: &[GmailLabel]) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    let ids: Vec<&str> = labels.iter().map(|l| l.id.as_str()).collect();
    sqlx::query("DELETE FROM mailbox_labels WHERE account_id = $1 AND NOT (label_id = ANY($2))")
        .bind(account_id)
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    for label in labels {
        sqlx::query(
            r#"
            INSERT INTO mailbox_labels (account_id, label_id, name, color, synced_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (account_id, label_id)
            DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, synced_at = NOW()
            "#,
        )
        .bind(account_id)
        .bind(&label.id)
        .bind(&label.name)
        .bind(label.color.as_deref())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Refresh a Gmail account's labels, unless done recently. Best-effort: a
/// failure keeps the previous labels and is retried after the throttle.
pub async fn refresh_gmail_labels(pool: &PgPool, account_id: i32, token: &str) {
    if !due(account_id) {
        return;
    }
    let url = format!(
        "{}/gmail/v1/users/me/labels",
        crate::external::gmail_api_base()
    );
    let body: Value = match HTTP_CLIENT.get(&url).bearer_auth(token).send().await {
        Ok(res) if res.status().is_success() => match res.json().await {
            Ok(body) => body,
            Err(e) => {
                warn!(target: "worker", account_id, error = ?e, "labels.list: bad body");
                return;
            }
        },
        Ok(res) => {
            warn!(target: "worker", account_id, status = %res.status(), "labels.list returned non-success");
            return;
        }
        Err(e) => {
            warn!(target: "worker", account_id, error = ?e, "labels.list request failed");
            return;
        }
    };
    if let Err(e) = store(pool, account_id, &user_labels(&body)).await {
        warn!(target: "worker", account_id, error = ?e, "storing mailbox labels failed");
    }
}

/// A label in the sidebar, with its unread count.
#[derive(Serialize, FromRow)]
pub struct SidebarLabel {
    pub account_id: i32,
    pub account_email: String,
    pub label_id: String,
    pub name: String,
    pub color: Option<String>,
    pub unread: i64,
}

/// The labels of every mailbox the caller can read (their own and shared
/// inboxes they belong to), optionally one account's, with unread counts that
/// match what opening the label lists (not spam or trash).
pub async fn sidebar_labels(
    pool: &PgPool,
    user_id: i32,
    account_id: Option<i32>,
) -> sqlx::Result<Vec<SidebarLabel>> {
    // `emails` is RLS-enforced, so the counts run under the caller's role.
    let mut tx = pool.begin().await?;
    sqlx::raw_sql(&format!(
        "SELECT set_config('app.user_id', '{user_id}', true); SET LOCAL ROLE wayve_app;"
    ))
    .execute(&mut *tx)
    .await?;
    let rows = sqlx::query_as::<_, SidebarLabel>(
        r#"
        SELECT ml.account_id, a.email AS account_email, ml.label_id, ml.name, ml.color,
               (SELECT COUNT(*) FROM emails e
                 WHERE e.account_id = ml.account_id
                   AND e.labels @> ARRAY[ml.label_id]::text[]
                   AND e.is_read IS NOT TRUE
                   AND NOT ('TRASH' = ANY(e.labels))
                   AND NOT ('SPAM' = ANY(e.labels))) AS unread
        FROM mailbox_labels ml
        JOIN email_accounts a ON a.id = ml.account_id
        LEFT JOIN shared_inbox_members sm ON sm.account_id = a.id AND sm.user_id = $1
        WHERE (a.user_id = $1 OR sm.user_id IS NOT NULL)
          AND ($2::INT IS NULL OR a.id = $2)
        ORDER BY a.email, lower(ml.name)
        "#,
    )
    .bind(user_id)
    .bind(account_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_visible_user_labels_only() {
        let body = serde_json::json!({ "labels": [
            { "id": "INBOX", "name": "INBOX", "type": "system" },
            { "id": "Label_1", "name": "[Superhuman]/AI/Marketing", "type": "user",
              "color": { "backgroundColor": "#16a766" } },
            { "id": "Label_2", "name": "Hidden", "type": "user",
              "labelListVisibility": "labelHide" },
            { "id": "Label_3", "name": "  ", "type": "user" },
            { "id": "Label_4", "name": "Receipts", "type": "user",
              "labelListVisibility": "labelShowIfUnread" }
        ]});
        assert_eq!(
            user_labels(&body),
            vec![
                GmailLabel {
                    id: "Label_1".into(),
                    name: "[Superhuman]/AI/Marketing".into(),
                    color: Some("#16a766".into()),
                },
                GmailLabel {
                    id: "Label_4".into(),
                    name: "Receipts".into(),
                    color: None,
                },
            ]
        );
        assert!(user_labels(&serde_json::json!({})).is_empty());
    }
}

#[derive(Deserialize)]
pub struct SidebarQuery {
    pub account_id: Option<i32>,
}

/// `GET /api/emails/sidebar`: badge counts for the folder menu and the Labels
/// tree, for every readable mailbox or the one in `account_id`.
#[get("/emails/sidebar")]
#[tracing::instrument(target = "http", skip(req, pool, query))]
pub async fn get_sidebar(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    query: web::Query<SidebarQuery>,
) -> AppResult {
    let user_id =
        wayve_security::jwt::get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let counts =
        crate::email::repo::sidebar_counts(pool.get_ref(), user_id, query.account_id).await?;
    let labels = sidebar_labels(pool.get_ref(), user_id, query.account_id).await?;
    let counts: serde_json::Map<String, Value> = counts
        .into_iter()
        .map(|(folder, n)| (folder, Value::from(n)))
        .collect();
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "counts": counts,
        "labels": labels,
    })))
}
