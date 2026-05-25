pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::list_tasks)
        .service(handler::create_task)
        .service(handler::update_task)
        .service(handler::delete_task);
}
