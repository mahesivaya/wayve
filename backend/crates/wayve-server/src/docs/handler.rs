// Markdown is baked into the binary via `include_str!()` rather than read
// from disk at runtime. Two reasons:
//   1. The `documentation/` directory isn't mounted into the backend
//      container — embedding ships the content with every release.
//   2. The catalog is the only published list. Path traversal cannot
//      reach scratchpad notes because none of them are in the binary.

use crate::prelude::*;
use once_cell::sync::Lazy;
use tracing::instrument;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(list_docs).service(get_doc);
}

#[derive(Clone, Copy)]
struct Doc {
    slug: &'static str,
    title: &'static str,
    description: &'static str,
    body: &'static str,
}

static CATALOG: Lazy<Vec<Doc>> = Lazy::new(|| {
    vec![
        // Listed first so /docs/:slug (which lands on the first catalog
        // entry) opens on the welcome guide rather than the pricing table.
        Doc {
            slug: "getting-started",
            title: "Getting started with Wayve",
            description:
                "The fast path from a new account to a working integration — product surfaces, accounts & roles, the API, webhooks, plans, and the security model.",
            body: include_str!("getting_started.md"),
        },
        Doc {
            slug: "price-tier",
            title: "Price Tiers & Event Producers",
            description:
                "Rate-limit tiers (Free / Advance / Organization / Enterprise) and the full webhook event catalog with payload shapes.",
            body: include_str!("price_tier.md"),
        },
    ]
});

#[get("/docs")]
#[instrument(target = "http")]
pub async fn list_docs() -> AppResult {
    let items: Vec<_> = CATALOG
        .iter()
        .map(|d| {
            serde_json::json!({
                "slug": d.slug,
                "title": d.title,
                "description": d.description,
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

#[get("/docs/{slug}")]
#[instrument(target = "http", skip(path))]
pub async fn get_doc(path: web::Path<String>) -> AppResult {
    let slug = path.into_inner();
    let doc = CATALOG
        .iter()
        .find(|d| d.slug == slug)
        .ok_or(AppError::NotFound("doc"))?;
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "slug": doc.slug,
        "title": doc.title,
        "description": doc.description,
        "body": doc.body,
    })))
}
