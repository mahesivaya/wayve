pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::list_projects)
        .service(handler::create_project)
        .service(handler::update_project)
        .service(handler::delete_project)
        .service(handler::list_teams)
        .service(handler::get_team)
        .service(handler::create_team);
}
