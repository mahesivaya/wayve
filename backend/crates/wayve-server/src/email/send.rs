use crate::prelude::*;

use crate::email::account::load_email_account_for_send;
use crate::email::oauth::HTTP_CLIENT;
use crate::email::outlook::send_outlook_mail;
use crate::email::provider::refresh_and_persist_email_token;
use crate::models::email_request::{EmailAttachmentInput, SendEmailRequest};
use actix_web::HttpResponse;
use base64::Engine;
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;

/// Caps for standard-mailbox attachments (the E2E/secure paths stay text-only).
const MAX_OUTGOING_ATTACHMENTS: usize = 10;
const MAX_OUTGOING_ATTACHMENTS_BYTES: usize = 20 * 1024 * 1024;

/// Strip any path components a browser might send so a filename can't inject a
/// header or odd MIME name. Falls back to "attachment".
fn sanitize_attachment_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    if base.is_empty() {
        "attachment".to_string()
    } else {
        base.to_string()
    }
}

/// Cheap pre-flight cap check from the base64 lengths (no decode). Returns a
/// human-readable error when over the count or total-size limit.
fn validate_attachment_limits(attachments: &[EmailAttachmentInput]) -> Result<(), String> {
    if attachments.len() > MAX_OUTGOING_ATTACHMENTS {
        return Err(format!(
            "Too many attachments (max {MAX_OUTGOING_ATTACHMENTS})."
        ));
    }
    // base64 inflates ~4/3; estimate the decoded size without allocating.
    let estimated: usize = attachments
        .iter()
        .map(|a| a.content_base64.len() / 4 * 3)
        .sum();
    if estimated > MAX_OUTGOING_ATTACHMENTS_BYTES {
        return Err("Attachments exceed the 20 MB total limit.".to_string());
    }
    Ok(())
}

/// Decode the base64 attachments into bytes, sanitising names and defaulting the
/// MIME type. Returns a human-readable error on malformed base64.
fn decode_attachments(
    attachments: &[EmailAttachmentInput],
) -> Result<Vec<crate::email::sender::OutgoingAttachment>, String> {
    attachments
        .iter()
        .map(|a| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(a.content_base64.trim())
                .map_err(|_| {
                    format!(
                        "Attachment '{}' is not valid base64.",
                        sanitize_attachment_filename(&a.filename)
                    )
                })?;
            Ok(crate::email::sender::OutgoingAttachment {
                filename: sanitize_attachment_filename(&a.filename),
                mime_type: a
                    .mime_type
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
                bytes,
            })
        })
        .collect()
}

#[instrument(target = "gmail", skip(req, data, pool), fields(to = %data.to))]
pub async fn send(
    req: HttpRequest,
    data: web::Json<SendEmailRequest>,
    pool: web::Data<PgPool>,
) -> AppResult {
    if data.to.trim().is_empty() || data.subject.trim().is_empty() {
        return Ok(HttpResponse::BadRequest().body("Recipient and Subject are required"));
    }

    if let Err(message) = validate_attachment_limits(&data.attachments) {
        return Ok(HttpResponse::PayloadTooLarge().json(serde_json::json!({ "error": message })));
    }

    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().body("Invalid token")),
    };

    info!(target: "gmail", user_id, account_id = data.account_id, "send email request");

    // Owner OR shared-inbox member with can_reply may send. The loader
    // funnels both paths through the same return type so the rest of the
    // handler stays identical regardless of which permission applies.
    let account =
        match load_email_account_for_send(pool.get_ref(), data.account_id, user_id).await? {
            Some(account) => account,
            None => return Ok(HttpResponse::Unauthorized().body("Email account not found")),
        };

    let refresh_token = match account.usable_refresh_token() {
        Some(value) => value,
        None => {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "error": "Reconnect the email account to send email"
            })));
        }
    };

    // Dev-only shortcut: when the connected account holds a sentinel
    // `fake-*` refresh token (only ever inserted by seed scripts / manual
    // rows for UI testing), bypass the real provider and deliver via the
    // local SMTP trap (Mailpit) so the compose loop is closed end-to-end
    // without real OAuth. No production refresh token starts with `fake-`.
    if refresh_token.starts_with("fake-") {
        info!(
            target: "gmail",
            user_id,
            account_id = account.id,
            "send dev shortcut: routing through local SMTP (fake token detected)"
        );
        let to = data.to.trim();
        let subject = data.subject.trim();
        let send_result = if data.attachments.is_empty() {
            crate::email::sender::send_mail(to, subject, &data.body).await
        } else {
            match decode_attachments(&data.attachments) {
                Ok(decoded) => {
                    crate::email::sender::send_mail_with_attachments(
                        to, subject, &data.body, &decoded,
                    )
                    .await
                }
                Err(message) => {
                    return Ok(
                        HttpResponse::BadRequest().json(serde_json::json!({ "error": message }))
                    );
                }
            }
        };
        return Ok(match send_result {
            Ok(()) => HttpResponse::Ok().body("Email sent ✅ (dev → Mailpit)"),
            Err(e) => {
                error!(
                    target: "gmail",
                    user_id,
                    account_id = account.id,
                    error = ?e,
                    "dev SMTP shortcut send failed"
                );
                HttpResponse::InternalServerError()
                    .body("Failed to deliver dev mail via local SMTP")
            }
        });
    }

    let token = match refresh_and_persist_email_token(
        pool.get_ref(),
        account.id,
        account.provider,
        refresh_token,
    )
    .await
    {
        Ok(token) => token,
        Err(e) => {
            error!(target: "gmail", user_id, account_id = account.id, provider = account.provider.as_db(), error = ?e, "send token refresh failed");
            let provider_name = account.provider.display_name();
            if e.to_string().contains("not configured") {
                return Ok(HttpResponse::InternalServerError()
                    .body(format!("{provider_name} OAuth is not configured")));
            }
            return Ok(HttpResponse::BadGateway()
                .body(format!("Failed to refresh {provider_name} credentials")));
        }
    };

    let response = account
        .provider
        .send(
            &token.access_token,
            &account.email,
            account.id,
            &data,
            user_id,
        )
        .await;

    // email.sent fans out only on a 2xx from the upstream provider. If
    // Gmail/Graph rejected the send (4xx/5xx), the customer hasn't
    // delivered a message and shouldn't get the webhook.
    if response.status().is_success() {
        let owner = crate::webhooks::handler::owner_for_user(pool.get_ref(), user_id).await;
        crate::webhooks::emit(
            pool.get_ref(),
            owner,
            crate::webhooks::Event::EmailSent,
            serde_json::json!({
                "account_id": account.id,
                "from": account.email,
                "to": data.to,
                "subject": data.subject,
                "attachments": data.attachments.iter().map(|a| a.filename.as_str()).collect::<Vec<_>>(),
                "sent_at": chrono::Utc::now(),
            }),
        )
        .await;

        // Enterprise audit trail (Security → User actions), scoped by org like
        // every other action. from/to/subject land in metadata, which is
        // org/platform-admin readable by design.
        crate::audit::record_action(
            pool.get_ref(),
            &req,
            crate::audit::AuditEvent {
                actor_user_id: user_id,
                action: "email_sent",
                resource_type: "email",
                resource_id: Some(account.id.to_string()),
                metadata: Some(serde_json::json!({
                    "direction": "sent",
                    "from": account.email,
                    "to": data.to,
                    "subject": data.subject,
                    "attachments": data.attachments.iter().map(|a| a.filename.as_str()).collect::<Vec<_>>(),
                    "provider": account.provider.as_db(),
                    "account_id": account.id,
                    "sent_at": chrono::Utc::now(),
                })),
            },
        )
        .await;
    }

    Ok(response)
}

// ──────────────────────────────────────────────────────────────────────
// Plan A Phase 2 — Wayve-to-Wayve native channel
// ──────────────────────────────────────────────────────────────────────
//
// The browser builds a multi-recipient `WAYVE_SECURE_V1` envelope (one
// RSA-OAEP-wrapped AES key per recipient pubkey, plus one for the sender
// so they can decrypt their own Sent copy) and POSTs it here. This
// endpoint never invokes SMTP — it inserts one `emails` row per
// recipient (source='wayve', body_encrypted=envelope, no account_id) so
// the message lands in every recipient's inbox at the next list-emails
// fetch. Crucially the server stores ONLY the opaque envelope; it
// cannot decrypt the body at any point.
//
// Wire shape (subject is plaintext for inbox-preview UX, same trade-off
// Plan A Phase 1 made for inbound):
//
//   {
//     "recipient_user_ids": [int],
//     "envelope":            "WAYVE_SECURE_V1\n{ ... }",
//     "subject":             "Hello"
//   }

#[derive(serde::Deserialize)]
pub struct SendInternalInput {
    pub recipient_user_ids: Vec<i32>,
    pub envelope: String,
    pub subject: String,
}

const SEND_INTERNAL_MAX_RECIPIENTS: usize = 50;
const SEND_INTERNAL_MAX_ENVELOPE_BYTES: usize = 1_048_576; // 1 MiB
const SEND_INTERNAL_MAX_SUBJECT_BYTES: usize = 1024;
const WAYVE_ENVELOPE_PREFIX: &str = "WAYVE_SECURE_V1\n";

#[instrument(target = "gmail", skip(req, data, pool), fields(recipients = data.recipient_user_ids.len()))]
pub async fn send_internal(
    req: HttpRequest,
    data: web::Json<SendInternalInput>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().body("Invalid token")),
    };

    // Enterprise-tier senders use standard (server-readable) encryption: the
    // `envelope` field then carries plaintext rather than a WAYVE_SECURE_V1
    // E2E envelope, and we protect it with the server-AES at-rest layer below.
    let uses_standard =
        crate::encryption_policy::uses_standard_encryption(pool.get_ref(), user_id).await;

    // ─── Validate the payload ──────────────────────────────────────
    if data.recipient_user_ids.is_empty() {
        return Ok(HttpResponse::BadRequest().body("recipient_user_ids must not be empty"));
    }
    if data.recipient_user_ids.len() > SEND_INTERNAL_MAX_RECIPIENTS {
        return Ok(HttpResponse::BadRequest().body(format!(
            "Too many recipients (max {})",
            SEND_INTERNAL_MAX_RECIPIENTS
        )));
    }
    // E2E senders MUST supply a WAYVE_SECURE_V1 envelope; enterprise (standard
    // encryption) senders instead pass the plaintext body in this field.
    if !uses_standard && !data.envelope.starts_with(WAYVE_ENVELOPE_PREFIX) {
        return Ok(HttpResponse::BadRequest().body("envelope must be a WAYVE_SECURE_V1 payload"));
    }
    if data.envelope.len() > SEND_INTERNAL_MAX_ENVELOPE_BYTES {
        return Ok(HttpResponse::BadRequest().body("envelope too large"));
    }
    if data.subject.len() > SEND_INTERNAL_MAX_SUBJECT_BYTES {
        return Ok(HttpResponse::BadRequest().body("subject too long"));
    }

    // ─── Look up sender + recipient emails for the row metadata ────
    let sender_email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?
        .flatten();
    let sender_email = match sender_email {
        Some(addr) => addr,
        None => return Ok(HttpResponse::Unauthorized().body("Sender account not found")),
    };

    // Verify every requested recipient exists. A missing recipient is a
    // 400 (probably a stale browser cache) rather than a silent skip.
    let recipient_rows: Vec<(i32, String)> =
        sqlx::query_as::<_, (i32, String)>("SELECT id, email FROM users WHERE id = ANY($1)")
            .bind(&data.recipient_user_ids)
            .fetch_all(pool.get_ref())
            .await?;
    if recipient_rows.len() != data.recipient_user_ids.len() {
        return Ok(HttpResponse::BadRequest()
            .body("One or more recipient_user_ids do not resolve to a known user"));
    }

    // ─── Insert N+1 rows: one per recipient + sender's Sent copy ───
    //
    // Synthetic gmail_id namespaces wayve-internal rows so they never
    // collide with a real Gmail message id (which is a hex string). The
    // pattern is `wayve:<sender>:<unix-ms>:<recipient or 'sent'>` so a
    // single send produces a unique id per row even under high
    // concurrency from the same sender.
    let now_ms = chrono::Utc::now().timestamp_millis();
    let envelope = data.envelope.as_str();
    let subject = data.subject.as_str();

    // What actually lands in (body_encrypted, body_iv):
    //   • E2E sender      → the opaque WAYVE_SECURE_V1 envelope verbatim, no iv.
    //   • enterprise      → server-AES ciphertext of the plaintext + its iv, so
    //                        the row is server-readable (same shape inbound
    //                        server-AES rows use, which the frontend already
    //                        renders via the API's decrypted body).
    let (body_stored, iv_stored) = if uses_standard {
        match wayve_security::encryption::encrypt(envelope) {
            Ok((iv, ciphertext)) => (ciphertext, iv),
            Err(e) => {
                error!(target: "gmail", user_id, error = ?e, "internal email encrypt failed");
                return Ok(HttpResponse::InternalServerError().body("Failed to store message"));
            }
        }
    } else {
        (envelope.to_string(), String::new())
    };

    // Use a single transaction so a partial failure rolls back the whole
    // delivery — either every recipient gets the message or nobody does.
    let mut tx = pool.begin().await?;

    for (recipient_user_id, recipient_email) in &recipient_rows {
        let gmail_id = format!("wayve:{user_id}:{now_ms}:rcpt:{recipient_user_id}");
        sqlx::query(
            r#"
            INSERT INTO emails
                (gmail_id, account_id, subject, sender, receiver, body_encrypted,
                 body_iv, is_read, labels, source, recipient_user_id)
            VALUES ($1, NULL, $2, $3, $4, $5, $7, FALSE,
                    ARRAY['INBOX']::text[], 'wayve', $6)
            "#,
        )
        .bind(&gmail_id)
        .bind(subject)
        .bind(&sender_email)
        .bind(recipient_email)
        .bind(&body_stored)
        .bind(recipient_user_id)
        .bind(&iv_stored)
        .execute(&mut *tx)
        .await?;
    }

    // Sender's Sent copy. Same envelope (the sender's wrapped key is
    // inside, the browser wraps the AES key for the sender too) so they
    // can decrypt and re-read their own message later.
    let sent_gmail_id = format!("wayve:{user_id}:{now_ms}:sent");
    let recipient_list_for_to: String = recipient_rows
        .iter()
        .map(|(_, email)| email.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    sqlx::query(
        r#"
        INSERT INTO emails
            (gmail_id, account_id, subject, sender, receiver, body_encrypted,
             body_iv, is_read, labels, source, recipient_user_id)
        VALUES ($1, NULL, $2, $3, $4, $5, $7, TRUE,
                ARRAY['SENT']::text[], 'wayve', $6)
        "#,
    )
    .bind(&sent_gmail_id)
    .bind(subject)
    .bind(&sender_email)
    .bind(&recipient_list_for_to)
    .bind(&body_stored)
    .bind(user_id)
    .bind(&iv_stored)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    info!(
        target: "gmail",
        user_id,
        recipients = recipient_rows.len(),
        "Wayve-to-Wayve internal email delivered"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "delivered": recipient_rows.len(),
        "sent_id": sent_gmail_id,
    })))
}

pub(super) async fn send_via_gmail(
    access_token: &str,
    from_email: &str,
    data: &SendEmailRequest,
    user_id: i32,
) -> HttpResponse {
    let raw_bytes: Vec<u8> = if data.attachments.is_empty() {
        // Unchanged single-part path — byte-identical to the prior behaviour.
        format!(
            "From: {}\r\n\
        To: {}\r\n\
        Subject: {}\r\n\
        MIME-Version: 1.0\r\n\
        Content-Type: text/plain; charset=\"UTF-8\"\r\n\
        Content-Transfer-Encoding: 7bit\r\n\
        \r\n\
        {}",
            from_email.trim(),
            data.to.trim(),
            data.subject.trim(),
            data.body.replace("\n", "\r\n")
        )
        .into_bytes()
    } else {
        // Build a correct multipart/mixed message with lettre, then serialise it
        // to RFC 822 bytes for Gmail's `raw` field.
        let decoded = match decode_attachments(&data.attachments) {
            Ok(decoded) => decoded,
            Err(message) => {
                return HttpResponse::BadRequest().json(serde_json::json!({ "error": message }));
            }
        };
        match crate::email::sender::build_message(
            from_email.trim(),
            data.to.trim(),
            data.subject.trim(),
            &data.body,
            &decoded,
        ) {
            Ok(message) => message.formatted(),
            Err(e) => {
                warn!("could not build outgoing email with attachments: {e}");
                return HttpResponse::BadRequest()
                    .json(serde_json::json!({ "error": format!("Could not build email: {e}") }));
            }
        }
    };

    let encoded = base64::engine::general_purpose::URL_SAFE.encode(&raw_bytes);

    let res = HTTP_CLIENT
        .post(crate::external::gmail_send_url())
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "raw": encoded }))
        .send()
        .await;

    match res {
        Ok(resp) => {
            let status = resp.status();
            let response_text = resp.text().await.unwrap_or_default();

            if status.is_success() {
                info!("Email sent to {} (user_id={})", data.to, user_id);
                HttpResponse::Ok().body("Email sent ✅")
            } else {
                warn!(
                    "Gmail rejected send to {} (status={}, body={})",
                    data.to, status, response_text
                );
                HttpResponse::InternalServerError()
                    .body(format!("Gmail rejected request: {}", response_text))
            }
        }
        Err(e) => {
            error!("Failed to connect to Gmail API: {}", e);
            HttpResponse::InternalServerError().body("Failed to reach Gmail")
        }
    }
}

/// Sends from a connected Outlook mailbox through Graph `sendMail`.
pub(super) async fn send_via_outlook(
    access_token: &str,
    account_id: i32,
    data: &SendEmailRequest,
) -> HttpResponse {
    let attachments = match decode_attachments(&data.attachments) {
        Ok(decoded) => decoded,
        Err(message) => {
            return HttpResponse::BadRequest().json(serde_json::json!({ "error": message }));
        }
    };
    match send_outlook_mail(
        access_token,
        data.to.trim(),
        data.subject.trim(),
        &data.body,
        &attachments,
    )
    .await
    {
        Ok(()) => {
            info!(target: "gmail", account_id, "outlook email sent");
            HttpResponse::Ok().body("Email sent ✅")
        }
        Err(e) => {
            error!(target: "gmail", account_id, error = ?e, "outlook send failed");
            HttpResponse::InternalServerError().body("Failed to send via Outlook")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(content_base64: &str) -> EmailAttachmentInput {
        EmailAttachmentInput {
            filename: "f.txt".to_string(),
            mime_type: None,
            content_base64: content_base64.to_string(),
        }
    }

    #[test]
    fn sanitize_strips_path_and_defaults() {
        assert_eq!(sanitize_attachment_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_attachment_filename("a\\b\\c.png"), "c.png");
        assert_eq!(sanitize_attachment_filename("   "), "attachment");
    }

    #[test]
    fn limits_reject_too_many() {
        let many: Vec<_> = (0..=MAX_OUTGOING_ATTACHMENTS)
            .map(|_| att("AAAA"))
            .collect();
        assert!(validate_attachment_limits(&many).is_err());
    }

    #[test]
    fn limits_reject_oversize() {
        // base64 length whose ~3/4 estimate exceeds the 20 MB cap.
        let big = "A".repeat(MAX_OUTGOING_ATTACHMENTS_BYTES / 3 * 4 + 8);
        assert!(validate_attachment_limits(&[att(&big)]).is_err());
    }

    #[test]
    fn limits_accept_small_and_empty() {
        assert!(validate_attachment_limits(&[att("aGVsbG8=")]).is_ok());
        assert!(validate_attachment_limits(&[]).is_ok());
    }

    #[test]
    fn decode_rejects_bad_base64() {
        assert!(decode_attachments(&[att("not!base64!!")]).is_err());
    }

    #[test]
    fn decode_ok_defaults_mime() {
        let decoded = decode_attachments(&[att("aGVsbG8=")]).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].bytes, b"hello");
        assert_eq!(decoded[0].mime_type, "application/octet-stream");
    }
}
