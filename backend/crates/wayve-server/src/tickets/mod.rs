pub mod attachments;
pub mod handler;
pub mod recall;
pub mod relate;
pub mod triage;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(attachments::upload_attachments)
        .service(attachments::list_attachments)
        .service(attachments::download_attachment)
        .service(attachments::delete_attachment)
        .service(handler::count_open_tickets)
        .service(handler::find_related_tickets)
        .service(handler::ai_fix_ticket)
        .service(handler::get_ai_fix_state)
        .service(handler::record_ai_fix_diff)
        .service(handler::edit_ai_fix)
        .service(handler::commit_ai_fix)
        .service(handler::push_ai_fix)
        .service(handler::open_ai_fix_pr)
        .service(handler::pr_notify)
        .service(handler::record_resolution)
        .service(handler::list_tickets)
        .service(handler::create_ticket)
        .service(handler::update_ticket)
        .service(handler::delete_ticket);
}
