//! Google People API — fetches real profile photos for a user's contacts so the
//! recipient typeahead can show actual Google pictures instead of initials.
//!
//! Photos come from two lists: `people/me/connections` (saved contacts) and
//! `otherContacts` (auto-collected from Gmail interactions). Each returns a photo
//! URL on `lh3.googleusercontent.com`, which the browser can load directly. The
//! `default: true` silhouette placeholder is skipped so we never cache a generic
//! image over initials.
//!
//! Requires the `contacts.readonly` + `contacts.other.readonly` scopes (see
//! `oauth_flow::gmail_scope`). Tokens minted before those scopes get a 403; that
//! is treated as "no photos", not an error, so mail sync is never disrupted.

use crate::email::oauth::HTTP_CLIENT;
use crate::prelude::*;
use anyhow::Result;
use tracing::{info, warn};

const PEOPLE_BASE: &str = "https://people.googleapis.com/v1";

/// Every `(lowercased email, photo_url)` for contacts that have a real photo.
pub async fn fetch_contact_photos(access_token: &str) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    collect(
        access_token,
        &format!("{PEOPLE_BASE}/otherContacts"),
        &[("readMask", "emailAddresses,photos"), ("pageSize", "1000")],
        "otherContacts",
        &mut out,
    )
    .await?;
    collect(
        access_token,
        &format!("{PEOPLE_BASE}/people/me/connections"),
        &[
            ("personFields", "emailAddresses,photos"),
            ("pageSize", "1000"),
        ],
        "connections",
        &mut out,
    )
    .await?;
    Ok(out)
}

/// Pages through one People list, appending `(email, photo_url)` pairs.
async fn collect(
    access_token: &str,
    base: &str,
    params: &[(&str, &str)],
    list_key: &str,
    out: &mut Vec<(String, String)>,
) -> Result<()> {
    let mut page_token: Option<String> = None;
    loop {
        let mut req = HTTP_CLIENT
            .get(base)
            .bearer_auth(access_token)
            .query(params);
        if let Some(pt) = &page_token {
            req = req.query(&[("pageToken", pt.as_str())]);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("People {list_key} failed ({status}): {body}");
        }
        let body: serde_json::Value = resp.json().await?;
        if let Some(items) = body.get(list_key).and_then(|v| v.as_array()) {
            for person in items {
                let Some(url) = person
                    .get("photos")
                    .and_then(|p| p.as_array())
                    .and_then(|arr| {
                        arr.iter()
                            .find(|ph| ph.get("default").and_then(|d| d.as_bool()) != Some(true))
                    })
                    .and_then(|ph| ph.get("url"))
                    .and_then(|u| u.as_str())
                else {
                    continue;
                };
                if let Some(emails) = person.get("emailAddresses").and_then(|e| e.as_array()) {
                    for em in emails {
                        if let Some(addr) = em.get("value").and_then(|v| v.as_str()) {
                            let addr = addr.trim().to_lowercase();
                            if !addr.is_empty() {
                                out.push((addr, url.to_string()));
                            }
                        }
                    }
                }
            }
        }
        match body.get("nextPageToken").and_then(|t| t.as_str()) {
            Some(t) if !t.is_empty() => page_token = Some(t.to_string()),
            _ => return Ok(()),
        }
    }
}

/// Refresh the photo cache for one Google account, throttled to ~6h. Best-effort:
/// a 403 (token predates the contacts scopes) or any API error is logged and the
/// stamp still advances so it doesn't retry every sync tick. Reconnecting Gmail
/// resets `photos_synced_at` to NULL, so photos populate on the next tick.
pub async fn sync_photos_for_account(
    pool: &PgPool,
    account_id: i32,
    user_id: i32,
    access_token: &str,
) {
    let recent: Option<bool> = sqlx::query_scalar(
        "SELECT photos_synced_at > NOW() - INTERVAL '6 hours' FROM email_accounts WHERE id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    if recent == Some(true) {
        return;
    }

    let stamp = async {
        let _ = sqlx::query("UPDATE email_accounts SET photos_synced_at = NOW() WHERE id = $1")
            .bind(account_id)
            .execute(pool)
            .await;
    };

    match fetch_contact_photos(access_token).await {
        Ok(pairs) => {
            let mut updated: u64 = 0;
            for (email, url) in pairs {
                if let Ok(res) = sqlx::query(
                    "UPDATE email_contacts SET photo_url = $1 WHERE user_id = $2 AND address = $3",
                )
                .bind(&url)
                .bind(user_id)
                .bind(&email)
                .execute(pool)
                .await
                {
                    updated += res.rows_affected();
                }
            }
            stamp.await;
            info!(target: "worker", account_id, updated, "synced Google contact photos");
        }
        Err(e) => {
            stamp.await;
            warn!(
                target: "worker",
                account_id,
                error = ?e,
                "Google contact photo sync failed (reconnect Gmail to grant contacts scope?)"
            );
        }
    }
}
