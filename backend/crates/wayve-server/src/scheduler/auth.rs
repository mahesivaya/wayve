use actix_web::{HttpRequest, HttpResponse};

use wayve_security::jwt::{decode_jwt, token_from_request};

pub fn get_user_id(req: &HttpRequest) -> Result<i32, HttpResponse> {
    // The JWT may arrive in the Authorization header or the auth cookie: a
    // cookie-only session, such as one from an OAuth login, has no Bearer header.
    let token = token_from_request(req)
        .ok_or_else(|| HttpResponse::Unauthorized().body("Missing token"))?;

    let decoded =
        decode_jwt(&token).ok_or_else(|| HttpResponse::Unauthorized().body("Invalid token"))?;

    Ok(decoded.sub)
}
