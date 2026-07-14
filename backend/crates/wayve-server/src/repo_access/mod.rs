//! Per-repo access management: who can access a repo, at what level, and the
//! admin controls to add or remove members.
//!
//! The model is hybrid. GitHub is authoritative for the read/write level, read
//! live from the collaborator API, while Wayve's `member_project_access` decides
//! whether the repo appears in a member's Code Repo dashboard. Adding a member
//! grants Wayve visibility and best-effort-syncs a GitHub collaborator, which
//! only succeeds when our token has admin on the repo. `github_proxy` is the
//! enforcement side.

pub mod github;
pub mod handler;

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}
