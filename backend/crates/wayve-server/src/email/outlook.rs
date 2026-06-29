//! Microsoft Graph engine — credentials, token exchange/refresh, mailbox sync,
//! and send. The Outlook counterpart to Google's `oauth.rs` + `sync.rs`.
//!
//! Graph's message-list endpoint returns the body inline, so unlike the Gmail
//! path there is no separate body-worker step: `sync_outlook_account` inserts
//! fully-populated, encrypted rows in a single pass. Attachment *metadata* is
//! pulled during sync; the bytes are fetched on demand by the download route.

use crate::prelude::*;

use crate::email::attachments::save_email_attachments;
use crate::email::oauth::HTTP_CLIENT;
use crate::email::utils::AttachmentMeta;
use actix_web::HttpResponse;
use actix_web::http::header;
use tracing::{debug, instrument, warn};
use wayve_security::encryption::encrypt;

/// Microsoft Graph scopes requested for every Outlook flow — both sign-in and
/// mailbox connect — so a signed-in account can read and send mail right away.
pub const OUTLOOK_MAIL_SCOPE: &str =
    "openid profile email offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send";

/// Upper bound on messages pulled in a single sync pass. A first sync grabs
/// the most recent mail up to this cap; later syncs are incremental (only
/// messages newer than `last_sync`) and stay well under it.
const OUTLOOK_SYNC_CAP: usize = 200;
const OUTLOOK_PAGE_SIZE: usize = 50;

#[derive(Clone)]
pub struct OutlookCredentials {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
}

/// Reads the three required `OUTLOOK_*` env vars; `None` if any is missing.
/// The client secret must only ever live in the gitignored backend env.
pub fn outlook_credentials() -> Option<OutlookCredentials> {
    let outlook = crate::config::outlook_oauth();
    Some(OutlookCredentials {
        client_id: outlook.client_id?,
        client_secret: outlook.client_secret?,
        redirect_uri: outlook.redirect_uri?,
    })
}

pub struct OutlookTokens {
    pub access_token: String,
    /// Microsoft rotates refresh tokens; `None` if the response omitted one.
    pub refresh_token: Option<String>,
    pub expires_in: i64,
}

#[instrument(target = "auth", skip_all)]
fn token_endpoint() -> String {
    format!(
        "{}/oauth2/v2.0/token",
        crate::external::microsoft_authority()
    )
}

fn parse_token_response(res: Value) -> Result<OutlookTokens> {
    if let Some(err) = res.get("error") {
        return Err(anyhow::anyhow!("Microsoft token error: {err}"));
    }
    let access_token = res["access_token"].as_str().unwrap_or("").to_string();
    if access_token.is_empty() {
        return Err(anyhow::anyhow!(
            "Microsoft token response had no access_token"
        ));
    }
    // `expires_in` can come back as a number or a string depending on the flow.
    let expires_in = res["expires_in"]
        .as_i64()
        .or_else(|| res["expires_in"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(3600);
    Ok(OutlookTokens {
        access_token,
        refresh_token: res["refresh_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        expires_in,
    })
}

/// Exchanges an authorization `code` for tokens.
pub async fn exchange_code(
    creds: &OutlookCredentials,
    code: &str,
    scope: &str,
) -> Result<OutlookTokens> {
    let res: Value = HTTP_CLIENT
        .post(token_endpoint())
        .form(&[
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("code", code),
            ("redirect_uri", creds.redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("scope", scope),
        ])
        .send()
        .await?
        .json()
        .await?;
    parse_token_response(res)
}

/// Refreshes an access token. Microsoft may also rotate the refresh token.
pub async fn refresh_outlook_token(
    creds: &OutlookCredentials,
    refresh_token: &str,
    scope: &str,
) -> Result<OutlookTokens> {
    let res: Value = HTTP_CLIENT
        .post(token_endpoint())
        .form(&[
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
            ("scope", scope),
        ])
        .send()
        .await?
        .json()
        .await?;
    parse_token_response(res)
}

struct OutlookMessage {
    id: String,
    sender: String,
    receiver: String,
    subject: String,
    received: NaiveDateTime,
    body: String,
    has_attachments: bool,
    is_read: bool,
    // Mirrors Gmail's labelIds shape so `emails.labels` is uniform across
    // providers: user categories + a synthetic `IMPORTANT` when the message
    // has `importance == "high"`. Filtered against the sidebar category
    // folders alongside the Gmail labels.
    labels: Vec<String>,
}

fn parse_message(m: &Value) -> Option<OutlookMessage> {
    let id = m["id"].as_str()?.to_string();
    let subject = m["subject"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("(No Subject)")
        .to_string();
    let sender = m["from"]["emailAddress"]["address"]
        .as_str()
        .or_else(|| m["from"]["emailAddress"]["name"].as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Unknown")
        .to_string();
    let receiver = m["toRecipients"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|r| r["emailAddress"]["address"].as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Unknown")
        .to_string();
    let received = m["receivedDateTime"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.naive_utc())
        .unwrap_or_else(|| chrono::Utc::now().naive_utc());
    let body = m["body"]["content"].as_str().unwrap_or("").to_string();

    // Build labels from user categories + a synthetic IMPORTANT for
    // importance=high so the same filter (`'IMPORTANT' = ANY(labels)`)
    // works for both Gmail and Outlook rows.
    let mut labels: Vec<String> = m["categories"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if m["importance"].as_str() == Some("high") {
        labels.push("IMPORTANT".to_string());
    }

    Some(OutlookMessage {
        id,
        sender,
        receiver,
        subject,
        received,
        body,
        has_attachments: m["hasAttachments"].as_bool().unwrap_or(false),
        is_read: m["isRead"].as_bool().unwrap_or(false),
        labels,
    })
}

/// First-page URL for a sync. Incremental syncs filter to messages newer than
/// `last_sync` (minus an hour of slop); paging is carried by `@odata.nextLink`.
fn first_page_url(last_sync: Option<i64>) -> String {
    let base = format!(
        "{}/v1.0/me/messages",
        crate::external::microsoft_graph_base()
    );
    let mut url = reqwest::Url::parse(&base).unwrap_or_else(|e| panic!("valid Graph URL: {e}"));
    {
        let mut q = url.query_pairs_mut();
        // `categories` carries the user's Outlook category strings; `importance`
        // is "high|normal|low". Both feed `OutlookMessage.labels` so the sidebar
        // category folders can filter (Important = `importance == "high"`,
        // Updates/Social = matching `categories`).
        q.append_pair(
            "$select",
            "id,subject,from,toRecipients,receivedDateTime,hasAttachments,body,isRead,categories,importance",
        );
        q.append_pair("$orderby", "receivedDateTime desc");
        q.append_pair("$top", &OUTLOOK_PAGE_SIZE.to_string());
        if let Some(ts) = last_sync {
            let since = chrono::DateTime::from_timestamp(ts - 3600, 0)
                .unwrap_or_else(chrono::Utc::now)
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string();
            q.append_pair("$filter", &format!("receivedDateTime ge {since}"));
        }
    }
    url.to_string()
}

fn first_before_page_url(before_timestamp: i64, limit: usize) -> String {
    let base = format!(
        "{}/v1.0/me/messages",
        crate::external::microsoft_graph_base()
    );
    let mut url = reqwest::Url::parse(&base).unwrap_or_else(|e| panic!("valid Graph URL: {e}"));
    {
        let before = chrono::DateTime::from_timestamp(before_timestamp, 0)
            .unwrap_or_else(chrono::Utc::now)
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let mut q = url.query_pairs_mut();
        // `categories` carries the user's Outlook category strings; `importance`
        // is "high|normal|low". Both feed `OutlookMessage.labels` so the sidebar
        // category folders can filter (Important = `importance == "high"`,
        // Updates/Social = matching `categories`).
        q.append_pair(
            "$select",
            "id,subject,from,toRecipients,receivedDateTime,hasAttachments,body,isRead,categories,importance",
        );
        q.append_pair("$orderby", "receivedDateTime desc");
        q.append_pair("$top", &limit.min(OUTLOOK_PAGE_SIZE).to_string());
        q.append_pair("$filter", &format!("receivedDateTime lt {before}"));
    }
    url.to_string()
}

/// Fetches attachment *metadata* (not the bytes) for one Graph message.
async fn fetch_outlook_attachments(
    access_token: &str,
    message_id: &str,
) -> Result<Vec<AttachmentMeta>> {
    // Build the path via segments so the message id is percent-encoded.
    let mut url = reqwest::Url::parse(&format!(
        "{}/v1.0/me/messages",
        crate::external::microsoft_graph_base()
    ))
    .unwrap_or_else(|e| panic!("valid Graph URL: {e}"));
    url.path_segments_mut()
        .unwrap_or_else(|_| panic!("Graph base must be a base URL"))
        .push(message_id)
        .push("attachments");
    url.query_pairs_mut()
        .append_pair("$select", "id,name,contentType,size");

    let res: Value = HTTP_CLIENT
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await?
        .json()
        .await?;

    if let Some(err) = res.get("error") {
        return Err(anyhow::anyhow!("Graph attachments error: {err}"));
    }

    let metas = res["value"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let attachment_id = a["id"].as_str()?.to_string();
                    let filename = a["name"].as_str().unwrap_or("").trim().to_string();
                    if filename.is_empty() {
                        return None;
                    }
                    Some(AttachmentMeta {
                        attachment_id,
                        filename,
                        mime_type: a["contentType"].as_str().unwrap_or("").to_string(),
                        size: a["size"].as_i64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(metas)
}

async fn upsert_messages(
    pool: &PgPool,
    account_id: i32,
    access_token: &str,
    messages: &[OutlookMessage],
) -> Result<()> {
    let mut attachment_tasks = FuturesUnordered::new();

    for m in messages {
        // Encrypt the body at rest, exactly like the Gmail body-worker path.
        let (iv, encrypted) = encrypt(&m.body)?;
        let email_id = crate::email::repo::upsert_one(
            pool,
            account_id,
            &crate::email::repo::InsertEmail {
                gmail_id: &m.id,
                sender: &m.sender,
                receiver: &m.receiver,
                subject: &m.subject,
                created_at: m.received,
                is_read: m.is_read,
                labels: m.labels.as_slice(),
                body: Some((&iv, &encrypted)),
                attachments_checked: true,
            },
        )
        .await?;

        // Graph keeps attachments on a sub-resource; pull their metadata in
        // parallel so the UI can list them and download the bytes on demand.
        if m.has_attachments {
            let msg_id = m.id.clone();
            attachment_tasks.push(async move {
                let res = fetch_outlook_attachments(access_token, &msg_id).await;
                (email_id, msg_id, res)
            });
        }
    }

    while let Some((email_id, msg_id, result)) = attachment_tasks.next().await {
        match result {
            Ok(metas) => {
                save_email_attachments(pool, email_id, account_id, &msg_id, &metas).await;
            }
            Err(e) => {
                warn!(
                    target: "worker",
                    account_id,
                    message = %msg_id,
                    error = ?e,
                    "outlook attachment fetch failed"
                );
            }
        }
    }

    Ok(())
}

/// Outlook equivalent of `email::sync::refresh_provider_unread_count`. Fetches
/// the inbox folder's `unreadItemCount` (the authoritative provider total)
/// and stamps it on `email_accounts.provider_unread_count`. Best-effort:
/// a failed Graph call logs and returns Ok so the rest of the sync runs.
pub async fn refresh_outlook_unread_count(
    pool: &PgPool,
    account_id: i32,
    access_token: &str,
) -> Result<()> {
    let url = format!(
        "{}/v1.0/me/mailFolders/inbox?$select=unreadItemCount",
        crate::external::microsoft_graph_base()
    );
    let resp = HTTP_CLIENT
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await?;
    if !resp.status().is_success() {
        warn!(
            target: "worker",
            account_id,
            status = %resp.status(),
            "Graph mailFolders/inbox returned non-success — skipping unread-count update"
        );
        return Ok(());
    }
    let body: Value = resp.json().await?;
    let unread = body
        .get("unreadItemCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let unread_i32 = i32::try_from(unread.clamp(0, i32::MAX as i64)).unwrap_or(0);
    sqlx::query("UPDATE email_accounts SET provider_unread_count = $1 WHERE id = $2")
        .bind(unread_i32)
        .bind(account_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Pulls recent messages for one connected Outlook mailbox and upserts them
/// (body included, encrypted) into `emails`, then advances `last_sync`.
#[instrument(target = "worker", skip(pool, access_token), fields(account_id))]
pub async fn sync_outlook_account(
    pool: &PgPool,
    account_id: i32,
    access_token: &str,
    last_sync: Option<i64>,
) -> Result<()> {
    let mut next = Some(first_page_url(last_sync));
    let mut total = 0usize;

    while let Some(url) = next.take() {
        let resp = HTTP_CLIENT
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await?;

        // Surface HTTP failures explicitly: a 401/403 from Graph comes back
        // with an empty body, which would otherwise fail JSON parsing with a
        // useless "EOF while parsing" error instead of the real cause.
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let detail = if body.trim().is_empty() {
                "(empty body — the mailbox scope Mail.Read is likely not granted; reconnect Outlook)"
            } else {
                body.trim()
            };
            return Err(anyhow::anyhow!(
                "Graph /me/messages returned {status}: {detail}"
            ));
        }

        let res: Value = resp.json().await?;

        if let Some(err) = res.get("error") {
            return Err(anyhow::anyhow!("Graph messages error: {err}"));
        }

        let messages: Vec<OutlookMessage> = res["value"]
            .as_array()
            .map(|arr| arr.iter().filter_map(parse_message).collect())
            .unwrap_or_default();

        if messages.is_empty() {
            break;
        }

        total += messages.len();
        upsert_messages(pool, account_id, access_token, &messages).await?;

        if total >= OUTLOOK_SYNC_CAP {
            break;
        }
        next = res["@odata.nextLink"].as_str().map(str::to_string);
    }

    sqlx::query("UPDATE email_accounts SET last_sync = $1 WHERE id = $2")
        .bind(chrono::Utc::now().timestamp())
        .bind(account_id)
        .execute(pool)
        .await?;

    if let Err(err) = refresh_outlook_unread_count(pool, account_id, access_token).await {
        warn!(target: "worker", account_id, error = ?err, "refresh_outlook_unread_count failed");
    }

    // Pull recent Junk Email + Drafts so the sidebar Spam/Drafts folders
    // show real data. Each is stamped with a synthetic label ("SPAM" or
    // "DRAFT") so the same `'<LABEL>' = ANY(e.labels)` filter that powers
    // the Gmail case works unchanged for Outlook rows.
    if let Err(err) = sync_outlook_folder_recent(
        pool,
        account_id,
        access_token,
        ("junkemail", "SPAM", OUTLOOK_SPAM_RECENT_CAP),
    )
    .await
    {
        warn!(target: "worker", account_id, error = ?err, "outlook spam sync failed");
    }
    if let Err(err) = sync_outlook_folder_recent(
        pool,
        account_id,
        access_token,
        ("drafts", "DRAFT", OUTLOOK_DRAFT_RECENT_CAP),
    )
    .await
    {
        warn!(target: "worker", account_id, error = ?err, "outlook draft sync failed");
    }

    debug!(target: "worker", account_id, synced = total, "outlook sync done");
    Ok(())
}

// Cap the spam/drafts side-pulls. Spam fills fast and is low-value; drafts
// are usually a handful. Both are pulled on every sync tick, no pagination.
const OUTLOOK_SPAM_RECENT_CAP: usize = 50;
const OUTLOOK_DRAFT_RECENT_CAP: usize = 25;

/// Side-pull from `/me/mailFolders/{folder_id}/messages` for non-inbox
/// folders (Junk Email, Drafts). The `(folder_id, synthetic_label, cap)`
/// tuple keeps the function under the project-wide 5-arg cap while
/// expressing what's actually one logical "folder spec" knob — the caller
/// always varies all three together. Stamps each row with `synthetic_label`
/// so the unified `emails.labels` array works for both providers.
async fn sync_outlook_folder_recent(
    pool: &PgPool,
    account_id: i32,
    access_token: &str,
    spec: (&str, &str, usize),
) -> Result<()> {
    let (folder_id, synthetic_label, cap) = spec;
    let url = format!(
        "{}/v1.0/me/mailFolders/{}/messages?$select=id,subject,from,toRecipients,receivedDateTime,hasAttachments,body,isRead,categories,importance&$orderby=receivedDateTime desc&$top={}",
        crate::external::microsoft_graph_base(),
        folder_id,
        cap
    );

    let resp = HTTP_CLIENT
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        // 404 happens when the folder doesn't exist on the user's mailbox
        // — fine for newer Microsoft accounts that lack a legacy Drafts
        // folder. Treat as no-op; do not propagate.
        let body = resp.text().await.unwrap_or_default();
        warn!(
            target: "worker",
            account_id,
            folder = folder_id,
            status = %status,
            body = body.trim(),
            "Graph mailFolders/<folder>/messages non-success — skipping"
        );
        return Ok(());
    }

    let res: Value = resp.json().await?;
    if let Some(err) = res.get("error") {
        return Err(anyhow::anyhow!(
            "Graph mailFolders/{folder_id}/messages error: {err}"
        ));
    }

    let mut messages: Vec<OutlookMessage> = res["value"]
        .as_array()
        .map(|arr| arr.iter().filter_map(parse_message).collect())
        .unwrap_or_default();

    if messages.is_empty() {
        return Ok(());
    }

    // Stamp the synthetic label so the rows are pickable by the same
    // `'SPAM' = ANY(e.labels)` / `'DRAFT' = ANY(e.labels)` filter used
    // for Gmail. Append to whatever categories/importance produced.
    for m in messages.iter_mut() {
        if !m.labels.iter().any(|l| l == synthetic_label) {
            m.labels.push(synthetic_label.to_string());
        }
    }

    upsert_messages(pool, account_id, access_token, &messages).await?;
    Ok(())
}

/// Pulls one older page for an Outlook mailbox. This mirrors Gmail's
/// `sync_account_before` path and is triggered when the UI asks for another
/// page before the oldest currently loaded message.
#[instrument(target = "worker", skip(pool, access_token), fields(account_id))]
pub async fn sync_outlook_account_before(
    pool: &PgPool,
    account_id: i32,
    access_token: &str,
    before_timestamp: i64,
    limit: usize,
) -> Result<()> {
    let mut next = Some(first_before_page_url(before_timestamp, limit));
    let mut total = 0usize;

    while let Some(url) = next.take() {
        let resp = HTTP_CLIENT
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!(
                "Graph older /me/messages returned {status}: {}",
                body.trim()
            ));
        }

        let res: Value = resp.json().await?;
        if let Some(err) = res.get("error") {
            return Err(anyhow::anyhow!("Graph older messages error: {err}"));
        }

        let messages: Vec<OutlookMessage> = res["value"]
            .as_array()
            .map(|arr| arr.iter().filter_map(parse_message).collect())
            .unwrap_or_default();

        if messages.is_empty() {
            break;
        }

        total += messages.len();
        upsert_messages(pool, account_id, access_token, &messages).await?;

        if total >= limit {
            break;
        }
        next = res["@odata.nextLink"].as_str().map(str::to_string);
    }

    debug!(target: "worker", account_id, synced = total, before_timestamp, "older outlook sync done");
    Ok(())
}

/// Sends a plain-text message from the connected Outlook mailbox via the Graph
/// `sendMail` action. `to` may be a comma-separated list of addresses.
pub async fn send_outlook_mail(
    access_token: &str,
    to: &str,
    subject: &str,
    body: &str,
    attachments: &[crate::email::sender::OutgoingAttachment],
) -> Result<()> {
    use base64::Engine;

    let recipients: Vec<Value> = to
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|addr| serde_json::json!({ "emailAddress": { "address": addr } }))
        .collect();
    if recipients.is_empty() {
        return Err(anyhow::anyhow!("no valid recipients"));
    }

    let mut message = serde_json::json!({
        "subject": subject,
        "body": { "contentType": "Text", "content": body },
        "toRecipients": recipients,
    });
    if !attachments.is_empty() {
        let graph_attachments: Vec<Value> = attachments
            .iter()
            .map(|a| {
                serde_json::json!({
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": a.filename,
                    "contentType": a.mime_type,
                    "contentBytes": base64::engine::general_purpose::STANDARD.encode(&a.bytes),
                })
            })
            .collect();
        message["attachments"] = Value::Array(graph_attachments);
    }

    let payload = serde_json::json!({
        "message": message,
        "saveToSentItems": true,
    });

    let url = format!(
        "{}/v1.0/me/sendMail",
        crate::external::microsoft_graph_base()
    );
    let resp = HTTP_CLIENT
        .post(&url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await?;

    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        let text = resp.text().await.unwrap_or_default();
        Err(anyhow::anyhow!("Graph sendMail failed ({status}): {text}"))
    }
}

/// Fetches one attachment's bytes from Graph. Returns `(content_type, bytes)`.
pub async fn fetch_outlook_attachment_bytes(
    access_token: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<(Option<String>, Vec<u8>)> {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let mut url = reqwest::Url::parse(&format!(
        "{}/v1.0/me/messages",
        crate::external::microsoft_graph_base()
    ))
    .unwrap_or_else(|e| panic!("valid Graph URL: {e}"));
    url.path_segments_mut()
        .unwrap_or_else(|_| panic!("Graph base must be a base URL"))
        .push(message_id)
        .push("attachments")
        .push(attachment_id);

    let res: Value = HTTP_CLIENT
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await?
        .json()
        .await?;

    if let Some(err) = res.get("error") {
        return Err(anyhow::anyhow!("Graph attachment error: {err}"));
    }

    let content = res["contentBytes"].as_str().unwrap_or("");
    if content.is_empty() {
        return Err(anyhow::anyhow!(
            "attachment has no downloadable content (not a file attachment)"
        ));
    }
    let bytes = STANDARD
        .decode(content)
        .map_err(|e| anyhow::anyhow!("attachment base64 decode failed: {e}"))?;
    let content_type = res["contentType"].as_str().map(str::to_string);
    Ok((content_type, bytes))
}

/// A stored Outlook attachment to download — bundles the values clippy's
/// argument-count cap would otherwise reject as a long parameter list.
pub struct OutlookAttachmentRef<'a> {
    pub message_id: &'a str,
    pub attachment_id: &'a str,
    pub filename: &'a str,
    pub mime_type: Option<String>,
}

/// Downloads an Outlook attachment's bytes via Microsoft Graph. The caller
/// refreshes and persists the mailbox token before calling this helper.
pub async fn download_outlook_attachment(
    access_token: &str,
    att: OutlookAttachmentRef<'_>,
) -> HttpResponse {
    let (content_type, bytes) =
        match fetch_outlook_attachment_bytes(access_token, att.message_id, att.attachment_id).await
        {
            Ok(result) => result,
            Err(e) => {
                warn!(target: "worker", error = ?e, "outlook attachment download failed");
                return HttpResponse::BadGateway().finish();
            }
        };

    HttpResponse::Ok()
        .insert_header((
            header::CONTENT_TYPE,
            att.mime_type
                .or(content_type)
                .unwrap_or_else(|| "application/octet-stream".to_string()),
        ))
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", att.filename.replace('"', "")),
        ))
        .body(bytes)
}
