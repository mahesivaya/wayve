//! One aggregate "what is actually connected" endpoint for the caller.
//!
//! The sidebar's Integrations group lists only live connections, and it renders
//! on every page. Asking each integration's own `/connection` endpoint would be
//! six or seven round trips per page load — several of which 403 for accounts
//! that aren't eligible — so this answers the whole question in a single query.
//!
//! It reports connection state only; every integration still gates its own
//! endpoints. A service missing from the list means "not connected", never
//! "not permitted".

use crate::prelude::*;
use tracing::instrument;
use wayve_security::jwt::get_user_id_from_request;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_status);
}

#[derive(serde::Serialize)]
struct IntegrationStatus {
    /// Catalog keys, matching `frontend/src/integrations/catalog.tsx`.
    connected: Vec<String>,
}

/// "Connected" means a stored connection that is also enabled — a disabled row
/// is set up but not active, and the sidebar shouldn't advertise it as working.
/// Gmail, GitHub and Figma have no enabled flag: the row's existence is the
/// connection.
#[get("/integrations/status")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_status(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = get_user_id_from_request(&req).ok_or(AppError::Unauthorized)?;

    let row = sqlx::query(
        "SELECT
            EXISTS(SELECT 1 FROM email_accounts WHERE user_id = $1) AS gmail,
            EXISTS(SELECT 1 FROM github_accounts WHERE user_id = $1) AS github,
            EXISTS(SELECT 1 FROM figma_accounts WHERE user_id = $1) AS figma,
            EXISTS(
                SELECT 1 FROM user_jira_connections WHERE user_id = $1 AND enabled
            ) AS jira,
            EXISTS(
                SELECT 1 FROM user_gitlab_connections WHERE user_id = $1 AND enabled
            ) AS gitlab,
            EXISTS(
                SELECT 1 FROM slack_connections c
                  JOIN users u ON u.organization_id = c.organization_id
                 WHERE u.id = $1 AND c.enabled
            ) AS slack,
            EXISTS(
                SELECT 1 FROM mcp_connections m JOIN users u ON u.id = $1
                 WHERE m.enabled
                   AND (
                        (m.owner_scope = 'organization'
                         AND m.organization_id = u.organization_id)
                     OR (m.owner_scope = 'platform'
                         AND u.account_type = 'platform_admin')
                   )
            ) AS mcp",
    )
    .bind(user_id)
    .fetch_one(pool.get_ref())
    .await?;

    let connected = ["gmail", "github", "figma", "jira", "gitlab", "slack", "mcp"]
        .into_iter()
        .filter(|key| row.try_get::<bool, _>(*key).unwrap_or(false))
        .map(str::to_string)
        .collect();

    Ok(HttpResponse::Ok().json(IntegrationStatus { connected }))
}
