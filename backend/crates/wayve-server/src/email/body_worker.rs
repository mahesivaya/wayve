use crate::prelude::*;

use crate::email::attachments::save_email_attachments;
use crate::email::oauth::{HTTP_CLIENT, load_google_secrets, refresh_access_token};
use crate::email::utils::{AttachmentMeta, extract_attachments, extract_body};
use wayve_security::encryption::{encrypt, encrypt_to_pubkey};

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
    // An account has work pending if any of its rows has `body_encrypted = ''`
    // (headers synced, body never fetched — the contract backed by
    // idx_emails_pending_body) or `attachments_checked = false` (the attachment
    // save errored or never ran).
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

    // Same predicate as `run_iteration`. Re-fetching a row that already has a
    // body costs one Gmail call and is the only way to back-fill attachments for
    // rows that were wrongly marked checked.
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

    // Cap in-flight requests at BODY_CONCURRENCY to stay inside Gmail's rate
    // limit; each completion below refills one slot.
    for row in iter.by_ref().take(BODY_CONCURRENCY) {
        let id: i32 = row.get("id");
        let gmail_id: String = row.get("gmail_id");
        spawn_fetch(&mut tasks, token.clone(), account_id, id, gmail_id);
    }

    while let Some(res) = tasks.next().await {
        match res {
            Ok(fetched) => {
                if let Err(e) =
                    update_body(pool, fetched.account_id, fetched.id, &fetched.body).await
                {
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
                    // Mark checked only after the save returns. If it swallowed
                    // an error the flag stays false and the next tick retries.
                    if let Err(e) = mark_attachments_checked(pool, fetched.id).await {
                        println!(
                            "body_worker mark_attachments_checked {} failed: {:?}",
                            fetched.id, e
                        );
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
async fn update_body(pool: &PgPool, account_id: i32, id: i32, body: &str) -> Result<()> {
    // Encrypt on arrival, preferring to wrap the body to the owner's RSA public
    // key so the server never persists a copy it can decrypt. Two cases fall
    // back to the server-AES at-rest layer instead: an owner with no public key
    // on file (a pre-keypair or SQL-seeded account), and an enterprise-tier
    // owner, whose org opts into server-readable encryption.
    //
    // Both shapes share the `body_encrypted` column, because
    // frontend/src/emails/bodyUtils.ts sniffs for the WAYVE_SECURE_V1 prefix and
    // otherwise falls through to the API's server-decrypted shape.
    let (public_key_json, owner_is_enterprise): (Option<String>, bool) = sqlx::query_as(
        "SELECT
             u.public_key,
             EXISTS(
                 SELECT 1 FROM subscriptions s
                 JOIN plans p ON p.id = s.plan_id
                 WHERE s.organization_id = u.organization_id
                   AND s.status = 'active' AND p.tier = 'enterprise'
             ) AS is_enterprise
           FROM email_accounts a
           JOIN users u ON u.id = a.user_id
          WHERE a.id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?
    .unwrap_or((None, false));

    let spki = if owner_is_enterprise {
        None
    } else {
        public_key_json
            .as_deref()
            .and_then(parse_spki_from_json_bytes)
    };

    let (iv, encrypted) = match spki {
        Some(spki) => {
            // The envelope carries its own AES nonce, so `body_iv` must stay
            // empty or the frontend's prefix-sniffing decoder would apply a
            // stray IV that doesn't belong to it.
            let envelope = encrypt_to_pubkey(body.as_bytes(), &spki)?;
            (String::new(), envelope)
        }
        None if owner_is_enterprise => encrypt(body)?,
        None => {
            // Warn so an operator can spot accounts persistently missing a
            // public key, which silently downgrades them off E2E.
            tracing::warn!(
                target: "worker",
                email_id = id,
                account_id,
                "encrypt-on-arrival: no public key on file for owner; \
                 falling back to server-AES at rest"
            );
            encrypt(body)?
        }
    };

    // Deliberately does not stamp `attachments_checked`. Flipping it here would
    // strand an email with the flag set and zero attachment rows whenever
    // `save_email_attachments` failed, silently losing the attachments forever.
    // Only `mark_attachments_checked`, after a successful save, may set it.
    sqlx::query("UPDATE emails SET body_encrypted = $1, body_iv = $2 WHERE id = $3")
        .bind(encrypted)
        .bind(iv)
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

/// `users.public_key` holds a JSON byte array, as written by
/// `saveUserPublicKey` in frontend/src/api/Auth.ts; this parses it back into the
/// raw SPKI bytes `encrypt_to_pubkey` wants. `None` on any parse failure, so a
/// corrupt row makes the caller fall back rather than stalling the worker.
fn parse_spki_from_json_bytes(json: &str) -> Option<Vec<u8>> {
    serde_json::from_str::<Vec<u8>>(json).ok()
}

#[instrument(target = "db", skip(pool), fields(email_id = id))]
async fn mark_attachments_checked(pool: &PgPool, id: i32) -> Result<()> {
    sqlx::query("UPDATE emails SET attachments_checked = true WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
