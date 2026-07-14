//! Email provider dispatch. Sync, send, mark-read, and token refresh share a
//! shape across mail backends but not a wire format, so each is its own narrow
//! trait under the `MailProviderClient` umbrella that the registry returns.
//!
//! Adding a provider means a `MailProvider` variant with its
//! `from_db`/`as_db`/`display_name` arms, a `<Provider>MailClient` implementing
//! all five traits, and one arm in `mail_provider_client`. Handlers call through
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
use tracing::instrument;

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
}

/// Umbrella trait the registry returns.
pub trait MailProviderClient: TokenRefresher + MailSync + MailSender + MailRead {
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
