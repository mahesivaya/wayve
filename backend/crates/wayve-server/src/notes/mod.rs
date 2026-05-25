pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::list_notes)
        .service(handler::create_note)
        .service(handler::update_note)
        .service(handler::delete_note);
}
