//! Email provider dispatch. Sync, send, mark-read, and token refresh share a
//! shape across mail backends but not a wire format, so each is its own narrow
//! trait under the `MailProviderClient` umbrella that the registry returns.
//!
//! Adding a provider means a `MailProvider` variant with its
//! `from_db`/`as_db`/`display_name` arms, a `<Provider>MailClient` implementing
//! all seven traits, and one arm in `mail_provider_client`. Handlers call through
//! the enum shims at the bottom of this file and need no edits.

use crate::email::account::invalidate_email_account_cache;
use crate::email::imap::{
    MailSecurity, decode_secret as decode_imap_secret, send_via_imap, sync_imap_account,
};
use crate::email::oauth::{HTTP_CLIENT, refresh_access_token, try_load_google_secrets};
use crate::email::outlook::{
    OUTLOOK_MAIL_SCOPE, OutlookCredentials, outlook_credentials, refresh_outlook_token,
    sync_outlook_account, sync_outlook_account_before,
};
use crate::email::send::{send_via_gmail, send_via_outlook};
use crate::email::sync::{sync_account, sync_account_before};
use crate::models::email_request::SendEmailRequest;
use crate::prelude::*;
use async_trait::async_trait;
use std::sync::Arc;
use tracing::{instrument, warn};

/// Discriminator stored in `email_accounts.provider`. Pure-data methods stay on
/// the enum; everything that does I/O is on the traits.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MailProvider {
    Google,
    Microsoft,
    /// IMAP (read) plus SMTP (send) for custom-domain mailboxes. There is no
    /// OAuth refresh token: the encrypted app password lives in
    /// `email_accounts.refresh_token` and the connection settings in the
    /// `imap_*` / `smtp_*` / `mail_security` columns, loaded by account_id.
    Imap,
}

impl MailProvider {
    pub fn from_db(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "microsoft" | "outlook" => Self::Microsoft,
            "imap" => Self::Imap,
            _ => Self::Google,
        }
    }

    pub fn as_db(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Microsoft => "microsoft",
            Self::Imap => "imap",
        }
    }

    pub fn is_microsoft(self) -> bool {
        self == Self::Microsoft
    }

    /// Label used in user-facing error messages.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Google => "Gmail",
            Self::Microsoft => "Outlook",
            Self::Imap => "IMAP",
        }
    }
}

#[async_trait]
pub trait TokenRefresher: Send + Sync {
    async fn refresh_token(&self, refresh_token: &str) -> Result<RefreshedEmailToken>;
}

#[async_trait]
pub trait MailSync: Send + Sync {
    async fn sync(
        &self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        last_sync: Option<i64>,
    ) -> Result<()>;

    #[allow(clippy::too_many_arguments)]
    async fn sync_before(
        &self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        before_timestamp: i64,
        limit: usize,
    ) -> Result<()>;
}

#[async_trait]
pub trait MailSender: Send + Sync {
    #[allow(clippy::too_many_arguments)]
    async fn send(
        &self,
        access_token: &str,
        from_email: &str,
        account_id: i32,
        data: &SendEmailRequest,
        user_id: i32,
    ) -> HttpResponse;
}

#[async_trait]
pub trait MailRead: Send + Sync {
    async fn mark_read(&self, access_token: &str, provider_message_id: &str) -> Result<()>;
    async fn mark_unread(&self, access_token: &str, provider_message_id: &str) -> Result<()>;
}

/// What a provider reports after moving a message into or out of its trash.
#[derive(Debug, Default, PartialEq)]
pub struct TrashMoved {
    /// The message's id after the move, when moving changed it: Graph gives a
    /// moved message a new id, Gmail keeps it.
    pub new_id: Option<String>,
    /// The message is back in the provider's inbox (a restore).
    pub in_inbox: bool,
}

/// Delete in Fluxze moves mail to the provider's trash, so it can be restored.
#[async_trait]
pub trait MailTrash: Send + Sync {
    async fn trash(&self, access_token: &str, provider_message_id: &str) -> Result<TrashMoved>;
    async fn restore(&self, access_token: &str, provider_message_id: &str) -> Result<TrashMoved>;

    /// Moves many of one mailbox's messages into (`trash`) or out of its
    /// trash, with one result per id, in order. Providers with a batch API
    /// override this; by default they go one by one.
    async fn move_many(
        &self,
        access_token: &str,
        provider_message_ids: &[String],
        trash: bool,
    ) -> Vec<Result<TrashMoved>> {
        let mut results = Vec::with_capacity(provider_message_ids.len());
        for id in provider_message_ids {
            results.push(if trash {
                self.trash(access_token, id).await
            } else {
                self.restore(access_token, id).await
            });
        }
        results
    }
}

/// The star, as Gmail has it: the STARRED label (Outlook: the message flag).
#[async_trait]
pub trait MailStar: Send + Sync {
    async fn set_starred(
        &self,
        access_token: &str,
        provider_message_id: &str,
        starred: bool,
    ) -> Result<()>;
}

/// Umbrella trait the registry returns.
pub trait MailProviderClient:
    TokenRefresher + MailSync + MailSender + MailRead + MailTrash + MailStar
{
    /// Exposed so callers can branch or log on the underlying provider, for
    /// metrics or a per-provider retry policy. Nothing reads it yet.
    #[allow(dead_code)]
    fn provider(&self) -> MailProvider;
}

/// Resolves a stored provider value to its client. `None` means that provider's
/// OAuth is not configured on this instance.
pub fn mail_provider_client(provider: MailProvider) -> Option<Arc<dyn MailProviderClient>> {
    match provider {
        MailProvider::Google => google_oauth_client()
            .ok()
            .map(|oauth| Arc::new(GoogleMailClient { oauth }) as Arc<dyn MailProviderClient>),
        MailProvider::Microsoft => outlook_credentials()
            .map(|creds| Arc::new(OutlookMailClient { creds }) as Arc<dyn MailProviderClient>),
        // IMAP has no central credential; the per-account app password and
        // connection settings are loaded from the DB row on demand.
        MailProvider::Imap => Some(Arc::new(ImapMailClient {}) as Arc<dyn MailProviderClient>),
    }
}

fn require_client(provider: MailProvider) -> Result<Arc<dyn MailProviderClient>> {
    mail_provider_client(provider)
        .ok_or_else(|| anyhow::anyhow!("{} OAuth is not configured", provider.display_name()))
}

pub struct GoogleMailClient {
    pub oauth: GoogleOAuthClient,
}

#[async_trait]
impl TokenRefresher for GoogleMailClient {
    async fn refresh_token(&self, refresh_token: &str) -> Result<RefreshedEmailToken> {
        let access_token = refresh_access_token(
            &self.oauth.client_id,
            &self.oauth.client_secret,
            refresh_token,
        )
        .await?;
        Ok(RefreshedEmailToken {
            access_token,
            // Google's refresh endpoint doesn't normally return a rotated
            // refresh token, so callers keep the existing DB value.
            refresh_token: None,
        })
    }
}

#[async_trait]
impl MailSync for GoogleMailClient {
    async fn sync(
        &self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        last_sync: Option<i64>,
    ) -> Result<()> {
        sync_account(pool, account_id, access_token, last_sync).await
    }

    async fn sync_before(
        &self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        before_timestamp: i64,
        limit: usize,
    ) -> Result<()> {
        sync_account_before(pool, account_id, access_token, before_timestamp, limit).await
    }
}

#[async_trait]
impl MailSender for GoogleMailClient {
    async fn send(
        &self,
        access_token: &str,
        from_email: &str,
        _account_id: i32,
        data: &SendEmailRequest,
        user_id: i32,
    ) -> HttpResponse {
        send_via_gmail(access_token, from_email, data, user_id).await
    }
}

#[async_trait]
impl MailRead for GoogleMailClient {
    async fn mark_read(&self, access_token: &str, provider_message_id: &str) -> Result<()> {
        // Gmail has no read flag: removing the UNREAD label is the read marker.
        let url = format!(
            "{}/gmail/v1/users/me/messages/{}/modify",
            crate::external::gmail_api_base(),
            provider_message_id
        );
        let resp = HTTP_CLIENT
            .post(url)
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "removeLabelIds": ["UNREAD"] }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Gmail mark-read failed: {} {}", status, body);
        }
        Ok(())
    }

    async fn mark_unread(&self, access_token: &str, provider_message_id: &str) -> Result<()> {
        // Symmetric to mark_read: re-adding the UNREAD label is the unread marker.
        let url = format!(
            "{}/gmail/v1/users/me/messages/{}/modify",
            crate::external::gmail_api_base(),
            provider_message_id
        );
        let resp = HTTP_CLIENT
            .post(url)
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "addLabelIds": ["UNREAD"] }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Gmail mark-unread failed: {} {}", status, body);
        }
        Ok(())
    }
}

/// A bodyless Gmail message POST: `trash`, `untrash`, or `modify` with `body`.
/// Trash and untrash work under `gmail.modify`; a permanent `messages.delete`
/// would need the full `https://mail.google.com/` scope, which we do not request.
async fn gmail_message_post(
    access_token: &str,
    provider_message_id: &str,
    action: &str,
    body: Value,
) -> Result<reqwest::StatusCode> {
    let url = format!(
        "{}/gmail/v1/users/me/messages/{}/{}",
        crate::external::gmail_api_base(),
        provider_message_id,
        action
    );
    // For trash/untrash the empty JSON object is load-bearing: they are
    // bodyless POSTs, reqwest omits Content-Length for an empty body, and
    // Google's frontend 411s without one. Those endpoints ignore the body.
    let resp = HTTP_CLIENT
        .post(url)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    // Already gone from Gmail: there is nothing left to trash.
    if action == "trash" && status.as_u16() == 404 {
        return Ok(status);
    }
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        anyhow::bail!("Gmail {action} failed: {status} {detail}");
    }
    Ok(status)
}

/// Gmail's `messages.batchModify` takes at most this many ids per call.
const GMAIL_BATCH_MODIFY_MAX: usize = 1000;

/// `messages.batchModify`: one label change across many messages, under the
/// same `gmail.modify` scope. TRASH can be applied and removed like INBOX.
async fn gmail_batch_modify(access_token: &str, body: Value) -> Result<()> {
    let url = format!(
        "{}/gmail/v1/users/me/messages/batchModify",
        crate::external::gmail_api_base()
    );
    let resp = HTTP_CLIENT
        .post(url)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        anyhow::bail!("Gmail batchModify failed: {status} {detail}");
    }
    Ok(())
}

#[async_trait]
impl MailTrash for GoogleMailClient {
    /// One `batchModify` per 1,000 messages instead of a call (two, for a
    /// restore) each: trash adds TRASH; restore removes it and adds INBOX, as
    /// the single restore does. One bad id fails the whole call, so a chunk
    /// that fails is retried one by one: the rest still move, and the failure
    /// lands on the message it belongs to.
    async fn move_many(
        &self,
        access_token: &str,
        provider_message_ids: &[String],
        trash: bool,
    ) -> Vec<Result<TrashMoved>> {
        let mut results = Vec::with_capacity(provider_message_ids.len());
        for chunk in provider_message_ids.chunks(GMAIL_BATCH_MODIFY_MAX) {
            let body = if trash {
                serde_json::json!({ "ids": chunk, "addLabelIds": ["TRASH"] })
            } else {
                serde_json::json!({
                    "ids": chunk,
                    "removeLabelIds": ["TRASH"],
                    "addLabelIds": ["INBOX"],
                })
            };
            match gmail_batch_modify(access_token, body).await {
                Ok(()) => results.extend(chunk.iter().map(|_| {
                    Ok(TrashMoved {
                        new_id: None,
                        in_inbox: !trash,
                    })
                })),
                Err(err) => {
                    warn!(target: "gmail", messages = chunk.len(), error = %err, "batchModify failed; moving one by one");
                    for id in chunk {
                        results.push(if trash {
                            self.trash(access_token, id).await
                        } else {
                            self.restore(access_token, id).await
                        });
                    }
                }
            }
        }
        results
    }

    async fn trash(&self, access_token: &str, provider_message_id: &str) -> Result<TrashMoved> {
        gmail_message_post(
            access_token,
            provider_message_id,
            "trash",
            serde_json::json!({}),
        )
        .await?;
        Ok(TrashMoved::default())
    }

    async fn restore(&self, access_token: &str, provider_message_id: &str) -> Result<TrashMoved> {
        gmail_message_post(
            access_token,
            provider_message_id,
            "untrash",
            serde_json::json!({}),
        )
        .await?;
        // `untrash` only takes the TRASH label off: mail trashed out of the
        // inbox comes back without INBOX, so it would land in All Mail rather
        // than the inbox Restore promises. Put it back, as Gmail's own "Move to
        // Inbox" does.
        gmail_message_post(
            access_token,
            provider_message_id,
            "modify",
            serde_json::json!({ "addLabelIds": ["INBOX"] }),
        )
        .await?;
        Ok(TrashMoved {
            new_id: None,
            in_inbox: true,
        })
    }
}

#[async_trait]
impl MailStar for GoogleMailClient {
    async fn set_starred(
        &self,
        access_token: &str,
        provider_message_id: &str,
        starred: bool,
    ) -> Result<()> {
        let change = if starred {
            serde_json::json!({ "addLabelIds": ["STARRED"] })
        } else {
            serde_json::json!({ "removeLabelIds": ["STARRED"] })
        };
        gmail_message_post(access_token, provider_message_id, "modify", change).await?;
        Ok(())
    }
}

impl MailProviderClient for GoogleMailClient {
    fn provider(&self) -> MailProvider {
        MailProvider::Google
    }
}

pub struct OutlookMailClient {
    pub creds: OutlookCredentials,
}

#[async_trait]
impl TokenRefresher for OutlookMailClient {
    async fn refresh_token(&self, refresh_token: &str) -> Result<RefreshedEmailToken> {
        let tokens = refresh_outlook_token(&self.creds, refresh_token, OUTLOOK_MAIL_SCOPE).await?;
        Ok(RefreshedEmailToken {
            access_token: tokens.access_token,
            // Graph sometimes rotates the refresh token; pass it through so
            // persist_refreshed_token writes it back.
            refresh_token: tokens.refresh_token,
        })
    }
}

#[async_trait]
impl MailSync for OutlookMailClient {
    async fn sync(
        &self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        last_sync: Option<i64>,
    ) -> Result<()> {
        sync_outlook_account(pool, account_id, access_token, last_sync).await
    }

    async fn sync_before(
        &self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        before_timestamp: i64,
        limit: usize,
    ) -> Result<()> {
        sync_outlook_account_before(pool, account_id, access_token, before_timestamp, limit).await
    }
}

#[async_trait]
impl MailSender for OutlookMailClient {
    async fn send(
        &self,
        access_token: &str,
        _from_email: &str,
        account_id: i32,
        data: &SendEmailRequest,
        _user_id: i32,
    ) -> HttpResponse {
        send_via_outlook(access_token, account_id, data).await
    }
}

#[async_trait]
impl MailRead for OutlookMailClient {
    async fn mark_read(&self, access_token: &str, provider_message_id: &str) -> Result<()> {
        // `path_segments_mut` URL-encodes the Graph message id, which contains
        // `/` and `+`.
        let mut url = reqwest::Url::parse(&format!(
            "{}/v1.0/me/messages",
            crate::external::microsoft_graph_base()
        ))?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Graph base must be a base URL"))?
            .push(provider_message_id);
        let resp = HTTP_CLIENT
            .patch(url)
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "isRead": true }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Outlook mark-read failed: {} {}", status, body);
        }
        Ok(())
    }

    async fn mark_unread(&self, access_token: &str, provider_message_id: &str) -> Result<()> {
        let mut url = reqwest::Url::parse(&format!(
            "{}/v1.0/me/messages",
            crate::external::microsoft_graph_base()
        ))?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Graph base must be a base URL"))?
            .push(provider_message_id);
        let resp = HTTP_CLIENT
            .patch(url)
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "isRead": false }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Outlook mark-unread failed: {} {}", status, body);
        }
        Ok(())
    }
}

/// Graph `POST /me/messages/{id}/move` to a well-known folder. A moved message
/// gets a new id, which the response carries and the caller must store, or the
/// next sync would see the moved message as new mail.
async fn outlook_move(
    access_token: &str,
    provider_message_id: &str,
    destination: &str,
) -> Result<TrashMoved> {
    let mut url = reqwest::Url::parse(&format!(
        "{}/v1.0/me/messages",
        crate::external::microsoft_graph_base()
    ))?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Graph base must be a base URL"))?
        .push(provider_message_id)
        .push("move");
    let resp = HTTP_CLIENT
        .post(url)
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "destinationId": destination }))
        .send()
        .await?;
    let status = resp.status();
    // Already gone from Outlook: there is nothing left to trash.
    if destination == "deleteditems" && status.as_u16() == 404 {
        return Ok(TrashMoved::default());
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Outlook move to {destination} failed: {status} {body}");
    }
    let message: Value = resp.json().await?;
    let new_id = message["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("Outlook move response has no message id"))?;
    Ok(TrashMoved {
        new_id: Some(new_id),
        in_inbox: destination == "inbox",
    })
}

/// Graph's JSON batching takes at most this many requests per call.
const GRAPH_BATCH_MAX: usize = 20;

/// Up to 20 Graph `move`s in one `POST /$batch`, one result per id in order.
/// Mirrors `outlook_move`: a moved message's new id is returned, and moving
/// one that is already gone to Deleted Items is a success.
async fn outlook_move_batch(
    access_token: &str,
    provider_message_ids: &[String],
    destination: &str,
) -> Result<Vec<Result<TrashMoved>>> {
    let requests = provider_message_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            // Graph ids carry `/` and `+`, so encode the id as a path segment.
            let mut path = reqwest::Url::parse("https://graph.invalid/me/messages")?;
            path.path_segments_mut()
                .map_err(|_| anyhow::anyhow!("not a base URL"))?
                .push(id)
                .push("move");
            Ok(serde_json::json!({
                "id": i.to_string(),
                "method": "POST",
                "url": path.path(),
                "headers": { "Content-Type": "application/json" },
                "body": { "destinationId": destination },
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let resp = HTTP_CLIENT
        .post(format!(
            "{}/v1.0/$batch",
            crate::external::microsoft_graph_base()
        ))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "requests": requests }))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Outlook batch move to {destination} failed: {status} {body}");
    }
    let body: Value = resp.json().await?;
    // Responses come back in any order; match them to requests by id.
    let mut by_id: std::collections::HashMap<String, Value> = body["responses"]
        .as_array()
        .map(|responses| {
            responses
                .iter()
                .filter_map(|r| Some((r["id"].as_str()?.to_string(), r.clone())))
                .collect()
        })
        .unwrap_or_default();
    Ok((0..provider_message_ids.len())
        .map(|i| {
            let Some(response) = by_id.remove(&i.to_string()) else {
                anyhow::bail!("Outlook batch move returned no response for a message");
            };
            let code = response["status"].as_u64().unwrap_or(0);
            if destination == "deleteditems" && code == 404 {
                return Ok(TrashMoved::default());
            }
            if !(200..300).contains(&code) {
                anyhow::bail!(
                    "Outlook move to {destination} failed: {code} {}",
                    response["body"]["error"]["message"].as_str().unwrap_or("")
                );
            }
            let new_id = response["body"]["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("Outlook move response has no message id"))?;
            Ok(TrashMoved {
                new_id: Some(new_id),
                in_inbox: destination == "inbox",
            })
        })
        .collect())
}

#[async_trait]
impl MailTrash for OutlookMailClient {
    /// One Graph `$batch` per 20 moves instead of a request each. A batch that
    /// fails outright is retried one by one, as for Gmail.
    async fn move_many(
        &self,
        access_token: &str,
        provider_message_ids: &[String],
        trash: bool,
    ) -> Vec<Result<TrashMoved>> {
        let destination = if trash { "deleteditems" } else { "inbox" };
        let mut results = Vec::with_capacity(provider_message_ids.len());
        for chunk in provider_message_ids.chunks(GRAPH_BATCH_MAX) {
            match outlook_move_batch(access_token, chunk, destination).await {
                Ok(moved) => results.extend(moved),
                Err(err) => {
                    warn!(target: "gmail", messages = chunk.len(), error = %err, "Graph batch move failed; moving one by one");
                    for id in chunk {
                        results.push(outlook_move(access_token, id, destination).await);
                    }
                }
            }
        }
        results
    }

    async fn trash(&self, access_token: &str, provider_message_id: &str) -> Result<TrashMoved> {
        outlook_move(access_token, provider_message_id, "deleteditems").await
    }

    async fn restore(&self, access_token: &str, provider_message_id: &str) -> Result<TrashMoved> {
        outlook_move(access_token, provider_message_id, "inbox").await
    }
}

#[async_trait]
impl MailStar for OutlookMailClient {
    /// Outlook has no star; its follow-up flag is the equivalent, and is what
    /// sync reads back as STARRED (see outlook::parse_message).
    async fn set_starred(
        &self,
        access_token: &str,
        provider_message_id: &str,
        starred: bool,
    ) -> Result<()> {
        let mut url = reqwest::Url::parse(&format!(
            "{}/v1.0/me/messages",
            crate::external::microsoft_graph_base()
        ))?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Graph base must be a base URL"))?
            .push(provider_message_id);
        let status = if starred { "flagged" } else { "notFlagged" };
        let resp = HTTP_CLIENT
            .patch(url)
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "flag": { "flagStatus": status } }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Outlook flag {status} failed: {code} {body}");
        }
        Ok(())
    }
}

impl MailProviderClient for OutlookMailClient {
    fn provider(&self) -> MailProvider {
        MailProvider::Microsoft
    }
}

/// Generic IMAP/SMTP client.
///
/// IMAP has no OAuth tokens, only an app password, so `TokenRefresher` decrypts
/// the stored password and returns it in the `access_token` slot that the rest
/// of the worker pipeline passes around. `refresh_and_persist_email_token`
/// therefore skips the DB write for IMAP, keeping the plaintext password out of
/// the `access_token` column.
pub struct ImapMailClient {}

struct ImapRow {
    email: String,
    imap_host: String,
    imap_port: i32,
    smtp_host: String,
    smtp_port: i32,
    mail_security: Option<String>,
}

async fn load_imap_row(pool: &PgPool, account_id: i32) -> Result<ImapRow> {
    let row = sqlx::query(
        "SELECT email, imap_host, imap_port, smtp_host, smtp_port, mail_security \
         FROM email_accounts WHERE id = $1",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    Ok(ImapRow {
        email: row.get("email"),
        imap_host: row
            .try_get::<Option<String>, _>("imap_host")?
            .ok_or_else(|| anyhow::anyhow!("imap account {account_id} missing imap_host"))?,
        imap_port: row.try_get::<Option<i32>, _>("imap_port")?.unwrap_or(993),
        smtp_host: row
            .try_get::<Option<String>, _>("smtp_host")?
            .unwrap_or_default(),
        smtp_port: row.try_get::<Option<i32>, _>("smtp_port")?.unwrap_or(465),
        mail_security: row.try_get::<Option<String>, _>("mail_security")?,
    })
}

#[async_trait]
impl TokenRefresher for ImapMailClient {
    async fn refresh_token(&self, refresh_token: &str) -> Result<RefreshedEmailToken> {
        let password = decode_imap_secret(refresh_token)?;
        Ok(RefreshedEmailToken {
            access_token: password,
            refresh_token: None,
        })
    }
}

#[async_trait]
impl MailSync for ImapMailClient {
    async fn sync(
        &self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        _last_sync: Option<i64>,
    ) -> Result<()> {
        // `access_token` is the decrypted app password (see ImapMailClient).
        let r = load_imap_row(pool, account_id).await?;
        sync_imap_account(
            pool,
            account_id,
            &r.imap_host,
            r.imap_port as u16,
            &r.email,
            access_token,
        )
        .await
    }

    async fn sync_before(
        &self,
        _pool: &PgPool,
        _account_id: i32,
        _access_token: &str,
        _before_timestamp: i64,
        _limit: usize,
    ) -> Result<()> {
        // No historical backfill for IMAP yet; the forward sync pulls the most
        // recent batch each tick.
        Ok(())
    }
}

#[async_trait]
impl MailSender for ImapMailClient {
    async fn send(
        &self,
        access_token: &str,
        from_email: &str,
        account_id: i32,
        data: &SendEmailRequest,
        _user_id: i32,
    ) -> HttpResponse {
        let r = match load_imap_row(&crate::email::account::pool_handle(), account_id).await {
            Ok(r) => r,
            Err(e) => {
                return HttpResponse::InternalServerError()
                    .json(serde_json::json!({ "error": format!("imap account load: {e}") }));
            }
        };
        send_via_imap(
            &r.smtp_host,
            r.smtp_port as u16,
            MailSecurity::from_db(r.mail_security.as_deref()),
            from_email,
            access_token,
            data,
        )
        .await
    }
}

#[async_trait]
impl MailRead for ImapMailClient {
    async fn mark_read(&self, _access_token: &str, _provider_message_id: &str) -> Result<()> {
        // No-op: the next sync tick re-reads INBOX \Seen flags and reconciles
        // is_read.
        Ok(())
    }

    async fn mark_unread(&self, _access_token: &str, _provider_message_id: &str) -> Result<()> {
        // No-op, same as mark_read: sync reconciles \Seen on the next tick.
        Ok(())
    }
}

#[async_trait]
impl MailTrash for ImapMailClient {
    // No-ops: IMAP mail is trashed in Fluxze only for now. Moving it to the
    // server's \Trash folder is not built yet; until it is, sync keeps the
    // Fluxze TRASH label (see repo::upsert_one).
    async fn trash(&self, _access_token: &str, _provider_message_id: &str) -> Result<TrashMoved> {
        Ok(TrashMoved::default())
    }

    async fn restore(&self, _access_token: &str, _provider_message_id: &str) -> Result<TrashMoved> {
        Ok(TrashMoved::default())
    }
}

#[async_trait]
impl MailStar for ImapMailClient {
    // No-op: IMAP stars are kept in Fluxze only for now (setting \Flagged on
    // the server is not built); sync keeps the label (see repo::upsert_one).
    async fn set_starred(
        &self,
        _access_token: &str,
        _provider_message_id: &str,
        _starred: bool,
    ) -> Result<()> {
        Ok(())
    }
}

impl MailProviderClient for ImapMailClient {
    fn provider(&self) -> MailProvider {
        MailProvider::Imap
    }
}

// Enum shims: each resolves the trait impl through the registry and forwards,
// so call sites can stay on `account.provider.sync(..)`.
impl MailProvider {
    pub async fn sync(
        self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        last_sync: Option<i64>,
    ) -> Result<()> {
        require_client(self)?
            .sync(pool, account_id, access_token, last_sync)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn sync_before(
        self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        before_timestamp: i64,
        limit: usize,
    ) -> Result<()> {
        require_client(self)?
            .sync_before(pool, account_id, access_token, before_timestamp, limit)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send(
        self,
        access_token: &str,
        from_email: &str,
        account_id: i32,
        data: &SendEmailRequest,
        user_id: i32,
    ) -> HttpResponse {
        match require_client(self) {
            Ok(client) => {
                client
                    .send(access_token, from_email, account_id, data, user_id)
                    .await
            }
            Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
                "error": format!("{e}"),
            })),
        }
    }

    pub async fn mark_read(self, access_token: &str, provider_message_id: &str) -> Result<()> {
        require_client(self)?
            .mark_read(access_token, provider_message_id)
            .await
    }

    pub async fn mark_unread(self, access_token: &str, provider_message_id: &str) -> Result<()> {
        require_client(self)?
            .mark_unread(access_token, provider_message_id)
            .await
    }

    pub async fn trash(self, access_token: &str, provider_message_id: &str) -> Result<TrashMoved> {
        require_client(self)?
            .trash(access_token, provider_message_id)
            .await
    }

    pub async fn set_starred(
        self,
        access_token: &str,
        provider_message_id: &str,
        starred: bool,
    ) -> Result<()> {
        require_client(self)?
            .set_starred(access_token, provider_message_id, starred)
            .await
    }

    pub async fn move_many(
        self,
        access_token: &str,
        provider_message_ids: &[String],
        trash: bool,
    ) -> Result<Vec<Result<TrashMoved>>> {
        Ok(require_client(self)?
            .move_many(access_token, provider_message_ids, trash)
            .await)
    }

    pub async fn restore(
        self,
        access_token: &str,
        provider_message_id: &str,
    ) -> Result<TrashMoved> {
        require_client(self)?
            .restore(access_token, provider_message_id)
            .await
    }
}

// OAuth credentials. Each MailProviderClient above holds one of these and uses
// it to mint a fresh access token before every call.
#[derive(Clone)]
pub struct GoogleOAuthClient {
    pub client_id: String,
    pub client_secret: String,
}

#[instrument(target = "auth")]
pub fn google_oauth_client() -> Result<GoogleOAuthClient> {
    let secrets = try_load_google_secrets()?;
    let client_id = secrets["web"]["client_id"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("client_id missing in google secrets"))?
        .to_string();
    let client_secret = secrets["web"]["client_secret"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("client_secret missing in google secrets"))?
        .to_string();

    Ok(GoogleOAuthClient {
        client_id,
        client_secret,
    })
}

pub struct RefreshedEmailToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[instrument(target = "auth", skip(refresh_token), fields(provider = provider.as_db()))]
pub async fn refresh_email_token(
    provider: MailProvider,
    refresh_token: &str,
) -> Result<RefreshedEmailToken> {
    require_client(provider)?.refresh_token(refresh_token).await
}

#[instrument(target = "db", skip(pool, token), fields(account_id))]
pub async fn persist_refreshed_token(
    pool: &PgPool,
    account_id: i32,
    token: &RefreshedEmailToken,
) -> Result<()> {
    sqlx::query(
        "UPDATE email_accounts
         SET access_token = $1,
             refresh_token = COALESCE(NULLIF($2, ''), refresh_token)
         WHERE id = $3",
    )
    .bind(&token.access_token)
    .bind(token.refresh_token.as_deref().unwrap_or(""))
    .bind(account_id)
    .execute(pool)
    .await?;

    invalidate_email_account_cache(account_id).await;

    Ok(())
}

#[instrument(
    target = "auth",
    skip(pool, refresh_token),
    fields(account_id, provider = provider.as_db())
)]
pub async fn refresh_and_persist_email_token(
    pool: &PgPool,
    account_id: i32,
    provider: MailProvider,
    refresh_token: &str,
) -> Result<RefreshedEmailToken> {
    let token = refresh_email_token(provider, refresh_token).await?;
    // For IMAP the "access token" is the plaintext app password, so persisting
    // it would write a plaintext credential into `access_token`. Skip the write:
    // the password already lives encrypted in `refresh_token`.
    if !matches!(provider, MailProvider::Imap) {
        persist_refreshed_token(pool, account_id, &token).await?;
    }
    Ok(token)
}
