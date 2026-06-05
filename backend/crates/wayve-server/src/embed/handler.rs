// POST /api/embed/tokens — mint a short-lived, origin-pinned, read-only
// token for embedding Wayve's UI inside a customer's own iframe.

use super::tokens::{ALLOWED_SCOPES, EMBED_TTL_SECONDS, MintError, mint};
use crate::prelude::*;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(mint_token).service(list_allowed_scopes);
}

#[derive(Deserialize)]
pub struct MintTokenInput {
    pub origin: String,
    pub scopes: Vec<String>,
}

#[post("/embed/tokens")]
#[instrument(target = "http", skip(req, data))]
pub async fn mint_token(req: HttpRequest, data: web::Json<MintTokenInput>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;
    let token = mint(user_id, &data.origin, &data.scopes).map_err(|e| match e {
        MintError::EmptyScopes | MintError::EmptyOrigin => AppError::BadRequest(e.to_string()),
        MintError::UnknownScope(_) => AppError::BadRequest(e.to_string()),
    })?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "token": token,
        "expires_in": EMBED_TTL_SECONDS,
        "issuer": "wayve-embed",
        "origin": data.origin,
        "scopes": data.scopes,
    })))
}

#[get("/embed/scopes")]
pub async fn list_allowed_scopes() -> AppResult {
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "scopes": ALLOWED_SCOPES,
        "ttl_seconds": EMBED_TTL_SECONDS,
        "issuer": "wayve-embed",
        "header": "X-EMBED-TOKEN",
        "method_restriction": "GET/HEAD only",
    })))
}
