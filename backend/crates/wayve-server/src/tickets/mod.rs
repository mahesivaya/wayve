pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::count_open_tickets)
        .service(handler::list_tickets)
        .service(handler::create_ticket)
        .service(handler::update_ticket)
        .service(handler::delete_ticket);
}
