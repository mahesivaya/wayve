use crate::prelude::*;

#[derive(Debug, Deserialize)]
pub struct SendEmailRequest {
    pub account_id: i32,
    pub to: String,
    pub subject: String,
    pub body: String,
    /// Cc recipients. Honoured by the standard Gmail/Outlook/IMAP send paths, not
    /// the E2E secure send. Normalised (trimmed, de-duped against `to`) before use.
    #[serde(default)]
    pub cc: Vec<String>,
    /// Honoured only by the standard Gmail and Outlook path, not the E2E secure
    /// send.
    #[serde(default)]
    pub attachments: Vec<EmailAttachmentInput>,
}

/// One outgoing attachment from the browser, with the file bytes standard-base64
/// encoded in `content_base64`.
#[derive(Debug, Deserialize)]
pub struct EmailAttachmentInput {
    pub filename: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    pub content_base64: String,
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct UserResponse {
    pub id: i32,
    pub email: String,
    pub public_key: Option<String>,
}
