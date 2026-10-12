use crate::email::account::load_user_email_accounts_for_older_sync;
use crate::email::provider::{MailProvider, refresh_and_persist_email_token};
use crate::email::sync::sync_account_inbox_before;
use futures::future::{BoxFuture, FutureExt};
use futures::stream::{FuturesUnordered, StreamExt};
use sqlx::PgPool;

/// Which older mail to fetch: up to `limit` messages older than
/// `before_timestamp` (Unix seconds).
#[derive(Clone, Copy)]
pub struct OlderPage {
    pub before_timestamp: i64,
    pub limit: usize,
    /// Only inbox mail where the provider can tell (Gmail's INBOX label), for
    /// views that list nothing else. Other providers fetch as usual.
    pub inbox_only: bool,
}

/// Internal logic to sync older pages of emails. This is triggered on-demand
/// by the UI when a user scrolls to the bottom of their inbox.
pub async fn sync_older_page(
    pool: &PgPool,
    user_id: i32,
    account_id: Option<i32>,
    page: OlderPage,
) -> anyhow::Result<()> {
    let accounts = load_user_email_accounts_for_older_sync(pool, user_id, account_id).await?;
    if accounts.is_empty() {
        return Ok(());
    }

    let mut sync_tasks: FuturesUnordered<BoxFuture<'static, anyhow::Result<()>>> =
        FuturesUnordered::new();

    for account in accounts {
        let Some(refresh_token) = account.usable_refresh_token().map(str::to_string) else {
            continue;
        };
        let pool = pool.clone();
        sync_tasks.push(
            async move {
                let token = refresh_and_persist_email_token(
                    &pool,
                    account.id,
                    account.provider,
                    &refresh_token,
                )
                .await?;

                if page.inbox_only && account.provider == MailProvider::Google {
                    return sync_account_inbox_before(
                        &pool,
                        account.id,
                        &token.access_token,
                        page.before_timestamp,
                        page.limit,
                    )
                    .await;
                }
                account
                    .provider
                    .sync_before(
                        &pool,
                        account.id,
                        &token.access_token,
                        page.before_timestamp,
                        page.limit,
                    )
                    .await
            }
            .boxed(),
        );
    }

    while let Some(res) = sync_tasks.next().await {
        res?;
    }

    Ok(())
}
