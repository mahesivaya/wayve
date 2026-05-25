use crate::prelude::*;
use wayve_security::jwt::get_user_id_from_request;

use super::dto::{UpdateChannelSubjectInput, UpdateChannelVisibilityInput};
use super::helpers::is_channel_admin;

use actix_web::patch;
use tracing::instrument;

#[patch("/chat/channels/{channel_id}")]
#[instrument(target = "http", skip(req, pool, input), fields(channel_id))]
pub async fn update_channel_subject(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
    input: web::Json<UpdateChannelSubjectInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    if !is_channel_admin(pool.get_ref(), channel_id, user_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can change the subject"
        })));
    }

    let name = input.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Channel subject is required"
        })));
    }

    sqlx::query("UPDATE channels SET name = $1 WHERE id = $2")
        .bind(name)
        .bind(channel_id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "name": name })))
}

#[patch("/chat/channels/{channel_id}/visibility")]
#[instrument(target = "http", skip(req, pool, input), fields(channel_id))]
pub async fn update_channel_visibility(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    channel_id: web::Path<i32>,
    input: web::Json<UpdateChannelVisibilityInput>,
) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let channel_id = channel_id.into_inner();

    if !is_channel_admin(pool.get_ref(), channel_id, user_id).await? {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Only channel admins can change visibility"
        })));
    }

    let visibility = match input.visibility.as_str() {
        "public" => "public",
        _ => "private",
    };

    sqlx::query("UPDATE channels SET visibility = $1 WHERE id = $2")
        .bind(visibility)
        .bind(channel_id)
        .execute(pool.get_ref())
        .await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({ "visibility": visibility })))
}
