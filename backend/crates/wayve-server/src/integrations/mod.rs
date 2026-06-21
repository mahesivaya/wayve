pub mod github;
pub mod gitlab;
pub mod jira;
pub mod slack;

/// Authenticated, `/api`-scoped integration endpoints.
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    github::routes(cfg);
    gitlab::routes(cfg);
    jira::routes(cfg);
    slack::routes(cfg);
}

/// Unauthenticated, root-mounted integration receivers (e.g. the Jira webhook),
/// secured by their own per-integration scheme rather than the session JWT.
pub fn public_routes(cfg: &mut actix_web::web::ServiceConfig) {
    jira::public_routes(cfg);
}
