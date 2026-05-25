use actix_web::{HttpRequest, HttpResponse};

use wayve_security::jwt::{decode_jwt, token_from_request};

pub fn get_user_id(req: &HttpRequest) -> Result<i32, HttpResponse> {
    // Accept the JWT from the Authorization header OR the auth cookie — the
    // rest of the app authenticates via `token_from_request`, and a
    // cookie-only session (e.g. after an OAuth login) has no Bearer header.
    let token = token_from_request(req)
        .ok_or_else(|| HttpResponse::Unauthorized().body("Missing token"))?;

    let decoded =
        decode_jwt(&token).ok_or_else(|| HttpResponse::Unauthorized().body("Invalid token"))?;

    Ok(decoded.sub)
}
