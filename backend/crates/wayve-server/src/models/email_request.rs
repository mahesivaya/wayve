use crate::prelude::*;

#[derive(Debug, Deserialize)]
pub struct SendEmailRequest {
    pub account_id: i32,
    pub to: String,
    pub subject: String,
    pub body: String,
    /// Standard-mailbox attachments (base64). Empty for a plain text send;
    /// only the standard Gmail/Outlook path honours these (not E2E/secure).
    #[serde(default)]
    pub attachments: Vec<EmailAttachmentInput>,
}

/// One outgoing attachment as it arrives from the browser: the file bytes are
/// standard-base64 encoded in `content_base64`.
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
