//! HTTP route wiring.
//!
//! All `web::scope("/api")` services and the root-mounted handlers (Gmail
//! OAuth, Stripe webhook, SCIM, WebSockets) are configured from a single
//! function so `main.rs` stays a thin orchestrator.
//!
//! Uploaded files are deliberately NOT served statically from `/uploads`.
//! They are delivered via the authenticated, ownership-checked route
//! `GET /api/files/{id}/download` (see `drive::handler::download_file`).

use actix_web::web;

use crate::{
    ai, billing, call, chat, docs, documents, drive, email, embed, feature_access, github_proxy,
    home, integrations, notes, openapi, organization, platform_billing, platform_team, routes,
    scheduler, scim, tasks, webhooks, workspace,
};

pub fn wire(cfg: &mut web::ServiceConfig) {
    cfg
        // GROUP API ROUTES
        .service(
            web::scope("/api")
                .configure(routes::routes)
                .configure(email::routes)
                .configure(chat::routes)
                .configure(scheduler::routes)
                .configure(drive::routes)
                .configure(home::routes)
                .configure(notes::routes)
                .configure(organization::routes)
                .configure(tasks::routes)
                .configure(call::api_routes)
                .configure(ai::routes)
                .configure(billing::routes)
                .configure(platform_billing::routes)
                .configure(platform_team::routes)
                .configure(integrations::routes)
                .configure(github_proxy::routes)
                .configure(openapi::routes)
                .configure(webhooks::routes)
                .configure(docs::routes)
                .configure(embed::routes)
                .configure(workspace::routes)
                .configure(feature_access::routes)
                .configure(documents::routes)
                .configure(scim::api_routes),
        )
        // AUTH / GOOGLE
        .configure(email::public_routes)
        // STRIPE WEBHOOK (unauthenticated, signature-verified)
        .configure(billing::public_routes)
        // SCIM 2.0 — mounted at /scim/v2 per RFC 7644 (NOT under /api).
        // Authenticates with its own bearer token, not the session JWT.
        .configure(scim::routes)
        // WEBSOCKETS
        .configure(chat::ws_routes)
        .configure(call::routes);
}
