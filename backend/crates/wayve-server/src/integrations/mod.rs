pub mod github;
pub mod gitlab;
pub mod jira;
pub mod mcp;
pub mod slack;
pub mod status;

/// Authenticated, `/api`-scoped integration endpoints.
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    github::routes(cfg);
    gitlab::routes(cfg);
    jira::routes(cfg);
    mcp::routes(cfg);
    slack::routes(cfg);
    status::routes(cfg);
}

/// Unauthenticated, root-mounted integration receivers (e.g. the Jira webhook),
/// secured by their own per-integration scheme rather than the session JWT.
pub fn public_routes(cfg: &mut actix_web::web::ServiceConfig) {
    jira::public_routes(cfg);
    slack::public_routes(cfg);
}
