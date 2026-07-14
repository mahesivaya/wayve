//! MCP (Model Context Protocol) connections. An enterprise org or platform admin
//! registers their own remote MCP server, and the AI assistant then discovers and
//! calls that server's tools. Fluxze only ever speaks MCP to a server the customer
//! runs and controls; it never connects to their data store directly.

pub mod client;
pub mod handler;
pub mod models;

/// Authenticated `/api` endpoints, all owner- and tier-gated in the handler.
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}
