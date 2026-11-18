pub mod agent;
pub mod config_handler;
pub mod email_assist;
pub mod handler;
pub mod native_tools;
pub mod pause;
pub mod provider;
pub mod usage_handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::ai_chat);
    cfg.service(handler::get_ai_provider);
    cfg.service(email_assist::email_assist);
    config_handler::routes(cfg);
    usage_handler::routes(cfg);
    pause::routes(cfg);
}
