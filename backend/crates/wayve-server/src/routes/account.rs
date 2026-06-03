use crate::email::account::{
    invalidate_email_account_cache, invalidate_user_account_list_cache,
    load_account_summaries_for_user,
};
use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;
use actix_web::{delete, put};
use serde::Deserialize;
use tracing::{info, instrument};

#[get("/accounts")]
#[instrument(target = "http", skip(req, pool))]
pub(crate) async fn get_accounts(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let rows = load_account_summaries_for_user(pool.get_ref(), user_id).await?;

    Ok(HttpResponse::Ok().json(rows))
}

#[derive(Deserialize)]
pub struct UpdateAccountNameBody {
    display_name: Option<String>,
}

#[put("/accounts/{id}/display-name")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn update_account_display_name(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    body: web::Json<UpdateAccountNameBody>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let id = path.into_inner();
    let display_name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let result = sqlx::query(
        r#"
        UPDATE email_accounts
        SET display_name = $1
        WHERE id = $2 AND user_id = $3
        "#,
    )
    .bind(display_name)
    .bind(id)
    .bind(user_id)
    .execute(pool.get_ref())
    .await?;

    if result.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound().json(serde_json::json!({
            "error": "Email account not found"
        })));
    }

    invalidate_user_account_list_cache(user_id).await;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "updated": true })))
}

#[delete("/accounts/{id}")]
#[instrument(target = "http", skip(req, pool))]
pub async fn delete_account(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let id = path.into_inner();

    let result = sqlx::query("DELETE FROM email_accounts WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool.get_ref())
        .await?;

    if result.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound().finish());
    }

    invalidate_email_account_cache(id).await;
    invalidate_user_account_list_cache(user_id).await;
    info!("Email account deleted: id={} user_id={}", id, user_id);
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "email_account_delete",
            resource_type: "email_account",
            resource_id: Some(id.to_string()),
            metadata: None,
        },
    )
    .await;
    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}
