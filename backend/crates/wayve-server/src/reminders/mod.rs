pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::list_reminders)
        .service(handler::create_reminder)
        .service(handler::delete_reminder);
}
