//! Per-repo access management: for one repo, show who can access it and at what
//! level, and let an admin add/remove members.
//!
//! **Hybrid model** — GitHub is authoritative for the read/write *level* (read
//! live from the collaborator API); Wayve's `member_project_access` controls
//! whether the repo shows in a member's Code Repo dashboard. Adding a member
//! grants Wayve visibility and best-effort-syncs a GitHub collaborator (when our
//! token has admin on the repo). See docs/architecture/ai-task-assignment.md's
//! sibling design and `github_proxy` for the enforcement side.

pub mod github;
pub mod handler;

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    handler::routes(cfg);
}
