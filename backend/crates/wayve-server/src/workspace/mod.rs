pub mod handler;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handler::list_projects)
        .service(handler::create_project)
        .service(handler::update_project)
        .service(handler::link_project_repo)
        .service(handler::delete_project)
        .service(handler::list_teams)
        .service(handler::get_team)
        .service(handler::create_team)
        .service(handler::delete_team)
        .service(handler::add_team_member)
        .service(handler::remove_team_member);
}
