use crate::prelude::*;

use crate::cache::TtlCache;
use crate::email::attachments::save_email_attachments;
use crate::email::oauth::{HTTP_CLIENT, refresh_access_token, try_load_google_secrets};
use crate::email::utils::{extract_attachments, extract_body};
use actix_web::{HttpResponse, get};
use sqlx::PgPool;
use tracing::{error, info, instrument, warn};
use wayve_security::encryption::{decrypt, encrypt};
use wayve_security::jwt::get_user_id_from_request;

const EMAIL_BODY_CACHE_TTL_SECS: u64 = 300;
const EMAIL_BODY_CACHE_MAX_CAPACITY: u64 = 10_000;

static EMAIL_BODY_CACHE: Lazy<TtlCache<(i32, i32), String>> =
    Lazy::new(|| TtlCache::new(EMAIL_BODY_CACHE_MAX_CAPACITY, EMAIL_BODY_CACHE_TTL_SECS));

#[get("/emails/{id}")]
#[instrument(target = "http", skip(pool))]
pub async fn get_email_by_id(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    let email_id = path.into_inner();
    let cache_key = (user_id, email_id);

    let detail = match crate::email::repo::get_detail(pool.get_ref(), email_id, user_id).await? {
        Some(row) => row,
        None => return Ok(HttpResponse::NotFound().body("Email not found")),
    };

    // Skip AES-GCM + HKDF on repeat opens. Plaintext lives only in this
    // process-local moka LRU (capacity-bounded, 5min TTL); it never touches
    // disk. On miss we decrypt once and write back, matching what
    // `get_email_body` already does for the body-only endpoint.
    let body = if let Some(cached) = EMAIL_BODY_CACHE.get(&cache_key).await {
        cached
    } else if detail.body_encrypted.is_empty() || detail.body_iv.is_empty() {
        String::new()
    } else {
        match wayve_security::encryption::decrypt(&detail.body_iv, &detail.body_encrypted) {
            Ok(text) => {
                if detail.attachments_checked && !text.is_empty() {
                    EMAIL_BODY_CACHE.insert(cache_key, text.clone()).await;
                }
                text
            }
            Err(e) => {
                warn!(
                    target: "gmail",
                    email_id,
                    error = %e,
                    "email body decrypt failed; returning empty body so client can refetch"
                );
                String::new()
            }
        }
    };

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": detail.id,
        "account_id": detail.account_id,
        "subject": detail.subject.unwrap_or_default(),
        "sender": detail.sender.unwrap_or_default(),
        "receiver": detail.receiver.unwrap_or_default(),
        "body": body,
        "attachments_checked": detail.attachments_checked,
    })))
}

#[get("/emails/{id}/body")]
#[instrument(target = "gmail", skip(req, path, pool))]
pub async fn get_email_body(
    req: HttpRequest,
    path: web::Path<i32>,
    pool: web::Data<PgPool>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => return Ok(HttpResponse::Unauthorized().finish()),
    };

    let email_id = path.into_inner();
    let cache_key = (user_id, email_id);

    if let Some(body) = EMAIL_BODY_CACHE.get(&cache_key).await {
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "body": body })));
    }

    // Owner or shared-inbox member may fetch the body. LEFT JOIN so
    // account-less Wayve-native rows (e.g. the Sent copy of a Wayve-to-Wayve
    // message, which has NULL account_id) still match — authorized via the
    // `source='wayve' AND recipient_user_id` clause, mirroring repo::get_detail.
    let row = crate::db::with_rls_user_tx(pool.get_ref(), user_id, |mut tx| async move {
        let row = sqlx::query(
            r#"
        SELECT e.id, e.gmail_id, e.source, e.account_id,
               e.body_encrypted, e.body_iv, e.attachments_checked,
               a.refresh_token
        FROM emails e
        LEFT JOIN email_accounts a ON e.account_id = a.id
        LEFT JOIN shared_inbox_members m
               ON m.account_id = a.id AND m.user_id = $2
        WHERE e.id = $1
          AND (a.user_id = $2
               OR m.user_id IS NOT NULL
               OR (e.source = 'wayve' AND e.recipient_user_id = $2))
        "#,
        )
        .bind(email_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        Ok((tx, row))
    })
    .await?;

    let row = match row {
        Some(r) => r,
        None => return Ok(HttpResponse::NotFound().finish()),
    };

    let body_encrypted: String = row.get("body_encrypted");
    let body_iv: String = row.get("body_iv");
    let attachments_checked: Option<bool> = row.get("attachments_checked");

    // Account-less / Wayve-native messages have no Gmail account to refetch
    // from — their body is authored locally and stored at send time. Serve it
    // straight from storage instead of falling through to the Gmail refresh
    // path, which would 404 on the missing account / synthetic gmail_id.
    let source: Option<String> = row.try_get("source").ok().flatten();
    let account_id_opt: Option<i32> = row.try_get("account_id").ok().flatten();
    if account_id_opt.is_none() || source.as_deref() == Some("wayve") {
        // Wayve-native rows store the raw client envelope (WAYVE_SECURE_V1…)
        // with NO backend-AES layer, so body_iv is empty — return it verbatim
        // for the browser to decrypt. Only apply the storage-at-rest decrypt
        // when an iv is actually present.
        let body = if body_encrypted.is_empty() {
            String::new()
        } else if body_iv.is_empty() {
            body_encrypted.clone()
        } else {
            decrypt(&body_iv, &body_encrypted).unwrap_or_default()
        };
        if !body.is_empty() {
            EMAIL_BODY_CACHE.insert(cache_key, body.clone()).await;
        }
        return Ok(HttpResponse::Ok().json(serde_json::json!({ "body": body })));
    }

    // If a decryptable body is already stored, hold onto it as a fallback so a
    // failed live Gmail refetch (e.g. an OAuth refresh token invalidated by a
    // client rotation) still serves the body instead of a hard 502.
    let mut stored_body: Option<String> = None;
    if !body_encrypted.is_empty() && !body_iv.is_empty() {
        match decrypt(&body_iv, &body_encrypted) {
            Ok(body) => {
                if attachments_checked.unwrap_or(false) {
                    EMAIL_BODY_CACHE.insert(cache_key, body.clone()).await;
                    return Ok(HttpResponse::Ok().json(serde_json::json!({ "body": body })));
                }

                info!(
                    target: "gmail",
                    email_id,
                    "cached email body has no attachment metadata; refreshing Gmail payload"
                );
                stored_body = Some(body);
            }
            Err(e) => {
                warn!(
                    target: "gmail",
                    email_id,
                    error = %e,
                    "cached email body decrypt failed; refetching from Gmail"
                );
            }
        }
    }

    let gmail_id: Option<String> = row.get("gmail_id");
    let account_id: i32 = row.get("account_id");
    let refresh_token: Option<String> = row.get("refresh_token");

    let gmail_id = match gmail_id.filter(|value| !value.trim().is_empty()) {
        Some(value) => value,
        None => {
            error!(target: "gmail", email_id, "email body request missing gmail_id");
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "error": "Email is missing its Gmail message id. Re-sync this account."
            })));
        }
    };

    let refresh_token = match refresh_token.filter(|value| !value.trim().is_empty()) {
        Some(value) => value,
        None => {
            error!(target: "gmail", account_id, "email account missing refresh_token");
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "error": "This Gmail account needs to be reconnected before Fluxze can load message bodies."
            })));
        }
    };

    let secrets = match try_load_google_secrets() {
        Ok(secrets) => secrets,
        Err(e) => {
            error!(target: "gmail", error = %e, "google secrets unavailable for body fetch");
            return Ok(HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Google OAuth client secret is not configured"
            })));
        }
    };

    let client_id = match secrets["web"]["client_id"].as_str() {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            error!(target: "gmail", "google client_id missing for body fetch");
            return Ok(HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Google OAuth client id is not configured"
            })));
        }
    };

    let client_secret = match secrets["web"]["client_secret"].as_str() {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => {
            error!(target: "gmail", "google client_secret missing for body fetch");
            return Ok(HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Google OAuth client secret is not configured"
            })));
        }
    };

    let token = match refresh_access_token(&client_id, &client_secret, &refresh_token).await {
        Ok(t) => t,
        Err(e) => {
            error!(target: "gmail", account_id, error = ?e, "refresh_access_token failed");
            // The live refresh only adds fresh attachment metadata — if we
            // already have the body stored, serve it rather than failing.
            if let Some(body) = stored_body.as_ref() {
                EMAIL_BODY_CACHE.insert(cache_key, body.clone()).await;
                return Ok(HttpResponse::Ok().json(serde_json::json!({ "body": body })));
            }
            // No stored body and the token is dead — the account must be
            // reconnected (its refresh token was issued by a rotated client).
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "error": "This Gmail account needs to be reconnected to load this message."
            })));
        }
    };

    let _ = sqlx::query("UPDATE email_accounts SET access_token = $1 WHERE id = $2")
        .bind(&token)
        .bind(account_id)
        .execute(pool.get_ref())
        .await;

    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=full",
        gmail_id
    );

    let res: Value = match HTTP_CLIENT.get(&url).bearer_auth(&token).send().await {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                error!(target: "gmail", email_id, error = %e, "gmail body json parse failed");
                if let Some(body) = stored_body.as_ref() {
                    EMAIL_BODY_CACHE.insert(cache_key, body.clone()).await;
                    return Ok(HttpResponse::Ok().json(serde_json::json!({ "body": body })));
                }
                return Ok(HttpResponse::BadGateway().finish());
            }
        },
        Err(e) => {
            error!(target: "gmail", email_id, error = %e, "gmail body request failed");
            if let Some(body) = stored_body.as_ref() {
                EMAIL_BODY_CACHE.insert(cache_key, body.clone()).await;
                return Ok(HttpResponse::Ok().json(serde_json::json!({ "body": body })));
            }
            return Ok(HttpResponse::BadGateway().finish());
        }
    };

    let body = extract_body(&res["payload"])
        .unwrap_or_else(|| res["snippet"].as_str().unwrap_or("").to_string());
    let attachments = extract_attachments(&res["payload"]);

    match encrypt(&body) {
        Ok((iv, encrypted)) => {
            if let Err(e) =
                sqlx::query(
                    "UPDATE emails SET body_encrypted = $1, body_iv = $2, attachments_checked = true WHERE id = $3",
                )
                    .bind(&encrypted)
                    .bind(&iv)
                    .bind(email_id)
                    .execute(pool.get_ref())
                    .await
            {
                error!(target: "db", email_id, error = ?e, "persisting email body failed");
            }
        }
        Err(e) => {
            error!(target: "gmail", email_id, error = %e, "email body encrypt failed");
            return Ok(HttpResponse::InternalServerError().json(serde_json::json!({
                "error": format!("Failed to secure email body: {}", e)
            })));
        }
    }

    save_email_attachments(
        pool.get_ref(),
        email_id,
        account_id,
        &gmail_id,
        &attachments,
    )
    .await;

    EMAIL_BODY_CACHE.insert(cache_key, body.clone()).await;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "body": body })))
}
