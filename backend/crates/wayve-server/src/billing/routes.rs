// Route registration for the billing module. `routes` is mounted under the
// authenticated `/api` scope; `public_routes` carries the unauthenticated
// Stripe webhook and is mounted at the root.

use super::{
    checkout, entitlements, invoices, organization_billing, plans, subscriptions, tiers,
    usage_metering, webhook_handler,
};
use actix_web::web;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(plans::list_plans)
        .service(plans::admin_list_plans)
        .service(plans::admin_create_plan)
        .service(plans::admin_deactivate_plan)
        .service(checkout::create_checkout)
        .service(checkout::create_inline_subscription)
        .service(checkout::create_portal)
        .service(checkout::create_payment_method_setup_intent)
        .service(checkout::set_default_payment_method)
        .service(checkout::stripe_status)
        .service(subscriptions::get_subscription)
        .service(subscriptions::cancel_subscription)
        .service(subscriptions::admin_list_subscriptions)
        .service(invoices::list_invoices)
        .service(entitlements::get_entitlements)
        .service(usage_metering::record_usage)
        .service(usage_metering::get_usage)
        .service(organization_billing::get_organization_billing)
        .service(tiers::list_tiers)
        .service(tiers::get_quota);
}

pub fn public_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(webhook_handler::stripe_webhook);
}
