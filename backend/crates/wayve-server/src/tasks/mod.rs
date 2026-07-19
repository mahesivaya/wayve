pub mod attachments;
pub mod handler;
pub mod statuses;
pub mod suggest;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    // `reorder` must register before `{id}`, or Actix matches the literal
    // against the parameterised route and fails to parse "reorder" as an i32.
    cfg.service(statuses::reorder_statuses)
        .service(statuses::list_statuses)
        .service(statuses::create_status)
        .service(statuses::update_status)
        .service(statuses::delete_status)
        .service(handler::assignable_users)
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
