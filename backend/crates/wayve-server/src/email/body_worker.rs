use crate::prelude::*;

use crate::email::attachments::save_email_attachments;
use crate::email::oauth::{HTTP_CLIENT, load_google_secrets, refresh_access_token};
use crate::email::utils::{AttachmentMeta, extract_attachments, extract_body};
use wayve_security::encryption::encrypt;

use serde_json::Value;
use tokio::time::{Duration, sleep};
use tracing::{Instrument, debug, error, info, instrument};

type FetchTask = std::pin::Pin<Box<dyn std::future::Future<Output = Result<FetchedBody>> + Send>>;

struct FetchedBody {
    id: i32,
    account_id: i32,
    gmail_id: String,
    body: String,
    attachments: Vec<AttachmentMeta>,
}

const BODY_CONCURRENCY: usize = 40;
const BODY_BATCH_SIZE: i64 = 200;
const ACCOUNTS_PER_ITERATION: i64 = 10;
const IDLE_SLEEP_SECS: u64 = 60;
const ERROR_SLEEP_SECS: u64 = 10;

pub async fn run_body_worker(pool: PgPool) -> ! {
    info!(target: "worker", "body_worker started");
    loop {
        let span = tracing::info_span!(target: "worker", "body_worker_cycle");
        let sleep_after = async {
            match run_iteration(&pool).await {
                Ok(0) => Some(Duration::from_secs(IDLE_SLEEP_SECS)),
                Ok(n) => {
                    debug!(target: "worker", count = n, "body_worker iteration done");
                    None
                }
                Err(e) => {
                    error!(target: "worker", error = ?e, "body_worker iteration failed");
                    Some(Duration::from_secs(ERROR_SLEEP_SECS))
                }
            }
        }
        .instrument(span)
        .await;

        if let Some(duration) = sleep_after {
            sleep(duration).await;
        }
    }
}

#[instrument(target = "worker", skip(pool))]
async fn run_iteration(pool: &PgPool) -> Result<usize> {
    // Pick accounts that have ANY work pending:
    //   - body_encrypted = '' / IS NULL → headers synced but body never fetched
    //   - attachments_checked = false  → fetched but the per-attachment save
    //     either errored or was never attempted (legacy rows where the
    //     `update_body` SQL stamped this flag prematurely)
    // The body fetcher already deduplicates work-per-row inside
    // `run_body_worker_for_account` so picking an account once per tick
    // covers both axes.
    let accounts = sqlx::query(
        r#"
        SELECT DISTINCT a.id, a.refresh_token
        FROM email_accounts a
        JOIN emails e ON e.account_id = a.id
        WHERE (e.body_encrypted = ''
            OR e.body_encrypted IS NULL
            OR e.attachments_checked = false)
          AND a.refresh_token IS NOT NULL
          AND a.refresh_token <> ''
        LIMIT $1
        "#,
    )
    .bind(ACCOUNTS_PER_ITERATION)
    .fetch_all(pool)
    .await?;

    if accounts.is_empty() {
        return Ok(0);
    }

    let secrets = load_google_secrets();
    let client_id = secrets["web"]["client_id"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let client_secret = secrets["web"]["client_secret"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let mut handles = vec![];
    for row in accounts {
        let pool = pool.clone();
        let client_id = client_id.clone();
        let client_secret = client_secret.clone();
        let account_id: i32 = row.get("id");
        let refresh_token: String = row.get("refresh_token");

        handles.push(tokio::spawn(async move {
            process_account(
                &pool,
                account_id,
                &client_id,
                &client_secret,
                &refresh_token,
            )
            .await
        }));
    }

    let mut total = 0;
    for h in handles {
        match h.await {
            Ok(Ok(n)) => total += n,
            Ok(Err(e)) => println!("body_worker account error: {:?}", e),
            Err(e) => println!("body_worker join error: {:?}", e),
        }
    }

    Ok(total)
}

#[instrument(
    target = "worker",
    skip(pool, client_id, client_secret, refresh_token),
    fields(account_id)
)]
pub(crate) async fn process_account(
    pool: &PgPool,
    account_id: i32,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<usize> {
    let token = refresh_access_token(client_id, client_secret, refresh_token).await?;

    sqlx::query("UPDATE email_accounts SET access_token = $1 WHERE id = $2")
        .bind(&token)
        .bind(account_id)
        .execute(pool)
        .await?;

    // Same widened predicate as `run_iteration`: any row where the body is
    // missing OR where attachments still need verification. Re-fetching a
    // row that already has a body is cheap (single Gmail metadata call) and
    // is the only way to back-fill attachments for rows the legacy
    // update_body logic mistakenly marked checked.
    let rows = sqlx::query(
        r#"
        SELECT id, gmail_id
        FROM emails
        WHERE account_id = $1
          AND (body_encrypted = ''
            OR body_encrypted IS NULL
            OR attachments_checked = false)
        ORDER BY id DESC
        LIMIT $2
        "#,
    )
    .bind(account_id)
    .bind(BODY_BATCH_SIZE)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(0);
    }

    let mut tasks: FuturesUnordered<_> = FuturesUnordered::new();
    let mut iter = rows.into_iter();
    let mut count = 0;

    fn spawn_fetch(
        tasks: &mut FuturesUnordered<FetchTask>,
        token: String,
        account_id: i32,
        id: i32,
        gmail_id: String,
    ) {
        tasks.push(Box::pin(async move {
            fetch_one(&token, account_id, id, &gmail_id).await
        }));
    }

    // Prime the pump with up to BODY_CONCURRENCY in-flight requests.
    for row in iter.by_ref().take(BODY_CONCURRENCY) {
        let id: i32 = row.get("id");
        let gmail_id: String = row.get("gmail_id");
        spawn_fetch(&mut tasks, token.clone(), account_id, id, gmail_id);
    }

    while let Some(res) = tasks.next().await {
        match res {
            Ok(fetched) => {
                if let Err(e) = update_body(pool, fetched.id, &fetched.body).await {
                    println!("body_worker update {} failed: {:?}", fetched.id, e);
                } else {
                    save_email_attachments(
                        pool,
                        fetched.id,
                        fetched.account_id,
                        &fetched.gmail_id,
                        &fetched.attachments,
                    )
                    .await;
                    // Only now mark the row as fully checked. If the save
                    // call swallowed an error, the flag stays false and the
                    // next worker tick (which now also picks up
                    // attachments_checked=false rows) will retry.
                    if let Err(e) = mark_attachments_checked(pool, fetched.id).await {
                        println!("body_worker mark_attachments_checked {} failed: {:?}", fetched.id, e);
                    }
                    count += 1;
                }
            }
            Err(e) => println!("body_worker fetch failed: {:?}", e),
        }

        if let Some(row) = iter.next() {
            let id: i32 = row.get("id");
            let gmail_id: String = row.get("gmail_id");
            spawn_fetch(&mut tasks, token.clone(), account_id, id, gmail_id);
        }
    }

    Ok(count)
}

#[instrument(target = "worker", skip(token, gmail_id), fields(account_id, email_id = id))]
async fn fetch_one(token: &str, account_id: i32, id: i32, gmail_id: &str) -> Result<FetchedBody> {
    let url = format!(
        "{}/gmail/v1/users/me/messages/{}?format=full",
        crate::external::gmail_api_base(),
        gmail_id
    );

    let res: Value = HTTP_CLIENT
        .get(&url)
        .bearer_auth(token)
        .send()
        .await?
        .json()
        .await?;

    let body = extract_body(&res["payload"])
        .unwrap_or_else(|| res["snippet"].as_str().unwrap_or("").to_string());
    let attachments = extract_attachments(&res["payload"]);

    Ok(FetchedBody {
        id,
        account_id,
        gmail_id: gmail_id.to_string(),
        body,
        attachments,
    })
}

#[instrument(target = "db", skip(pool, body), fields(email_id = id))]
async fn update_body(pool: &PgPool, id: i32, body: &str) -> Result<()> {
    let (iv, encrypted) = encrypt(body)?;

    // Note: `attachments_checked` is NOT stamped here. We used to flip it
    // alongside the body update, but a transient failure inside
    // `save_email_attachments` then permanently stranded the email with the
    // checked-flag set and zero attachment rows — never re-fetched, so the
    // attachments were silently lost. Stamping moved to `mark_attachments_checked`
    // which only fires after the save returns successfully.
    sqlx::query("UPDATE emails SET body_encrypted = $1, body_iv = $2 WHERE id = $3")
        .bind(encrypted)
        .bind(iv)
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

#[instrument(target = "db", skip(pool), fields(email_id = id))]
async fn mark_attachments_checked(pool: &PgPool, id: i32) -> Result<()> {
    sqlx::query("UPDATE emails SET attachments_checked = true WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
