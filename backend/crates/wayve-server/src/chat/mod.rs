mod attachments;
mod channel_create;
mod channel_join;
mod channel_members;
mod channel_messages;
mod channel_queries;
mod channel_settings;
mod channels;
mod direct_messages;
mod dto;
pub mod handler;
mod helpers;
pub mod presence;
pub mod pubsub;
pub mod reactions;
mod websocket;
// Re-exported so other features, such as the Slack Events webhook, can push a
// freshly stored channel message to open clients.
pub(crate) use websocket::fan_out_user;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    // Direct messages: canonical /api/chat/direct-messages, legacy /api/messages.
    cfg.route(
        "/chat/direct-messages",
        web::get().to(handler::get_messages),
    )
    .route("/messages", web::get().to(handler::get_messages))
    .route(
        "/chat/conversations",
        web::get().to(handler::get_conversation_summary),
    )
    .route("/chat/presence", web::get().to(presence::get_presence))
    .route("/chat/presence/status", web::put().to(presence::set_status))
    .service(handler::get_channels)
    .service(handler::create_channel)
    .service(handler::update_channel_subject)
    .service(handler::update_channel_visibility)
    .service(handler::join_channel)
    .service(handler::approve_channel_join_request)
    .service(handler::add_channel_users)
    .service(handler::remove_channel_user)
    .service(handler::get_channel_messages)
    .service(handler::get_channel_thread)
    .service(attachments::upload_chat_attachment)
    .service(attachments::download_chat_attachment);
}

pub fn ws_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/ws/chat", web::get().to(handler::chat_ws));
}
