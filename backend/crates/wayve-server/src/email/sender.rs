use lettre::message::header::ContentType;
use lettre::message::{Attachment, MultiPart, SinglePart};
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
