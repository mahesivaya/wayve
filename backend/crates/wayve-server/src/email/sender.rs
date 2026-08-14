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
    send_mail_reply_to(to, subject, body, None).await
}

/// `send_mail` with an optional `Reply-To`. Needed wherever the sending mailbox
/// isn't the person the recipient should answer — meeting invites go out from
/// the server's SMTP identity, but replies belong to the organizer.
#[instrument(target = "smtp", skip(body), fields(to, subject))]
pub async fn send_mail_reply_to(
    to: &str,
    subject: &str,
    body: &str,
    reply_to: Option<&str>,
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

    let mut builder = Message::builder().from(from_parsed).to(to_parsed);
    if let Some(addr) = reply_to {
        let parsed = clean_mailbox(addr)
            .parse()
            .map_err(|source| MailError::InvalidMailbox {
                field: "reply_to",
                source,
            })?;
        builder = builder.reply_to(parsed);
    }

    let email = builder
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

/// Whether the serialised message keeps its `Bcc` header.
///
/// This is a privacy decision, not a formatting one, so callers state it
/// explicitly rather than inheriting a default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BccHeader {
    /// Drop it. SMTP carries blind recipients in the envelope, so a surviving
    /// `Bcc:` header would expose them to everyone else on the message.
    Drop,
    /// Keep it. The Gmail API takes no separate envelope and reads the blind
    /// recipients out of the raw MIME, stripping the header itself before
    /// delivery — dropping it here would mean they simply never receive it.
    Keep,
}

/// Builds a `lettre` message with a plain-text body and optional attachments.
/// `to` may be a comma-separated list; `cc` and `bcc` are pre-split lists.
/// Shared by the dev SMTP path and the Gmail raw-MIME path so both emit identical
/// `multipart/mixed` output rather than hand-rolled boundaries — which is also
/// why `bcc_header` has to be a parameter: those two transports need opposite
/// treatment of the same header.
#[allow(clippy::too_many_arguments)]
pub fn build_message(
    from: &str,
    to: &str,
    cc: &[String],
    bcc: &[String],
    bcc_header: BccHeader,
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
    for addr in cc.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let mailbox: Mailbox =
            clean_mailbox(addr)
                .parse()
                .map_err(|source| MailError::InvalidMailbox {
                    field: "cc",
                    source,
                })?;
        builder = builder.cc(mailbox);
    }
    for addr in bcc.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let mailbox: Mailbox =
            clean_mailbox(addr)
                .parse()
                .map_err(|source| MailError::InvalidMailbox {
                    field: "bcc",
                    source,
                })?;
        builder = builder.bcc(mailbox);
    }
    // lettre's default is to use the Bcc header to build the envelope and then
    // strip it, which is what SMTP wants; Keep opts out for Gmail.
    if bcc_header == BccHeader::Keep {
        builder = builder.keep_bcc();
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
#[allow(clippy::too_many_arguments)]
pub async fn send_mail_with_attachments(
    to: &str,
    cc: &[String],
    bcc: &[String],
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

    // Drop: this goes over SMTP, which takes the blind recipients from the
    // envelope lettre derives before stripping the header.
    let message = build_message(
        &from,
        to,
        cc,
        bcc,
        BccHeader::Drop,
        subject,
        body,
        attachments,
    )?;
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

    /// The common case: no bcc, and the SMTP treatment of the header.
    fn build_plain(to: &str, cc: &[String], attachments: &[OutgoingAttachment]) -> Message {
        build_message(
            "from@example.com",
            to,
            cc,
            &[],
            BccHeader::Drop,
            "Hi",
            "Body",
            attachments,
        )
        .unwrap_or_else(|e| panic!("build failed: {e}"))
    }

    fn rendered(msg: &Message) -> String {
        String::from_utf8_lossy(&msg.formatted()).to_string()
    }

    #[test]
    fn build_message_plain_when_no_attachments() {
        let raw = rendered(&build_plain("to@example.com", &[], &[]));
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
        let raw = rendered(&build_plain("to@example.com", &[], &attachments));
        assert!(raw.contains("multipart/mixed"));
        assert!(raw.contains("Content-Disposition: attachment"));
        assert!(raw.contains("note.txt"));
    }

    #[test]
    fn build_message_handles_multiple_recipients() {
        let raw = rendered(&build_plain("a@x.com, b@y.com", &[], &[]));
        assert!(raw.contains("a@x.com"));
        assert!(raw.contains("b@y.com"));
    }

    #[test]
    fn build_message_includes_cc_header() {
        let cc = vec!["c@z.com".to_string()];
        let raw = rendered(&build_plain("to@example.com", &cc, &[]));
        assert!(raw.contains("Cc: c@z.com"), "cc header missing: {raw}");
    }

    #[test]
    fn build_message_omits_cc_when_empty() {
        let raw = rendered(&build_plain("to@example.com", &[], &[]));
        assert!(!raw.contains("Cc:"));
    }

    #[test]
    fn smtp_keeps_bcc_out_of_the_delivered_headers() {
        // The privacy guarantee: over SMTP the blind recipient must reach the
        // envelope and must NOT appear on the message the others receive.
        let bcc = vec!["blind@z.com".to_string()];
        let msg = build_message(
            "from@example.com",
            "to@example.com",
            &[],
            &bcc,
            BccHeader::Drop,
            "Hi",
            "Body",
            &[],
        )
        .unwrap_or_else(|e| panic!("build failed: {e}"));

        let raw = rendered(&msg);
        assert!(!raw.contains("Bcc:"), "bcc header leaked: {raw}");
        assert!(!raw.contains("blind@z.com"), "bcc address leaked: {raw}");

        // …but it is still delivered to.
        let envelope_has_blind = msg
            .envelope()
            .to()
            .iter()
            .any(|a| a.to_string() == "blind@z.com");
        assert!(envelope_has_blind, "bcc missing from the envelope");
    }

    #[test]
    fn gmail_keeps_the_bcc_header_because_it_carries_no_envelope() {
        // The mirror image: Gmail's `raw` field has no envelope, so dropping
        // the header here would mean the blind recipient never gets the mail.
        // Gmail strips the header itself before delivery.
        let bcc = vec!["blind@z.com".to_string()];
        let raw = rendered(
            &build_message(
                "from@example.com",
                "to@example.com",
                &[],
                &bcc,
                BccHeader::Keep,
                "Hi",
                "Body",
                &[],
            )
            .unwrap_or_else(|e| panic!("build failed: {e}")),
        );
        assert!(
            raw.contains("Bcc: blind@z.com"),
            "bcc header missing: {raw}"
        );
    }

    #[test]
    fn build_message_omits_bcc_when_empty() {
        let raw = rendered(
            &build_message(
                "from@example.com",
                "to@example.com",
                &[],
                &[],
                BccHeader::Keep,
                "Hi",
                "Body",
                &[],
            )
            .unwrap_or_else(|e| panic!("build failed: {e}")),
        );
        assert!(!raw.contains("Bcc:"));
    }

    #[test]
    fn build_message_rejects_no_recipients() {
        let err = build_message(
            "from@example.com",
            "  ,  ",
            &[],
            &[],
            BccHeader::Drop,
            "Hi",
            "Body",
            &[],
        );
        assert!(matches!(err, Err(MailError::NoRecipients)));
    }
}
