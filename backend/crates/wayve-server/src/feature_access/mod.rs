pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::get_feature_access)
        .service(handler::update_feature_access);
}
