//! MCP (Model Context Protocol) connections. An **enterprise** org owner/admin
//! or a **platform** owner/admin registers their own remote MCP server (a single
//! Streamable-HTTP endpoint + optional bearer token); the AI assistant then
//! discovers and calls that server's tools — e.g. to read the customer's own
//! database. Fluxze only ever speaks MCP to a server the customer runs and
//! controls; it never connects to their data store directly.
//!
//! `client` is the SSRF-guarded JSON-RPC client, `handler` the CRUD + the
//! owner/tier gate, `models` the shared types. The agent loop in
//! `crate::ai::agent` reuses `handler::resolve_mcp_owner_opt` +
//! `handler::load_connections` and `client::McpClient`.

pub mod client;
pub mod handler;
pub mod models;

/// Authenticated, `/api`-scoped endpoints (all owner/tier-gated in the handler).
pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}
