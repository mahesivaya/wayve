use crate::prelude::*;

use crate::email::account::load_email_account_for_user;
use crate::email::oauth::HTTP_CLIENT;
use crate::email::outlook::send_outlook_mail;
use crate::email::provider::refresh_and_persist_email_token;
use crate::models::email_request::SendEmailRequest;
use crate::security::jwt::get_user_id_from_request;
use actix_web::HttpResponse;
use base64::Engine;
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};

#[post("/send")]
#[instrument(target = "gmail", skip(req, data, pool), fields(to = %data.to))]
pub async fn send(
    req: HttpRequest,
    data: web::Json<SendEmailRequest>,
    pool: web::Data<PgPool>,
) -> AppResult {
    if data.to.trim().is_empty() || data.subject.trim().is_empty() {
        return Ok(HttpResponse::BadRequest().body("Recipient and Subject are required"));
    }

    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().body("Invalid token")),
    };

    info!(target: "gmail", user_id, account_id = data.account_id, "send email request");

    let account =
        match load_email_account_for_user(pool.get_ref(), data.account_id, user_id).await? {
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

    Ok(account
        .provider
        .send(
            &token.access_token,
            &account.email,
            account.id,
            &data,
            user_id,
        )
        .await)
}

pub(super) async fn send_via_gmail(
    access_token: &str,
    from_email: &str,
    data: &SendEmailRequest,
    user_id: i32,
) -> HttpResponse {
    let raw_email = format!(
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
    );

    let encoded = base64::engine::general_purpose::URL_SAFE.encode(raw_email.as_bytes());

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
    match send_outlook_mail(
        access_token,
        data.to.trim(),
        data.subject.trim(),
        &data.body,
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
