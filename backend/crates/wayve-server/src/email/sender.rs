use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use thiserror::Error;
use tracing::{error, info, instrument};

pub(crate) fn clean_mailbox(value: &str) -> String {
    value
        .split_once('#')
        .map_or(value, |(before_comment, _)| before_comment)
        .trim()
        .to_string()
}

#[derive(Debug, Error)]
pub enum MailError {
    #[error("{0} missing")]
    MissingEnv(&'static str),
    #[error("{field} invalid: {source}")]
    InvalidMailbox {
        field: &'static str,
        source: lettre::address::AddressError,
    },
    #[error("message build failed: {0}")]
    MessageBuild(#[source] lettre::error::Error),
    #[error("transport build failed: {0}")]
    TransportBuild(#[source] lettre::transport::smtp::Error),
    #[error("content type invalid: {0}")]
    ContentType(String),
    #[error("send failed: {0}")]
    Send(#[source] lettre::transport::smtp::Error),
    #[error("no valid recipients")]
    NoRecipients,
}

/// Build the SMTP transport from config. Local dev traps (Mailpit) don't always
/// speak STARTTLS, so detect the common dev hostnames and use a plaintext
/// transport for them; production (Gmail, SES, …) stays on STARTTLS with auth.
fn build_transport(
    host: &str,
    port: u16,
    user: String,
    pass: String,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, MailError> {
    let is_local_relay = matches!(host, "mailpit" | "localhost" | "127.0.0.1");
    let mailer = if is_local_relay {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
            .port(port)
            .build()
    } else {
        let creds = Credentials::new(user, pass);
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
            .map_err(MailError::TransportBuild)?
            .port(port)
            .credentials(creds)
            .build()
    };
    Ok(mailer)
}

#[instrument(target = "smtp", skip(body), fields(to, subject))]
pub async fn send_mail(to: &str, subject: &str, body: &str) -> Result<(), MailError> {
    let crate::config::SmtpConfig {
        host,
        port,
        user,
        pass,
        from,
    } = crate::config::smtp().map_err(MailError::MissingEnv)?;

    let from_parsed = clean_mailbox(&from)
        .parse()
        .map_err(|source| MailError::InvalidMailbox {
            field: "SMTP_FROM",
            source,
        })?;
    let to_parsed = clean_mailbox(to)
        .parse()
        .map_err(|source| MailError::InvalidMailbox {
            field: "recipient",
            source,
        })?;

    let email = Message::builder()
        .from(from_parsed)
        .to(to_parsed)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body.to_string())
        .map_err(MailError::MessageBuild)?;

    let mailer = build_transport(&host, port, user, pass)?;

    match mailer.send(email).await {
        Ok(_) => {
            info!(target: "smtp", to, "mail sent");
            Ok(())
        }
        Err(e) => {
            error!(target: "smtp", to, error = %e, "mail send failed");
            Err(MailError::Send(e))
        }
    }
}

/// Send a plain-text message with a calendar invite (`.ics`) attached. The
/// recipient's mail client offers to add the event at the event's start time.
/// Used by the public "Book a demo" form to drop the slot onto sales' calendar.
#[instrument(target = "smtp", skip(body, ics), fields(to, subject))]
pub async fn send_mail_with_ics(
    to: &str,
    subject: &str,
    body: &str,
    ics: &str,
) -> Result<(), MailError> {
    let crate::config::SmtpConfig {
        host,
        port,
        user,
        pass,
        from,
    } = crate::config::smtp().map_err(MailError::MissingEnv)?;

    let from_parsed = clean_mailbox(&from)
        .parse()
        .map_err(|source| MailError::InvalidMailbox {
            field: "SMTP_FROM",
            source,
        })?;
    let to_parsed = clean_mailbox(to)
        .parse()
        .map_err(|source| MailError::InvalidMailbox {
            field: "recipient",
            source,
        })?;

    let ics_type = ContentType::parse("text/calendar; charset=utf-8; method=REQUEST")
        .map_err(|e| MailError::ContentType(e.to_string()))?;

    let email = Message::builder()
        .from(from_parsed)
        .to(to_parsed)
        .subject(subject)
        .multipart(
            MultiPart::mixed()
                .singlepart(SinglePart::plain(body.to_string()))
                .singlepart(
                    Attachment::new("invite.ics".to_string()).body(ics.to_string(), ics_type),
                ),
        )
        .map_err(MailError::MessageBuild)?;

    let mailer = build_transport(&host, port, user, pass)?;

    match mailer.send(email).await {
        Ok(_) => {
            info!(target: "smtp", to, "calendar mail sent");
            Ok(())
        }
        Err(e) => {
            error!(target: "smtp", to, error = %e, "calendar mail send failed");
            Err(MailError::Send(e))
        }
    }
}

/// One decoded outgoing attachment, ready to drop into a MIME part.
#[derive(Debug, Clone)]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// Build a `lettre` message with a plain-text body and optional binary
/// attachments. `from`/`to` are raw address strings (`to` may be a
/// comma-separated list). Shared by the dev SMTP path and the Gmail raw-MIME
/// path (which serialises the result via `Message::formatted()`), so both
/// produce identical, correct `multipart/mixed` output instead of hand-rolled
/// boundaries.
pub fn build_message(
    from: &str,
    to: &str,
    subject: &str,
    body: &str,
    attachments: &[OutgoingAttachment],
) -> Result<Message, MailError> {
    let from_parsed: Mailbox =
        clean_mailbox(from)
            .parse()
            .map_err(|source| MailError::InvalidMailbox {
                field: "from",
                source,
            })?;

    let mut builder = Message::builder().from(from_parsed).subject(subject);
    let mut has_recipient = false;
    for addr in to.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let mailbox: Mailbox =
            clean_mailbox(addr)
                .parse()
                .map_err(|source| MailError::InvalidMailbox {
                    field: "recipient",
                    source,
                })?;
        builder = builder.to(mailbox);
        has_recipient = true;
    }
    if !has_recipient {
        return Err(MailError::NoRecipients);
    }

    if attachments.is_empty() {
        return builder
            .header(ContentType::TEXT_PLAIN)
            .body(body.to_string())
            .map_err(MailError::MessageBuild);
    }

    let mut multipart = MultiPart::mixed().singlepart(SinglePart::plain(body.to_string()));
    for attachment in attachments {
        // Fall back to a generic binary type for an unparseable MIME; the final
        // `unwrap_or` is unreachable (octet-stream always parses) but avoids a
        // banned `expect`.
        let content_type = ContentType::parse(&attachment.mime_type)
            .or_else(|_| ContentType::parse("application/octet-stream"))
            .unwrap_or(ContentType::TEXT_PLAIN);
        multipart = multipart.singlepart(
            Attachment::new(attachment.filename.clone())
                .body(attachment.bytes.clone(), content_type),
        );
    }
    builder
        .multipart(multipart)
        .map_err(MailError::MessageBuild)
}

/// Send a plain-text message with binary attachments over SMTP (used by the
/// dev/Mailpit shortcut). Mirrors `send_mail` but with a `multipart/mixed` body.
#[instrument(target = "smtp", skip(body, attachments), fields(to, subject))]
pub async fn send_mail_with_attachments(
    to: &str,
    subject: &str,
    body: &str,
    attachments: &[OutgoingAttachment],
) -> Result<(), MailError> {
    let crate::config::SmtpConfig {
        host,
        port,
        user,
        pass,
        from,
    } = crate::config::smtp().map_err(MailError::MissingEnv)?;

    let message = build_message(&from, to, subject, body, attachments)?;
    let mailer = build_transport(&host, port, user, pass)?;
    match mailer.send(message).await {
        Ok(_) => {
            info!(target: "smtp", to, "mail with attachments sent");
            Ok(())
        }
        Err(e) => {
            error!(target: "smtp", to, error = %e, "mail with attachments send failed");
            Err(MailError::Send(e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_message_plain_when_no_attachments() {
        let msg = build_message("from@example.com", "to@example.com", "Hi", "Body", &[])
            .unwrap_or_else(|e| panic!("build failed: {e}"));
        let raw = String::from_utf8_lossy(&msg.formatted()).to_string();
        assert!(raw.contains("To: to@example.com"));
        assert!(!raw.contains("multipart/mixed"));
    }

    #[test]
    fn build_message_multipart_with_attachment() {
        let attachments = vec![OutgoingAttachment {
            filename: "note.txt".to_string(),
            mime_type: "text/plain".to_string(),
            bytes: b"hello world".to_vec(),
        }];
        let msg = build_message(
            "from@example.com",
            "to@example.com",
            "Hi",
            "Body",
            &attachments,
        )
        .unwrap_or_else(|e| panic!("build failed: {e}"));
        let raw = String::from_utf8_lossy(&msg.formatted()).to_string();
        assert!(raw.contains("multipart/mixed"));
        assert!(raw.contains("Content-Disposition: attachment"));
        assert!(raw.contains("note.txt"));
    }

    #[test]
    fn build_message_handles_multiple_recipients() {
        let msg = build_message("from@example.com", "a@x.com, b@y.com", "Hi", "Body", &[])
            .unwrap_or_else(|e| panic!("build failed: {e}"));
        let raw = String::from_utf8_lossy(&msg.formatted()).to_string();
        assert!(raw.contains("a@x.com"));
        assert!(raw.contains("b@y.com"));
    }

    #[test]
    fn build_message_rejects_no_recipients() {
        let err = build_message("from@example.com", "  ,  ", "Hi", "Body", &[]);
        assert!(matches!(err, Err(MailError::NoRecipients)));
    }
}
