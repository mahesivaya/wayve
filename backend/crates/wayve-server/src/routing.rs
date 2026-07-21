//! HTTP route wiring.
//!
//! Every feature exposes a `routes()` (plus `public_routes()` / `ws_routes()`
//! where relevant) and is wired in here, so `main.rs` stays a thin orchestrator
//! and there is one place to look for the API surface.
//!
//! Uploaded files are deliberately NOT served statically from `/uploads`; they go
//! through the authenticated, ownership-checked `GET /api/files/{id}/download`.

use actix_web::web;

use crate::{
    ai, billing, call, chat, demo, docs, documents, drive, email, embed, feature_access,
    github_oauth, github_proxy, home, integrations, notes, openapi, organization, platform_billing,
    platform_team, platform_ui, reminders, repo_access, routes, scheduler, scim, tasks, tickets,
    user_stories, webhooks, workspace,
};

pub fn wire(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api")
            .configure(routes::routes)
            .configure(email::routes)
            .configure(chat::routes)
            .configure(scheduler::routes)
            .configure(drive::routes)
            .configure(home::routes)
            .configure(notes::routes)
            .configure(reminders::routes)
            .configure(organization::routes)
            .configure(tasks::routes)
            .configure(user_stories::routes)
            .configure(tickets::routes)
            .configure(call::api_routes)
            .configure(ai::routes)
            .configure(billing::routes)
            .configure(platform_billing::routes)
            .configure(platform_team::routes)
            .configure(platform_ui::routes)
            .configure(integrations::routes)
            .configure(github_proxy::routes)
            .configure(repo_access::routes)
            .configure(github_oauth::routes)
            .configure(openapi::routes)
            .configure(webhooks::routes)
            .configure(docs::routes)
            .configure(embed::routes)
            .configure(workspace::routes)
            .configure(feature_access::routes)
            .configure(documents::routes)
            .configure(demo::routes)
            .configure(scim::api_routes),
    )
    // The root-mounted, unauthenticated surfaces below each verify their own
    // caller: the Stripe webhook by signature, the Jira webhook by URL token.
    .configure(email::public_routes)
    .configure(github_oauth::public_routes)
    .configure(billing::public_routes)
    .configure(integrations::public_routes)
    // SCIM 2.0 mounts at /scim/v2 per RFC 7644, not under /api, and
    // authenticates with its own bearer token rather than the session JWT.
    .configure(scim::routes)
    .configure(chat::ws_routes)
    .configure(call::routes);
}
