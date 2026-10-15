use crate::email::utils::AttachmentMeta;
use sqlx::PgPool;
use tracing::error;

pub async fn save_email_attachments(
    pool: &PgPool,
    email_id: i32,
    account_id: i32,
    gmail_id: &str,
    attachments: &[AttachmentMeta],
) {
    for attachment in attachments {
        if attachment.filename.trim().is_empty() || attachment.attachment_id.trim().is_empty() {
            continue;
        }

        if let Err(e) = sqlx::query(
            r#"
            INSERT INTO email_attachments
                (email_id, account_id, gmail_id, attachment_id, filename, mime_type, size)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (email_id, attachment_id)
            DO UPDATE SET
                filename = EXCLUDED.filename,
                mime_type = EXCLUDED.mime_type,
                size = EXCLUDED.size
            "#,
        )
        .bind(email_id)
        .bind(account_id)
        .bind(gmail_id)
        .bind(&attachment.attachment_id)
        .bind(&attachment.filename)
        .bind(&attachment.mime_type)
        .bind(attachment.size)
        .execute(pool)
        .await
        {
            error!(
                target: "gmail",
                email_id,
                attachment_id = %attachment.attachment_id,
                error = ?e,
                "saving email attachment failed"
            );
        }
    }
}

/// A stored attachment's file, fetched from its mail provider.
pub struct AttachmentFile {
    pub filename: String,
    pub mime_type: Option<String>,
    pub bytes: Vec<u8>,
}

/// Why the attachments of a forward couldn't be fetched.
#[derive(Debug)]
pub enum ForwardAttachmentError {
    /// An id isn't an attachment in one of the caller's own mailboxes.
    NotFound,
    /// The mailbox holding one has no usable sign-in.
    Reconnect,
    /// The provider didn't hand the file over.
    Provider(anyhow::Error),
}

/// The files of the caller's stored attachments `ids`, in the order given, so a
/// forward can carry the original's attachments. Only attachments in mailboxes
/// the caller owns, as for a download. Any id that fails fails the whole set:
/// a forward never goes out silently missing a file.
pub async fn fetch_for_forward(
    pool: &PgPool,
    user_id: i32,
    ids: &[i32],
) -> Result<Vec<AttachmentFile>, ForwardAttachmentError> {
    use crate::email::provider::{MailProvider, refresh_and_persist_email_token};
    use sqlx::Row;
    use std::collections::HashMap;

    let rows = sqlx::query(
        "SELECT ea.id, ea.attachment_id, ea.gmail_id, ea.filename, ea.mime_type, \
                a.id AS account_id, a.refresh_token, a.provider \
         FROM email_attachments ea JOIN email_accounts a ON ea.account_id = a.id \
         WHERE ea.id = ANY($1) AND a.user_id = $2",
    )
    .bind(ids)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| ForwardAttachmentError::Provider(e.into()))?;
    let by_id: HashMap<i32, sqlx::postgres::PgRow> = rows
        .into_iter()
        .map(|r| (r.get::<i32, _>("id"), r))
        .collect();
    // Every id must be the caller's before any provider call is made.
    if ids.iter().any(|id| !by_id.contains_key(id)) {
        return Err(ForwardAttachmentError::NotFound);
    }

    let mut tokens: HashMap<i32, String> = HashMap::new();
    let mut files = Vec::with_capacity(ids.len());
    for id in ids {
        let row = by_id.get(id).ok_or(ForwardAttachmentError::NotFound)?;
        let account_id: i32 = row.get("account_id");
        let provider = MailProvider::from_db(&row.get::<String, _>("provider"));
        let token = match tokens.get(&account_id) {
            Some(token) => token.clone(),
            None => {
                let refresh_token: Option<String> = row.get("refresh_token");
                let refresh_token = refresh_token
                    .filter(|t| !t.trim().is_empty())
                    .ok_or(ForwardAttachmentError::Reconnect)?;
                let token =
                    refresh_and_persist_email_token(pool, account_id, provider, &refresh_token)
                        .await
                        .map_err(ForwardAttachmentError::Provider)?
                        .access_token;
                tokens.insert(account_id, token.clone());
                token
            }
        };
        let message_id: String = row.get("gmail_id");
        let attachment_id: String = row.get("attachment_id");
        let mut mime_type: Option<String> = row.get("mime_type");
        let bytes = if provider.is_microsoft() {
            let (content_type, bytes) = crate::email::outlook::fetch_outlook_attachment_bytes(
                &token,
                &message_id,
                &attachment_id,
            )
            .await
            .map_err(ForwardAttachmentError::Provider)?;
            mime_type = mime_type.or(content_type);
            bytes
        } else {
            fetch_gmail_attachment_bytes(&token, &message_id, &attachment_id)
                .await
                .map_err(ForwardAttachmentError::Provider)?
        };
        files.push(AttachmentFile {
            filename: row.get("filename"),
            mime_type,
            bytes,
        });
    }
    Ok(files)
}

/// One Gmail attachment's bytes (`messages.attachments.get`).
pub async fn fetch_gmail_attachment_bytes(
    token: &str,
    message_id: &str,
    attachment_id: &str,
) -> anyhow::Result<Vec<u8>> {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    let res: serde_json::Value = crate::email::oauth::HTTP_CLIENT
        .get(format!(
            "{}/gmail/v1/users/me/messages/{message_id}/attachments/{attachment_id}",
            crate::external::gmail_api_base()
        ))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let data = res["data"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("gmail attachment has no data"))?;
    URL_SAFE_NO_PAD
        .decode(data.trim_end_matches('='))
        .map_err(|e| anyhow::anyhow!("gmail attachment base64 decode failed: {e}"))
}
