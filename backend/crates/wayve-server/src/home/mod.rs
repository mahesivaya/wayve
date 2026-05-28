pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::home_today)
        .service(handler::home_inbox)
        .service(handler::home_tasks)
        .service(handler::home_recent)
        .service(handler::home_summary);
}
