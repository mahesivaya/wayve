use crate::email::account::load_user_email_accounts_for_older_sync;
use crate::email::provider::refresh_and_persist_email_token;
use futures::future::{BoxFuture, FutureExt};
use futures::stream::{FuturesUnordered, StreamExt};
use sqlx::PgPool;

/// Internal logic to sync older pages of emails. This is triggered on-demand
/// by the UI when a user scrolls to the bottom of their inbox.
pub async fn sync_older_page(
    pool: &PgPool,
    user_id: i32,
    account_id: Option<i32>,
    before_timestamp: i64,
    limit: usize,
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

                account
                    .provider
                    .sync_before(
                        &pool,
                        account.id,
                        &token.access_token,
                        before_timestamp,
                        limit,
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
