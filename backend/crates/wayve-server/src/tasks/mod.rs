pub mod attachments;
pub mod handler;
pub mod suggest;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::assignable_users)
        .service(handler::list_tasks)
        .service(handler::create_task)
        .service(handler::update_task)
        .service(handler::delete_task)
        .service(attachments::upload_attachments)
        .service(attachments::list_attachments)
        .service(attachments::download_attachment)
        .service(attachments::delete_attachment);
    suggest::routes(cfg);
}
