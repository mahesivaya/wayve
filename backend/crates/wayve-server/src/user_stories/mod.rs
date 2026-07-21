pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::list_user_stories)
        .service(handler::create_user_story)
        .service(handler::update_user_story)
        .service(handler::delete_user_story);
}
