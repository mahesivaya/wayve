//! PR notifications, delivered to the people a pull request is actually about.
//!
//! GitHub already emails its own notifications, but only to whoever's GitHub
//! account is watching the repo — which in this app is one connected mailbox.
//! When a pull request is acted on *through Wayve*, this notifies both sides
//! directly: the requester (the PR's author) and the approver (whoever pressed
//! the button), so neither depends on someone else's inbox to find out.
//!
//! Delivery is an in-app email row — `source = 'wayve'`, `account_id` NULL,
//! addressed by `recipient_user_id`, exactly as `email::send::send_internal`
//! writes one. It carries `WAYVE_GITHUB_PR` alongside `INBOX`, which is what the
//! Reviews folder selects on, so the notification lands in each recipient's
//! Reviews tab rather than their general inbox.
//!
//! Everything here is best effort. A notification that cannot be delivered must
//! never fail the approve or merge that triggered it — the GitHub write has
//! already happened by then, and reporting failure would misrepresent it.

use crate::prelude::*;
use serde_json::Value;
use sqlx::Row;
use tracing::{info, warn};

/// Which pull request an event is about. Bundled so the call sites stay within
/// the workspace's argument-count limit, and so owner/repo/number can never be
/// passed in the wrong order.
#[derive(Clone, Copy)]
pub struct PrRef<'a> {
    pub owner: &'a str,
    pub repo: &'a str,
    pub number: i64,
}

/// A person to notify: their Wayve account, and the address to reach them at.
#[derive(Clone, PartialEq)]
pub struct Recipient {
    pub user_id: i32,
    pub email: String,
}

/// The Wayve user behind a GitHub login, via the per-user OAuth connection.
///
/// `None` when that person has never connected GitHub here — there is no other
/// mapping from a GitHub login to an account, and guessing one from the local
/// part of an address would eventually notify the wrong person.
pub async fn user_for_github_login(pool: &PgPool, login: &str) -> Option<Recipient> {
    if login.is_empty() {
        return None;
    }
    let row = sqlx::query(
        "SELECT u.id, u.email
           FROM github_accounts g JOIN users u ON u.id = g.user_id
          WHERE lower(g.github_login) = lower($1)",
    )
    .bind(login)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;
    Some(Recipient {
        user_id: row.try_get("id").ok()?,
        email: row.try_get("email").ok()?,
    })
}

/// The Wayve user acting, looked up by id (the approver/merger).
pub async fn user_by_id(pool: &PgPool, user_id: i32) -> Option<Recipient> {
    let email = sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()?;
    Some(Recipient { user_id, email })
}

/// Writes one in-app PR notification into a recipient's mail.
///
/// The body is encrypted with the same server-AES layer inbound provider mail
/// uses, so the read path decrypts it without a special case.
async fn deliver(
    pool: &PgPool,
    to: &Recipient,
    subject: &str,
    body: &str,
    dedupe_key: &str,
) -> Result<(), sqlx::Error> {
    let (iv, ciphertext) = match wayve_security::encryption::encrypt(body) {
        Ok(pair) => pair,
        Err(e) => {
            warn!(target: "http", error = ?e, "pr notification encrypt failed");
            return Ok(());
        }
    };
    // Deterministic id so a retried action can't deliver the same notification
    // twice; `gmail_id` is the natural key for provider rows and serves here too.
    let gmail_id = format!("wayve:pr:{dedupe_key}:rcpt:{}", to.user_id);
    // Guarded with NOT EXISTS rather than ON CONFLICT: the unique index is on
    // (account_id, gmail_id), and account_id is NULL on in-app rows — Postgres
    // treats NULLs as distinct there, so the constraint would neither fire nor
    // be a legal conflict target.
    sqlx::query(
        "INSERT INTO emails
             (gmail_id, account_id, subject, sender, receiver, body_encrypted,
              body_iv, is_read, labels, source, recipient_user_id)
         SELECT $1, NULL, $2, $3, $4, $5, $6, FALSE,
                ARRAY['INBOX', 'WAYVE_GITHUB_PR']::text[], 'wayve', $7
          WHERE NOT EXISTS (SELECT 1 FROM emails WHERE gmail_id = $1)",
    )
    .bind(&gmail_id)
    .bind(subject)
    .bind("GitHub <pull-requests@wayve>")
    .bind(&to.email)
    .bind(&ciphertext)
    .bind(&iv)
    .bind(to.user_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Notifies the requester and the approver about a pull-request event.
///
/// `actor` is the Wayve user who performed it; `pr` is GitHub's pull-request
/// JSON, from which the author is read. Recipients are de-duplicated, so
/// approving your own PR sends one notification rather than two.
pub async fn notify_pull_request_event(
    pool: &PgPool,
    pr_ref: PrRef<'_>,
    action: &str,
    actor_user_id: i32,
    pr: &Value,
) {
    let PrRef {
        owner,
        repo,
        number,
    } = pr_ref;
    let title = pr["title"].as_str().unwrap_or("").trim();
    let url = pr["html_url"].as_str().unwrap_or("");
    let author_login = pr["user"]["login"].as_str().unwrap_or("");

    let mut recipients: Vec<Recipient> = Vec::new();
    // The requester: whoever opened the pull request.
    if let Some(author) = user_for_github_login(pool, author_login).await {
        recipients.push(author);
    } else if !author_login.is_empty() {
        // Not an error: plenty of PR authors have no Wayve account, or simply
        // have not connected GitHub. Logged so a missing notification is
        // explainable rather than mysterious.
        info!(
            target: "http",
            login = %author_login,
            "pr author has no connected Wayve account; not notified"
        );
    }
    // The approver: the person who acted, always notified so they have their own
    // record of it.
    if let Some(actor) = user_by_id(pool, actor_user_id).await
        && !recipients.contains(&actor)
    {
        recipients.push(actor);
    }

    if recipients.is_empty() {
        return;
    }

    let subject = format!("[{owner}/{repo}] PR #{number} {action}: {title}");
    let body =
        format!("Pull request #{number} in {owner}/{repo} was {action}.\n\n{title}\n{url}\n");
    let dedupe_key = format!("{owner}/{repo}/{number}/{action}");

    for to in &recipients {
        if let Err(e) = deliver(pool, to, &subject, &body, &dedupe_key).await {
            warn!(
                target: "db",
                user_id = to.user_id,
                error = ?e,
                "pr notification delivery failed"
            );
        }
    }
    info!(
        target: "http",
        owner, repo, number, action,
        notified = recipients.len(),
        "pr notifications delivered"
    );
}
