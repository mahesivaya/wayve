pub mod github;

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    github::routes(cfg);
}
