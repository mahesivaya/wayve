//! Organization-scoped endpoints that don't belong to an existing feature
//! module: the master-key handlers, admin-read-as-member, and custom domains.

pub mod domains;
pub mod impersonate;
pub mod keys;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(domains::list_domains)
        .service(domains::claim_domain)
        .service(domains::verify_domain)
        .service(domains::verify_domain_ownership)
        .service(domains::delete_domain)
        .service(domains::get_domain_policy)
        .service(domains::set_domain_policy)
        .service(keys::bootstrap_keys)
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
