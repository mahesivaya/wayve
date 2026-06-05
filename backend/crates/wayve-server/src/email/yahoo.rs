//! Yahoo Mail integration via IMAP (read) + SMTP (send).
//!
//! Yahoo discontinued third-party OAuth in 2021, so we authenticate with
//! an "App Password" the user generates in Yahoo Account Security. The
//! password is stored encrypted-at-rest in `email_accounts.refresh_token`
//! as `<iv_b64>.<cipher_b64>` — we reuse the existing column (no schema
//! change) because there's no OAuth refresh token for Yahoo to put there.
//!
//! Wire endpoints (well-known):
//!   IMAPS  imap.mail.yahoo.com:993
//!   SMTPS  smtp.mail.yahoo.com:465
//!
//! Send is handled by `lettre`'s `Tokio1Executor` SMTP transport (already
//! a workspace dependency for Gmail/Outlook on-rampers); read uses
//! `async-imap` on top of `tokio-rustls` so we stay on the workspace's
//! pure-Rust TLS stack and don't pull OpenSSL into the runtime image.

use crate::email::repo::{InsertEmail, upsert_one};
use crate::models::email_request::SendEmailRequest;
use crate::prelude::*;
use actix_web::HttpResponse;
use anyhow::{Context, anyhow};
use async_imap::Client;
use chrono::NaiveDateTime;
use futures::TryStreamExt;
use lettre::message::Message;
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use mail_parser::MessageParser;
use once_cell::sync::Lazy;
use rustls::ClientConfig;
use rustls::RootCertStore;
use rustls::pki_types::ServerName;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tracing::{error, info, warn};
use wayve_security::encryption::{decrypt, encrypt};

pub const YAHOO_IMAP_HOST: &str = "imap.mail.yahoo.com";
pub const YAHOO_IMAP_PORT: u16 = 993;
pub const YAHOO_SMTP_HOST: &str = "smtp.mail.yahoo.com";
pub const YAHOO_SMTP_PORT: u16 = 465;

/// How many recent INBOX messages each sync tick pulls. IMAP FETCH RFC822
/// hands us the full raw bytes per message, so kept conservative to avoid
/// a 100 MB+ payload on a first sync against a large mailbox.
const SYNC_BATCH: u32 = 50;
/// Wall-clock cap per IMAP operation. Long enough for slow mailboxes,
/// short enough that a hung TLS handshake doesn't pin a worker.
const IMAP_TIMEOUT: Duration = Duration::from_secs(30);

// ─────────────────────────────────────────────────────────────────────
// Credential storage helpers
// ─────────────────────────────────────────────────────────────────────

/// Encode the user-supplied app password as `<iv_b64>.<cipher_b64>` so it
/// fits in the existing `refresh_token` column. AES-256-GCM with a fresh
/// 12-byte nonce per encryption; the encryption layer handles HKDF.
pub fn encode_app_password(password: &str) -> anyhow::Result<String> {
    let (iv, cipher) = encrypt(password)?;
    Ok(format!("{iv}.{cipher}"))
}

/// Inverse of [`encode_app_password`]. Errors if the blob isn't in
/// `<iv>.<cipher>` form or the AES-GCM tag is invalid (key rotated,
/// corrupted row, etc.).
pub fn decode_app_password(stored: &str) -> anyhow::Result<String> {
    let (iv, cipher) = stored
        .split_once('.')
        .ok_or_else(|| anyhow!("yahoo credential blob missing IV separator"))?;
    decrypt(iv, cipher).map_err(|e| anyhow!("yahoo credential decrypt failed: {e}"))
}

// ─────────────────────────────────────────────────────────────────────
// TLS + IMAP connection
// ─────────────────────────────────────────────────────────────────────

/// Cached rustls config — built once at first use from the
/// `webpki-roots` trust bundle. No client auth (Yahoo authenticates the
/// user via IMAP LOGIN after the TLS handshake).
static RUSTLS_CONFIG: Lazy<Arc<ClientConfig>> = Lazy::new(|| {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
});

type YahooSession = async_imap::Session<tokio_rustls::client::TlsStream<TcpStream>>;

/// Open an IMAPS connection to Yahoo and run `LOGIN`. Returns an
/// authenticated session ready for SELECT/FETCH. Errors when the TLS
/// handshake, network connection, or login fails (LOGIN failure usually
/// means the app password is wrong or expired).
async fn connect_and_login(email: &str, password: &str) -> anyhow::Result<YahooSession> {
    let connector = TlsConnector::from(RUSTLS_CONFIG.clone());
    let server_name =
        ServerName::try_from(YAHOO_IMAP_HOST.to_string()).context("invalid IMAP host name")?;

    let tcp = timeout(
        IMAP_TIMEOUT,
        TcpStream::connect((YAHOO_IMAP_HOST, YAHOO_IMAP_PORT)),
    )
    .await
    .map_err(|_| anyhow!("yahoo imap connect timed out"))?
    .context("yahoo imap connect")?;

    let tls = timeout(IMAP_TIMEOUT, connector.connect(server_name, tcp))
        .await
        .map_err(|_| anyhow!("yahoo imap TLS handshake timed out"))?
        .context("yahoo imap TLS handshake")?;

    let client = Client::new(tls);

    let session = timeout(IMAP_TIMEOUT, client.login(email, password))
        .await
        .map_err(|_| anyhow!("yahoo imap login timed out"))?
        .map_err(|(err, _client)| anyhow!("yahoo imap LOGIN failed: {err}"))?;

    Ok(session)
}

/// Verify that `email` + `password` authenticate against Yahoo IMAP.
/// Used by the connect endpoint so a bad app password is rejected
/// before we persist it.
pub async fn verify_credentials(email: &str, password: &str) -> anyhow::Result<()> {
    let mut session = connect_and_login(email, password).await?;
    // LOGOUT is best-effort — if the network blip happens between LOGIN
    // and LOGOUT, the credential is still proven valid.
    let _ = timeout(IMAP_TIMEOUT, session.logout()).await;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// Sync — fetch the most recent SYNC_BATCH messages from INBOX and
// upsert them into `emails`. Body is encrypted inline (we already have
// the bytes in hand from FETCH RFC822, so the body_worker doesn't need
// to do a second pass like it does for Gmail).
// ─────────────────────────────────────────────────────────────────────

/// Single source of truth for "fetch this UID range from INBOX, parse,
/// upsert". The forward sync and the backfill path both call this with
/// different ranges. `range` follows IMAP UID syntax (e.g. `"1:50"` or
/// `"68900:69000"`).
async fn fetch_and_store_uid_range(
    pool: &PgPool,
    account_id: i32,
    session: &mut YahooSession,
    range: &str,
) -> anyhow::Result<u32> {
    let fetch_stream = timeout(
        IMAP_TIMEOUT,
        session.uid_fetch(range, "(UID INTERNALDATE FLAGS RFC822)"),
    )
    .await
    .map_err(|_| anyhow!("yahoo UID FETCH timed out"))?
    .context("yahoo UID FETCH")?;

    let fetches: Vec<_> = fetch_stream
        .try_collect()
        .await
        .context("yahoo UID FETCH collect")?;

    let inbox_labels = vec!["INBOX".to_string()];
    let mut inserted = 0u32;

    for fetch in fetches {
        let Some(uid) = fetch.uid else {
            warn!(target: "worker", account_id, "yahoo fetch row missing UID; skipping");
            continue;
        };
        let Some(body_bytes) = fetch.body() else {
            warn!(target: "worker", account_id, uid, "yahoo fetch row missing RFC822 body; skipping");
            continue;
        };

        let parsed = match MessageParser::default().parse(body_bytes) {
            Some(msg) => msg,
            None => {
                warn!(target: "worker", account_id, uid, "yahoo MIME parse failed; skipping");
                continue;
            }
        };

        let subject = parsed.subject().unwrap_or("").to_string();
        let sender = parsed
            .from()
            .and_then(|list| list.first())
            .map(format_addr)
            .unwrap_or_default();
        let receiver = parsed
            .to()
            .map(|list| list.iter().map(format_addr).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();

        let body_text = parsed
            .body_text(0)
            .map(|cow| cow.into_owned())
            .or_else(|| parsed.body_html(0).map(|cow| cow.into_owned()))
            .unwrap_or_default();

        let created_at: NaiveDateTime = fetch
            .internal_date()
            .map(|dt| dt.naive_utc())
            .unwrap_or_else(|| chrono::Utc::now().naive_utc());

        let is_read = fetch
            .flags()
            .any(|flag| matches!(flag, async_imap::types::Flag::Seen));

        let (body_iv, body_cipher) = if body_text.is_empty() {
            (String::new(), String::new())
        } else {
            match encrypt(&body_text) {
                Ok(pair) => pair,
                Err(e) => {
                    error!(target: "worker", account_id, uid, error = ?e, "yahoo body encrypt failed; skipping");
                    continue;
                }
            }
        };

        let yahoo_id = format!("yahoo-{uid}");
        let insert = InsertEmail {
            gmail_id: &yahoo_id,
            sender: &sender,
            receiver: &receiver,
            subject: &subject,
            created_at,
            is_read,
            labels: &inbox_labels,
            body: Some((&body_iv, &body_cipher)),
            attachments_checked: true,
        };

        if let Err(e) = upsert_one(pool, account_id, &insert).await {
            warn!(target: "worker", account_id, uid, error = ?e, "yahoo upsert failed");
            continue;
        }
        inserted += 1;
    }

    Ok(inserted)
}

pub async fn sync_yahoo_account(
    pool: &PgPool,
    account_id: i32,
    email: &str,
    password: &str,
) -> anyhow::Result<()> {
    let mut session = connect_and_login(email, password).await?;

    let mailbox = timeout(IMAP_TIMEOUT, session.select("INBOX"))
        .await
        .map_err(|_| anyhow!("yahoo SELECT INBOX timed out"))?
        .context("yahoo SELECT INBOX")?;

    if mailbox.exists == 0 {
        info!(target: "worker", account_id, "yahoo inbox is empty");
        let _ = timeout(IMAP_TIMEOUT, session.logout()).await;
        return Ok(());
    }

    // Pull the last SYNC_BATCH messages by sequence number. IMAP
    // sequence numbers are 1-indexed; `from..=to` with from clamped to
    // 1 gives us a safe range even on a < SYNC_BATCH mailbox. We FETCH
    // by sequence number (not UID) here because we don't yet know the
    // tail UID range — sequence-number FETCH always returns the newest
    // SYNC_BATCH regardless of UID gaps in the mailbox.
    let from = mailbox.exists.saturating_sub(SYNC_BATCH).saturating_add(1);
    let range = format!("{}:{}", from, mailbox.exists);

    let fetch_stream = timeout(
        IMAP_TIMEOUT,
        session.fetch(range, "(UID INTERNALDATE FLAGS RFC822)"),
    )
    .await
    .map_err(|_| anyhow!("yahoo FETCH timed out"))?
    .context("yahoo FETCH")?;

    let fetches: Vec<_> = fetch_stream
        .try_collect()
        .await
        .context("yahoo FETCH collect")?;

    info!(target: "worker", account_id, count = fetches.len(), "yahoo fetched");

    let inbox_labels = vec!["INBOX".to_string()];
    let mut inserted = 0u32;

    for fetch in fetches {
        let Some(uid) = fetch.uid else {
            warn!(target: "worker", account_id, "yahoo fetch row missing UID; skipping");
            continue;
        };
        let Some(body_bytes) = fetch.body() else {
            warn!(target: "worker", account_id, uid, "yahoo fetch row missing RFC822 body; skipping");
            continue;
        };

        let parsed = match MessageParser::default().parse(body_bytes) {
            Some(msg) => msg,
            None => {
                warn!(target: "worker", account_id, uid, "yahoo MIME parse failed; skipping");
                continue;
            }
        };

        let subject = parsed.subject().unwrap_or("").to_string();
        let sender = parsed
            .from()
            .and_then(|list| list.first())
            .map(format_addr)
            .unwrap_or_default();
        let receiver = parsed
            .to()
            .map(|list| list.iter().map(format_addr).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();

        let body_text = parsed
            .body_text(0)
            .map(|cow| cow.into_owned())
            .or_else(|| parsed.body_html(0).map(|cow| cow.into_owned()))
            .unwrap_or_default();

        let created_at: NaiveDateTime = fetch
            .internal_date()
            .map(|dt| dt.naive_utc())
            .unwrap_or_else(|| chrono::Utc::now().naive_utc());

        let is_read = fetch
            .flags()
            .any(|flag| matches!(flag, async_imap::types::Flag::Seen));

        // Encrypt the body up front so we can write a fully-populated
        // row (Gmail leaves body_encrypted='' for body_worker; Yahoo
        // doesn't need that detour because IMAP already gave us bytes).
        let (body_iv, body_cipher) = if body_text.is_empty() {
            (String::new(), String::new())
        } else {
            match encrypt(&body_text) {
                Ok(pair) => pair,
                Err(e) => {
                    error!(target: "worker", account_id, uid, error = ?e, "yahoo body encrypt failed; skipping");
                    continue;
                }
            }
        };

        // Synthesize a stable provider id from the IMAP UID so the
        // (account_id, gmail_id) uniqueness gives us idempotent upserts
        // across re-runs. The `yahoo-` prefix prevents collisions with
        // Gmail's numeric ids if a row ever moves between providers.
        let yahoo_id = format!("yahoo-{uid}");

        let insert = InsertEmail {
            gmail_id: &yahoo_id,
            sender: &sender,
            receiver: &receiver,
            subject: &subject,
            created_at,
            is_read,
            labels: &inbox_labels,
            body: Some((&body_iv, &body_cipher)),
            attachments_checked: true,
        };

        if let Err(e) = upsert_one(pool, account_id, &insert).await {
            warn!(target: "worker", account_id, uid, error = ?e, "yahoo upsert failed");
            continue;
        }
        inserted += 1;
    }

    info!(target: "worker", account_id, inserted, "yahoo sync complete");

    let _ = timeout(IMAP_TIMEOUT, session.logout()).await;
    Ok(())
}

/// Backfill older Yahoo messages — what `MailProvider::sync_before` runs
/// every sync tick after the forward `sync_yahoo_account` finishes. We
/// anchor at the lowest UID we've already stored (parsed from
/// `gmail_id = "yahoo-<uid>"`) and request the next `limit` UIDs below
/// that, capped at 500 per tick so the worker doesn't churn a huge FETCH.
///
/// Stops naturally on the first empty FETCH (mailbox exhausted), because
/// the next tick's lowest UID stays at the same floor and the worker
/// either pulls an empty range or the same range again — both idempotent
/// thanks to the `(account_id, gmail_id)` unique constraint.
pub async fn sync_yahoo_account_before(
    pool: &PgPool,
    account_id: i32,
    email: &str,
    password: &str,
    limit: usize,
) -> anyhow::Result<()> {
    // Find the lowest yahoo UID we've already stored. SUBSTRING starts
    // at 1, "yahoo-".len() == 6, so position 7 onward is the UID digits.
    let lowest: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT MIN(CAST(SUBSTRING(gmail_id FROM 7) AS BIGINT))
          FROM emails
         WHERE account_id = $1
           AND gmail_id LIKE 'yahoo-%'
        "#,
    )
    .bind(account_id)
    .fetch_one(pool)
    .await?;

    let Some(lowest) = lowest else {
        // No mail stored yet — the forward sync will handle the initial
        // pull on the next tick. Skip backfill until then.
        return Ok(());
    };

    if lowest <= 1 {
        // Already at UID 1 — nothing older possible.
        return Ok(());
    }

    let cap = limit.clamp(1, 500) as i64;
    let from = (lowest - cap).max(1);
    let to = lowest - 1;
    let range = format!("{from}:{to}");

    let mut session = connect_and_login(email, password).await?;
    let _ = timeout(IMAP_TIMEOUT, session.select("INBOX"))
        .await
        .map_err(|_| anyhow!("yahoo SELECT INBOX timed out"))?
        .context("yahoo SELECT INBOX")?;

    let inserted = fetch_and_store_uid_range(pool, account_id, &mut session, &range).await?;
    info!(
        target: "worker",
        account_id,
        range = %range,
        inserted,
        "yahoo backfill complete"
    );

    let _ = timeout(IMAP_TIMEOUT, session.logout()).await;
    Ok(())
}

fn format_addr(a: &mail_parser::Addr<'_>) -> String {
    // Mirror what the Gmail sync path stores ("Name <email>" or bare
    // email if no display name) so the UI's existing sender/receiver
    // display logic doesn't see a divergent format.
    let email = a.address.as_deref().unwrap_or("");
    match a.name.as_deref().filter(|n| !n.is_empty()) {
        Some(name) => format!("{name} <{email}>"),
        None => email.to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────
// Send via lettre over SMTPS
// ─────────────────────────────────────────────────────────────────────

pub async fn send_via_yahoo(
    from_email: &str,
    password: &str,
    data: &SendEmailRequest,
) -> HttpResponse {
    let creds = Credentials::new(from_email.to_string(), password.to_string());
    let mailer = match AsyncSmtpTransport::<Tokio1Executor>::relay(YAHOO_SMTP_HOST) {
        Ok(builder) => builder.port(YAHOO_SMTP_PORT).credentials(creds).build(),
        Err(e) => {
            error!(target: "send", error = ?e, "yahoo SMTP relay builder failed");
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": format!("Yahoo SMTP setup failed: {e}")
            }));
        }
    };

    let from = match from_email.parse() {
        Ok(addr) => addr,
        Err(e) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": format!("Invalid From address: {e}")
            }));
        }
    };
    let to = match data.to.parse() {
        Ok(addr) => addr,
        Err(e) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": format!("Invalid To address: {e}")
            }));
        }
    };

    let message = match Message::builder()
        .from(from)
        .to(to)
        .subject(&data.subject)
        .header(ContentType::TEXT_HTML)
        .body(data.body.clone())
    {
        Ok(m) => m,
        Err(e) => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": format!("Could not build message: {e}")
            }));
        }
    };

    match mailer.send(message).await {
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({ "status": "sent" })),
        Err(e) => {
            error!(target: "send", error = ?e, "yahoo SMTP send failed");
            HttpResponse::BadGateway().json(serde_json::json!({
                "error": format!("Yahoo send failed: {e}")
            }))
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Mark-read via IMAP STORE +FLAGS \Seen
// ─────────────────────────────────────────────────────────────────────

pub async fn mark_read_yahoo(
    email: &str,
    password: &str,
    provider_message_id: &str,
) -> anyhow::Result<()> {
    // We persisted the provider id as `yahoo-<uid>`. Strip the prefix
    // so we have a raw IMAP UID we can hand to STORE.
    let uid = provider_message_id
        .strip_prefix("yahoo-")
        .ok_or_else(|| anyhow!("not a yahoo provider id: {provider_message_id}"))?;

    let mut session = connect_and_login(email, password).await?;

    timeout(IMAP_TIMEOUT, session.select("INBOX"))
        .await
        .map_err(|_| anyhow!("yahoo SELECT INBOX timed out"))?
        .context("yahoo SELECT INBOX")?;

    // UID STORE prevents sequence-number drift between SELECT and
    // STORE (a new message arriving would shift sequence numbers).
    let _: Vec<_> = timeout(IMAP_TIMEOUT, session.uid_store(uid, "+FLAGS (\\Seen)"))
        .await
        .map_err(|_| anyhow!("yahoo STORE timed out"))?
        .context("yahoo UID STORE")?
        .try_collect()
        .await
        .context("yahoo STORE collect")?;

    let _ = timeout(IMAP_TIMEOUT, session.logout()).await;
    Ok(())
}
