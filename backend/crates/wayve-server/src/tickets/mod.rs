pub mod handler;
pub mod recall;
pub mod relate;
pub mod triage;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::count_open_tickets)
        .service(handler::find_related_tickets)
        .service(handler::ai_fix_ticket)
        .service(handler::record_resolution)
        .service(handler::list_tickets)
        .service(handler::create_ticket)
        .service(handler::update_ticket)
        .service(handler::delete_ticket);
}
