// Email provider dispatch.
//
// The codebase talks to multiple mail backends (Gmail today, Microsoft Graph
// today, more later). Every operation we perform — sync, send, mark-read,
// refresh token — has roughly the same shape across providers but a
// completely different wire format. This module is where that polymorphism
// lives.
//
// The pattern is a `MailProviderClient` trait with one struct impl per
// provider. The `MailProvider` enum is the discriminator we store in
// `email_accounts.provider`; calling `mail_provider_client(provider)` returns
// the right `Arc<dyn MailProviderClient>` (or `None` if that provider's OAuth
// is not configured).
//
// Adding a new provider — say, Yahoo Mail — touches three places:
//   1. Add the variant + matching `from_db`/`as_db`/`display_name` arms on
//      `MailProvider` below.
//   2. Implement `MailProviderClient` for a new `YahooMailClient` struct.
//   3. Add one arm in `mail_provider_client(..)`.
// No edits needed in `routes/email.rs`, `sync.rs`, or anywhere a handler
// calls `provider.sync(..)` / `provider.send(..)` — those go through the
// enum shims at the bottom of this file, which dispatch through the trait.

use crate::email::account::invalidate_email_account_cache;
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

// ============================================================================
// Discriminator stored in `email_accounts.provider`. Pure-data methods stay
// on the enum; everything that does I/O is on the trait.
// ============================================================================
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MailProvider {
    Google,
    Microsoft,
}

impl MailProvider {
    pub fn from_db(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "microsoft" | "outlook" => Self::Microsoft,
            _ => Self::Google,
        }
    }

    pub fn as_db(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Microsoft => "microsoft",
        }
    }

    pub fn is_microsoft(self) -> bool {
        self == Self::Microsoft
    }

    /// Human-readable label used in user-facing error messages.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Google => "Gmail",
            Self::Microsoft => "Outlook",
        }
    }
}

// ============================================================================
// Trait: every operation that varies by provider.
// ============================================================================
#[async_trait]
pub trait MailProviderClient: Send + Sync {
    // Implementations expose their `MailProvider` so callers can use the
    // client polymorphically and still log/branch on the underlying provider
    // (e.g. when adding metrics, request-id correlation, or per-provider
    // retry policy). Currently nothing reads it.
    #[allow(dead_code)]
    fn provider(&self) -> MailProvider;

    async fn refresh_token(&self, refresh_token: &str) -> Result<RefreshedEmailToken>;

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

    #[allow(clippy::too_many_arguments)]
    async fn send(
        &self,
        access_token: &str,
        from_email: &str,
        account_id: i32,
        data: &SendEmailRequest,
        user_id: i32,
    ) -> HttpResponse;

    async fn mark_read(&self, access_token: &str, provider_message_id: &str) -> Result<()>;
}

// ============================================================================
// Registry: turn a stored provider value into the right client.
// `None` means the provider's OAuth is not configured on this instance.
// ============================================================================
pub fn mail_provider_client(provider: MailProvider) -> Option<Arc<dyn MailProviderClient>> {
    match provider {
        MailProvider::Google => google_oauth_client()
            .ok()
            .map(|oauth| Arc::new(GoogleMailClient { oauth }) as Arc<dyn MailProviderClient>),
        MailProvider::Microsoft => outlook_credentials()
            .map(|creds| Arc::new(OutlookMailClient { creds }) as Arc<dyn MailProviderClient>),
    }
}

fn require_client(provider: MailProvider) -> Result<Arc<dyn MailProviderClient>> {
    mail_provider_client(provider)
        .ok_or_else(|| anyhow::anyhow!("{} OAuth is not configured", provider.display_name()))
}

// ============================================================================
// Google implementation.
// ============================================================================
pub struct GoogleMailClient {
    pub oauth: GoogleOAuthClient,
}

#[async_trait]
impl MailProviderClient for GoogleMailClient {
    fn provider(&self) -> MailProvider {
        MailProvider::Google
    }

    async fn refresh_token(&self, refresh_token: &str) -> Result<RefreshedEmailToken> {
        let access_token =
            refresh_access_token(&self.oauth.client_id, &self.oauth.client_secret, refresh_token)
                .await?;
        Ok(RefreshedEmailToken {
            access_token,
            // Google rotates refresh tokens lazily and the refresh endpoint
            // doesn't return a new one in the normal case, so callers keep
            // the existing DB value.
            refresh_token: None,
        })
    }

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

    async fn mark_read(&self, access_token: &str, provider_message_id: &str) -> Result<()> {
        // Gmail uses labels: removing `UNREAD` flips the read flag.
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

// ============================================================================
// Microsoft (Outlook / Graph) implementation.
// ============================================================================
pub struct OutlookMailClient {
    pub creds: OutlookCredentials,
}

#[async_trait]
impl MailProviderClient for OutlookMailClient {
    fn provider(&self) -> MailProvider {
        MailProvider::Microsoft
    }

    async fn refresh_token(&self, refresh_token: &str) -> Result<RefreshedEmailToken> {
        let tokens = refresh_outlook_token(&self.creds, refresh_token, OUTLOOK_MAIL_SCOPE).await?;
        Ok(RefreshedEmailToken {
            access_token: tokens.access_token,
            // Graph sometimes returns a rotated refresh token; pass it through
            // so `persist_refreshed_token` writes it back to the DB.
            refresh_token: tokens.refresh_token,
        })
    }

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

    async fn mark_read(&self, access_token: &str, provider_message_id: &str) -> Result<()> {
        // Graph: PATCH the message with isRead=true. `path_segments_mut`
        // safely URL-encodes the message id (which contains `/` and `+`).
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

// ============================================================================
// Enum shims — kept so existing call sites (`account.provider.sync(..)`,
// `provider.mark_read(..)`, etc.) keep working. Each shim resolves the
// trait impl through the registry and forwards.
// ============================================================================
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

// ============================================================================
// OAuth client wrappers + helpers.
// `GoogleOAuthClient` and `OutlookCredentials` are the credential rows; the
// `MailProviderClient` impls above hold one of these and use them to mint a
// fresh access token before each call.
// ============================================================================
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
    persist_refreshed_token(pool, account_id, &token).await?;
    Ok(token)
}
