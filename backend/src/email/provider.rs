use crate::email::account::invalidate_email_account_cache;
use crate::email::oauth::{refresh_access_token, try_load_google_secrets};
use crate::email::outlook::{
    OUTLOOK_MAIL_SCOPE, OutlookCredentials, outlook_credentials, refresh_outlook_token,
    sync_outlook_account, sync_outlook_account_before,
};
use crate::email::send::{send_via_gmail, send_via_outlook};
use crate::email::sync::{sync_account, sync_account_before};
use crate::models::email_request::SendEmailRequest;
use crate::prelude::*;
use tracing::instrument;

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

    pub fn is_google(self) -> bool {
        self == Self::Google
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

    /// Sync new messages since `last_sync` for `account_id` via this provider.
    pub async fn sync(
        self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        last_sync: Option<i64>,
    ) -> Result<()> {
        match self {
            Self::Google => sync_account(pool, account_id, access_token, last_sync).await,
            Self::Microsoft => {
                sync_outlook_account(pool, account_id, access_token, last_sync).await
            }
        }
    }

    /// Fetch a page of messages older than `before_timestamp`, used when the UI
    /// scrolls past the synced window.
    #[allow(clippy::too_many_arguments)]
    pub async fn sync_before(
        self,
        pool: &PgPool,
        account_id: i32,
        access_token: &str,
        before_timestamp: i64,
        limit: usize,
    ) -> Result<()> {
        match self {
            Self::Google => {
                sync_account_before(pool, account_id, access_token, before_timestamp, limit).await
            }
            Self::Microsoft => {
                sync_outlook_account_before(pool, account_id, access_token, before_timestamp, limit)
                    .await
            }
        }
    }

    /// Send an email via this provider. Gmail builds its own MIME from
    /// `from_email`; Graph sends from the authenticated account directly, so
    /// each backend takes a different slice of the inputs.
    #[allow(clippy::too_many_arguments)]
    pub async fn send(
        self,
        access_token: &str,
        from_email: &str,
        account_id: i32,
        data: &SendEmailRequest,
        user_id: i32,
    ) -> HttpResponse {
        match self {
            Self::Google => send_via_gmail(access_token, from_email, data, user_id).await,
            Self::Microsoft => send_via_outlook(access_token, account_id, data).await,
        }
    }
}

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

#[derive(Clone, Default)]
pub struct MailProviderClients {
    pub google: Option<GoogleOAuthClient>,
    pub outlook: Option<OutlookCredentials>,
}

impl MailProviderClients {
    pub fn for_providers(providers: impl IntoIterator<Item = MailProvider>) -> Self {
        let mut needs_google = false;
        let mut needs_outlook = false;

        for provider in providers {
            needs_google |= provider.is_google();
            needs_outlook |= provider.is_microsoft();
        }

        Self {
            google: if needs_google {
                google_oauth_client().ok()
            } else {
                None
            },
            outlook: if needs_outlook {
                outlook_credentials()
            } else {
                None
            },
        }
    }

    pub fn for_provider(provider: MailProvider) -> Self {
        Self::for_providers([provider])
    }
}

pub struct RefreshedEmailToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[instrument(target = "auth", skip(refresh_token, clients), fields(provider = provider.as_db()))]
pub async fn refresh_email_token(
    provider: MailProvider,
    refresh_token: &str,
    clients: MailProviderClients,
) -> Result<RefreshedEmailToken> {
    match provider {
        MailProvider::Google => {
            let google = clients
                .google
                .ok_or_else(|| anyhow::anyhow!("Google OAuth is not configured"))?;
            let access_token =
                refresh_access_token(&google.client_id, &google.client_secret, refresh_token)
                    .await?;
            Ok(RefreshedEmailToken {
                access_token,
                refresh_token: None,
            })
        }
        MailProvider::Microsoft => {
            let outlook = clients
                .outlook
                .ok_or_else(|| anyhow::anyhow!("Outlook OAuth is not configured"))?;
            let tokens = refresh_outlook_token(&outlook, refresh_token, OUTLOOK_MAIL_SCOPE).await?;
            Ok(RefreshedEmailToken {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
            })
        }
    }
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
    skip(pool, refresh_token, clients),
    fields(account_id, provider = provider.as_db())
)]
pub async fn refresh_and_persist_email_token(
    pool: &PgPool,
    account_id: i32,
    provider: MailProvider,
    refresh_token: &str,
    clients: MailProviderClients,
) -> Result<RefreshedEmailToken> {
    let token = refresh_email_token(provider, refresh_token, clients).await?;
    persist_refreshed_token(pool, account_id, &token).await?;
    Ok(token)
}
