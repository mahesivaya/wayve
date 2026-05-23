pub mod account;
pub mod api_keys;
pub mod audit;
pub mod auth;
pub mod config;
pub mod email;
pub mod health;
pub mod recovery;
pub mod shared_inbox;
pub mod sso;
pub mod user;

use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(health::health)
        .service(health::ready)
        .service(config::public_config)
        .service(auth::register)
        .service(auth::login)
        .service(auth::logout)
        .service(auth::forgot_password)
        .service(auth::reset_password)
        .service(auth::recover_with_mnemonic)
        .service(user::change_password)
        .service(user::admin_list_organizations)
        .service(user::admin_create_organization)
        .service(user::admin_create_user)
        .service(user::admin_delete_user)
        .service(user::admin_generate_api_key)
        .service(user::admin_list_api_keys)
        .service(user::admin_revoke_api_key)
        .service(user::api_key_whoami)
        .service(user::list_organization_members)
        .service(user::update_organization_member_role)
        .service(user::list_platform_members)
        .service(user::update_platform_member_role)
        .service(api_keys::create_api_key)
        .service(api_keys::list_api_keys)
        .service(api_keys::revoke_api_key)
        .service(api_keys::api_key_audit)
        .service(audit::list_audit_logs)
        .service(audit::get_siem_settings)
        .service(audit::upsert_siem_settings)
        .service(audit::test_siem_settings)
        .service(account::get_accounts)
        .service(account::update_account_display_name)
        .service(user::get_user_by_email)
        .service(user::get_all_users)
        .service(user::get_profile)
        .service(user::update_profile)
        .service(account::delete_account)
        .service(sso::get_sso_config)
        .service(sso::upsert_sso_config)
        .service(sso::delete_sso_config)
        .service(sso::test_sso_config)
        .service(sso::auth_sso_start)
        .service(sso::auth_sso_callback)
        .service(shared_inbox::list_shared_inboxes)
        .service(shared_inbox::create_shared_inbox)
        .service(shared_inbox::update_shared_inbox)
        .service(shared_inbox::delete_shared_inbox)
        .service(shared_inbox::list_inbox_members)
        .service(shared_inbox::add_inbox_member)
        .service(shared_inbox::remove_inbox_member)
        .service(shared_inbox::update_email_state)
        .service(recovery::get_wrapped_key)
        .service(recovery::put_wrapped_key)
        .service(recovery::delete_wrapped_key)
        .service(recovery::get_basic_key)
        .service(recovery::put_basic_key);
}
