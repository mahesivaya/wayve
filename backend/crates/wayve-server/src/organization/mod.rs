//! Organization-scoped endpoints that don't fit into an existing feature
//! module. Currently houses the master-key handler set (bootstrap, fetch
//! per-caller wraps, fetch member escrow for recovery/reset, add a new
//! key-holder, read audit log).
//!
//! Wired into `/api` from `main.rs::app_routes` via `organization::routes`.

pub mod impersonate;
pub mod keys;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(keys::bootstrap_keys)
        .service(keys::get_keys)
        .service(keys::get_member_escrow)
        .service(keys::add_key_holder_wrap)
        .service(keys::read_audit_log)
        .service(keys::reset_member_password)
        .service(keys::list_member_notes)
        .service(impersonate::list_member_emails)
        .service(impersonate::list_member_messages)
        .service(impersonate::list_member_channel_messages)
        .service(impersonate::list_member_files)
        .service(impersonate::list_member_tasks)
        .service(impersonate::list_member_meetings);
}
