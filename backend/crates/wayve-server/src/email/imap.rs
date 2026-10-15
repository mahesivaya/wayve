//! Generic IMAP (read) and SMTP (send) connector for custom-domain mailboxes,
//! meaning any provider without a first-class OAuth integration. The user
//! supplies a host, port, and app password; it is verified with a real IMAP
//! LOGIN and stored encrypted at rest (AES-256-GCM, `<iv>.<cipher>`) in
//! `email_accounts.refresh_token`, with the connection settings in the
//! `imap_*`/`smtp_*`/`mail_security` columns.

use crate::email::repo::{InsertEmail, upsert_one};
use crate::models::email_request::SendEmailRequest;
use crate::prelude::*;
use actix_web::HttpResponse;
use anyhow::{Context, anyhow};
use async_imap::Client;
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
use tracing::warn;
use wayve_security::encryption::{decrypt, encrypt};

/// How many of the most-recent INBOX messages each sync tick pulls. IMAP
/// FETCH RFC822 returns the full raw bytes per message, so kept conservative.
const SYNC_BATCH: u32 = 50;
/// Wall-clock cap per IMAP operation so a hung handshake can't pin a worker.
const IMAP_TIMEOUT: Duration = Duration::from_secs(30);

/// Transport security for the connection. `'starttls'` upgrades a plaintext
/// connection; anything else is treated as implicit TLS (the common 993/465).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MailSecurity {
    Ssl,
    StartTls,
}

impl MailSecurity {
    pub fn from_db(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("starttls") => Self::StartTls,
            _ => Self::Ssl,
        }
    }
}

/// Encrypts the app password at rest into the `<iv>.<cipher>` blob stored in
/// `email_accounts.refresh_token`.
pub fn encode_secret(password: &str) -> anyhow::Result<String> {
    let (iv, cipher) = encrypt(password)?;
    Ok(format!("{iv}.{cipher}"))
}

pub fn decode_secret(stored: &str) -> anyhow::Result<String> {
    let (iv, cipher) = stored
        .split_once('.')
        .ok_or_else(|| anyhow!("imap credential blob missing IV separator"))?;
    decrypt(iv, cipher).map_err(|e| anyhow!("imap credential decrypt failed: {e}"))
}

static RUSTLS_CONFIG: Lazy<Arc<ClientConfig>> = Lazy::new(|| {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
});

type ImapSession = async_imap::Session<tokio_rustls::client::TlsStream<TcpStream>>;

/// Opens an implicit-TLS connection and runs LOGIN. STARTTLS on 143 is not
/// supported: autodiscovery defaults every provider to 993 implicit TLS, which
/// all the common hosts accept.
async fn connect_and_login(
    host: &str,
    port: u16,
    email: &str,
    password: &str,
) -> anyhow::Result<ImapSession> {
    let connector = TlsConnector::from(RUSTLS_CONFIG.clone());
    let server_name = ServerName::try_from(host.to_string()).context("invalid IMAP host name")?;

    let tcp = timeout(IMAP_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| anyhow!("imap connect timed out"))?
        .context("imap connect")?;

    let tls = timeout(IMAP_TIMEOUT, connector.connect(server_name, tcp))
        .await
        .map_err(|_| anyhow!("imap TLS handshake timed out"))?
        .context("imap TLS handshake")?;

    let client = Client::new(tls);
    let session = timeout(IMAP_TIMEOUT, client.login(email, password))
        .await
        .map_err(|_| anyhow!("imap login timed out"))?
        .map_err(|(err, _client)| anyhow!("imap LOGIN failed: {err}"))?;

    Ok(session)
}

/// Verifies credentials with a real IMAP LOGIN, persisting nothing.
pub async fn verify_credentials(
    host: &str,
    port: u16,
    email: &str,
    password: &str,
) -> anyhow::Result<()> {
    let mut session = connect_and_login(host, port, email, password).await?;
    let _ = timeout(IMAP_TIMEOUT, session.logout()).await;
    Ok(())
}

/// One fetched message, drained from the IMAP stream before any DB await so the
/// stream's mutable borrow of the session is released first.
struct FetchedMessage {
    uid: u32,
    raw: Vec<u8>,
    internal_date: Option<chrono::DateTime<chrono::FixedOffset>>,
    seen: bool,
}

#[allow(clippy::too_many_arguments)]
pub async fn sync_imap_account(
    pool: &PgPool,
    account_id: i32,
    host: &str,
    port: u16,
    email: &str,
    password: &str,
) -> anyhow::Result<()> {
    let mut session = connect_and_login(host, port, email, password).await?;

    let mailbox = timeout(IMAP_TIMEOUT, session.select("INBOX"))
        .await
        .map_err(|_| anyhow!("imap SELECT timed out"))?
        .context("imap SELECT INBOX")?;

    let total = mailbox.exists;
    if total == 0 {
        let _ = session.logout().await;
        return Ok(());
    }
    let start = total.saturating_sub(SYNC_BATCH - 1).max(1);
    let range = format!("{start}:{total}");

    // The fetch stream borrows the session, so it must be fully drained before
    // any DB await.
    let mut messages: Vec<FetchedMessage> = Vec::new();
    {
        let mut stream = timeout(
            IMAP_TIMEOUT,
            session.fetch(range, "(UID INTERNALDATE FLAGS RFC822)"),
        )
        .await
        .map_err(|_| anyhow!("imap FETCH timed out"))?
        .context("imap FETCH")?;

        while let Some(fetch) = stream.try_next().await.context("imap FETCH stream")? {
            let Some(uid) = fetch.uid else { continue };
            let Some(body) = fetch.body() else { continue };
            let seen = fetch
                .flags()
                .any(|flag| matches!(flag, async_imap::types::Flag::Seen));
            messages.push(FetchedMessage {
                uid,
                raw: body.to_vec(),
                internal_date: fetch.internal_date(),
                seen,
            });
        }
    }

    for msg in &messages {
        if let Err(e) = store_message(pool, account_id, msg).await {
            warn!(target: "worker", account_id, uid = msg.uid, error = ?e, "imap message store failed");
        }
    }

    let _ = timeout(IMAP_TIMEOUT, session.logout()).await;
    Ok(())
}

/// Every address in a To or Cc header, comma-separated, as Gmail stores its
/// headers. Group syntax is flattened; entries without an address are skipped.
fn address_list(list: Option<&mail_parser::Address<'_>>) -> String {
    list.map(|a| {
        a.iter()
            .filter_map(|addr| addr.address())
            .map(str::trim)
            .filter(|addr| !addr.is_empty())
            .collect::<Vec<_>>()
            .join(", ")
    })
    .unwrap_or_default()
}

async fn store_message(pool: &PgPool, account_id: i32, msg: &FetchedMessage) -> anyhow::Result<()> {
    let parsed = MessageParser::default()
        .parse(&msg.raw)
        .ok_or_else(|| anyhow!("could not parse RFC822 message"))?;

    let sender = parsed
        .from()
        .and_then(|a| a.first())
        .and_then(|addr| addr.address())
        .unwrap_or("")
        .to_string();
    let receiver = address_list(parsed.to());
    let cc = address_list(parsed.cc());
    let subject = parsed.subject().unwrap_or("").to_string();

    let body_text = parsed
        .body_text(0)
        .map(|c| c.into_owned())
        .or_else(|| parsed.body_html(0).map(|c| c.into_owned()))
        .unwrap_or_default();
    let (body_iv, body_ct) = encrypt(&body_text).context("encrypt imap body")?;

    // Real mail always has a From and a sane date, so a missing From or an epoch
    // INTERNALDATE is a strong spam signal. Route those to Spam rather than let
    // them surface in the Inbox as "Unknown / (No Subject)" dated 1970.
    use chrono::Datelike;
    let bad_date = msg
        .internal_date
        .map(|d| d.naive_utc().year() < 2000)
        .unwrap_or(false);
    let is_junk = sender.trim().is_empty() || bad_date;
    let labels: Vec<String> = if is_junk {
        vec!["SPAM".to_string()]
    } else {
        Vec::new()
    };

    // A pre-2000 date would render as "Dec 31 1969", so fall back to now.
    let created_at = msg
        .internal_date
        .map(|d| d.naive_utc())
        .filter(|d| d.year() >= 2000)
        .unwrap_or_else(|| chrono::Utc::now().naive_utc());

    let gmail_id = format!("imap-{}", msg.uid);
    let row = InsertEmail {
        gmail_id: &gmail_id,
        sender: &sender,
        receiver: &receiver,
        cc: Some(&cc),
        subject: &subject,
        created_at,
        is_read: msg.seen,
        labels: &labels,
        // The full RFC822 is already in hand, so the body goes in inline and no
        // body_worker pass is needed.
        body: Some((&body_iv, &body_ct)),
        attachments_checked: true,
    };
    let email_id = upsert_one(pool, account_id, &row).await?;

    // The full message is in hand, so all three reply headers are available.
    // IMAP has no conversation id of its own.
    let threading = crate::email::threading::ThreadHeaders {
        message_id: parsed.message_id().map(str::to_string),
        in_reply_to: parsed
            .in_reply_to()
            .as_text_list()
            .and_then(|ids| ids.last().map(|id| id.to_string())),
        references: parsed
            .references()
            .as_text_list()
            .map(|ids| ids.into_iter().map(str::to_string).collect())
            .unwrap_or_default(),
        provider_thread_id: None,
    };
    crate::email::threading::assign_best_effort(
        pool,
        account_id,
        crate::email::threading::ThreadInput {
            email_id,
            headers: &threading,
            subject: &subject,
            sender: &sender,
            receiver: &receiver,
            created_at: Some(created_at),
        },
    )
    .await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn send_via_imap(
    smtp_host: &str,
    smtp_port: u16,
    security: MailSecurity,
    from_email: &str,
    password: &str,
    data: &SendEmailRequest,
) -> HttpResponse {
    let message = match build_message(from_email, data) {
        Ok(m) => m,
        Err(e) => {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({ "error": format!("invalid message: {e}") }));
        }
    };

    let creds = Credentials::new(from_email.to_string(), password.to_string());
    let builder = match security {
        MailSecurity::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(smtp_host),
        MailSecurity::Ssl => AsyncSmtpTransport::<Tokio1Executor>::relay(smtp_host),
    };
    let mailer = match builder {
        Ok(b) => b.port(smtp_port).credentials(creds).build(),
        Err(e) => {
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": format!("smtp setup failed: {e}") }));
        }
    };

    match mailer.send(message).await {
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({ "status": "sent" })),
        Err(e) => {
            warn!(target: "send", error = ?e, "imap/smtp send failed");
            HttpResponse::BadGateway()
                .json(serde_json::json!({ "error": format!("send failed: {e}") }))
        }
    }
}

fn build_message(from_email: &str, data: &SendEmailRequest) -> anyhow::Result<Message> {
    let mut builder = Message::builder()
        .from(from_email.parse().context("from address")?)
        .to(data.to.parse().context("to address")?);
    for addr in crate::email::send::normalized_cc(data) {
        builder = builder.cc(addr.parse().context("cc address")?);
    }
    // lettre strips the Bcc header once it has the envelope, which is what SMTP
    // needs: the blind recipients are delivered to without appearing on the
    // message the others receive.
    for addr in crate::email::send::normalized_bcc(data) {
        builder = builder.bcc(addr.parse().context("bcc address")?);
    }
    // A reply joins its conversation. Validated `<id>` values only — see
    // `reply_headers::load`.
    if let Some(reply) = &data.reply_headers {
        builder = builder
            .in_reply_to(reply.in_reply_to.clone())
            .references(reply.references.clone());
    }
    builder
        .subject(&data.subject)
        .header(ContentType::TEXT_PLAIN)
        .body(data.body.clone())
        .context("build message")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email::reply_headers::ReplyHeaders;

    fn request(reply: Option<ReplyHeaders>) -> SendEmailRequest {
        SendEmailRequest {
            account_id: 1,
            to: "bob@example.com".into(),
            subject: "Re: hi".into(),
            body: "reply".into(),
            cc: vec![],
            bcc: vec![],
            attachments: vec![],
            forward_attachment_ids: vec![],
            reply_to_email_id: None,
            reply_headers: reply,
        }
    }

    fn formatted(data: &SendEmailRequest) -> String {
        let message =
            build_message("me@example.com", data).unwrap_or_else(|e| panic!("build failed: {e}"));
        String::from_utf8_lossy(&message.formatted()).into_owned()
    }

    #[test]
    fn a_reply_over_smtp_carries_the_threading_headers() {
        let raw = formatted(&request(Some(ReplyHeaders {
            in_reply_to: "<orig@x.com>".into(),
            references: "<root@x.com> <orig@x.com>".into(),
            gmail_thread_id: None,
        })));
        assert!(raw.contains("In-Reply-To: <orig@x.com>\r\n"), "{raw}");
        assert!(
            raw.contains("References: <root@x.com> <orig@x.com>\r\n"),
            "{raw}"
        );
    }

    #[test]
    fn every_to_and_cc_address_is_kept() {
        let raw = b"From: Ada <ada@x.com>\r\n\
To: me@x.com, \"Lee, Dan\" <dan@x.com>\r\n\
Cc: Team: carol@x.com, eve@x.com;, bo@x.com\r\n\
Subject: Plans\r\n\r\nHi\r\n";
        let parsed = MessageParser::default()
            .parse(&raw[..])
            .unwrap_or_else(|| panic!("parse"));
        assert_eq!(address_list(parsed.to()), "me@x.com, dan@x.com");
        assert_eq!(
            address_list(parsed.cc()),
            "carol@x.com, eve@x.com, bo@x.com"
        );
        assert_eq!(address_list(parsed.bcc()), "", "a missing header is empty");
    }

    #[test]
    fn a_new_message_over_smtp_has_no_threading_headers() {
        let raw = formatted(&request(None));
        assert!(!raw.contains("In-Reply-To:"), "{raw}");
        assert!(!raw.contains("References:"), "{raw}");
    }
}
