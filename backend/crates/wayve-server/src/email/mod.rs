pub mod account;
pub mod attachments;
mod body_handlers;
pub mod body_worker;
pub mod handler;
pub mod oauth;
mod oauth_flow;
pub mod outlook;
mod outlook_oauth;
pub mod profile;
pub mod provider;
mod provider_lookup;
mod send;
pub mod sender;
pub mod shared_inbox;
pub mod sync;
pub mod sync_older;
pub mod utils;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(crate::routes::email::get_emails)
        .service(crate::routes::email::delete_email)
        .service(crate::routes::email::mark_email_read)
        .service(crate::routes::email::get_all_email_attachments)
        .service(crate::routes::email::get_email_attachments)
        .service(crate::routes::email::download_email_attachment)
        .service(handler::get_email_body)
        .service(handler::get_email_by_id)
        .service(handler::send)
        .service(handler::gmail_connect_url)
        .service(outlook_oauth::outlook_connect_url)
        .service(provider_lookup::provider_lookup)
        .service(handler::get_me)
        .service(handler::save_public_key);
}

pub fn public_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/gmail/login", web::get().to(handler::gmail_login))
        .route("/oauth/callback", web::get().to(handler::oauth_callback))
        .route(
            "/outlook/login",
            web::get().to(outlook_oauth::outlook_login),
        )
        .route(
            "/oauth/outlook/callback",
            web::get().to(outlook_oauth::outlook_callback),
        );
}
