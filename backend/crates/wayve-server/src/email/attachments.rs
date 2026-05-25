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
