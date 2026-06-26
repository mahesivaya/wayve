pub mod agent;
pub mod config_handler;
pub mod handler;
pub mod provider;
pub mod usage_handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::ai_chat);
    config_handler::routes(cfg);
    usage_handler::routes(cfg);
}
