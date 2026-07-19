pub mod account;
pub mod attachments;
mod body_handlers;
pub mod body_worker;
pub mod gmail_push;
pub mod handler;
pub mod imap;
mod imap_routes;
pub mod oauth;
mod oauth_flow;
pub mod outlook;
mod outlook_oauth;
pub mod profile;
pub mod provider;
pub(crate) mod provider_lookup;
mod rehydrate;
pub mod repo;
pub mod secure;
mod send;
pub mod sender;
pub mod shared_inbox;
pub mod sync;
pub mod sync_older;
pub mod utils;
mod wake;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(crate::routes::email::get_emails)
        .service(crate::routes::email::get_unread_count)
        .service(crate::routes::email::delete_email)
        .service(crate::routes::email::mark_email_read)
        .service(crate::routes::email::mark_email_unread)
        .service(crate::routes::email::mark_email_noise)
        .service(crate::routes::email::get_all_email_attachments)
        .service(crate::routes::email::get_email_attachments)
        .service(crate::routes::email::download_email_attachment)
        .service(handler::get_email_body)
        .service(handler::get_email_by_id)
        // The raised JSON limit allows base64 attachments (the `web::Json`
        // default is 2 MB); the handler enforces the real 20 MB total cap.
        .service(
            web::resource("/emails")
                .app_data(web::JsonConfig::default().limit(28 * 1024 * 1024))
                .route(web::post().to(handler::send)),
        )
        .service(
            web::resource("/send")
                .app_data(web::JsonConfig::default().limit(28 * 1024 * 1024))
                .route(web::post().to(handler::send)),
        )
        // Each canonical route below keeps a legacy alias for compatibility.
        .route("/emails/internal", web::post().to(handler::send_internal))
        .route(
            "/email/send-internal",
            web::post().to(handler::send_internal),
        )
        .route("/emails/secure", web::post().to(secure::send_secure))
        .route("/email/send-secure", web::post().to(secure::send_secure))
        // Secure message fetch is public: the token is the bearer credential.
        .route(
            "/secure-messages/{token}",
            web::get().to(secure::get_secure_message),
        )
        .route(
            "/emails/secure/{token}",
            web::delete().to(secure::revoke_secure_message),
        )
        .route(
            "/email/send-secure/{token}",
            web::delete().to(secure::revoke_secure_message),
        )
        .route(
            "/email-providers/gmail/connect",
            web::post().to(handler::gmail_connect_url),
        )
        .route(
            "/gmail/connect-url",
            web::post().to(handler::gmail_connect_url),
        )
        .route(
            "/email-providers/outlook/connect",
            web::post().to(outlook_oauth::outlook_connect_url),
        )
        .route(
            "/outlook/connect-url",
            web::post().to(outlook_oauth::outlook_connect_url),
        )
        .route(
            "/email-providers/imap/autodiscover",
            web::post().to(imap_routes::imap_autodiscover),
        )
        .route(
            "/email-providers/imap/test-login",
            web::post().to(imap_routes::imap_test_login),
        )
        .route(
            "/email-providers/imap/connect",
            web::post().to(imap_routes::imap_connect),
        )
        .route(
            "/email-providers/lookup",
            web::post().to(provider_lookup::provider_lookup),
        )
        .route(
            "/email/provider-lookup",
            web::post().to(provider_lookup::provider_lookup),
        )
        .service(handler::get_me)
        .service(handler::put_theme)
        .service(handler::put_chat_encrypt_files)
        .service(handler::put_meeting_alert_minutes)
        .service(handler::save_public_key)
        .service(wake::wake_user_accounts)
        .service(rehydrate::rehydrate_account);
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
        )
        // Cloud Pub/Sub push for Gmail `users.watch`. Public: the handler
        // verifies the shared `?token=` secret itself.
        .route(
            "/gmail/push",
            web::post().to(gmail_push::gmail_push_endpoint),
        );
}
